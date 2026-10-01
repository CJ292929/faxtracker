#!/usr/bin/env node
// Live verification of public.correct_fax_attempt against the real database
// for P3-P6. Everything here runs inside one Postgres transaction on
// synthetic uuids that is always ROLLBACK'd at the end (via the
// __discard_test_transaction__ sentinel below) -- nothing here is ever
// committed, so it never touches real patients/documents/attempts.
//
// Covers: staff/admin success (atomic with fax_attempt_corrections +
// audit_logs), attempt_number/document_id/created_by/created_at preserved,
// attempt row count for the document unchanged, role-less/staff-excluded*/
// unauthenticated direct-call denial, missing-reason and
// Failed-without-failure-reason validation, stale _expected_updated_at
// conflict, and an audit-insert-failure rollback.
// (*"staff-excluded" here means a role-less account; staff IS allowed to
// correct attempts, same as staff can add them.)
//
// Requires SUPABASE_DB_MIGRATION_URL in .env.
// Run with: node scripts/test-correct-attempt-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

async function run() {
  const sql = postgres(env.SUPABASE_DB_MIGRATION_URL);

  const adminId = "b0000000-0000-0000-0000-0000000000a1";
  const staffId = "b0000000-0000-0000-0000-0000000000a2";
  const ghostId = "b0000000-0000-0000-0000-0000000000a3";
  const patientId = "b0000000-0000-0000-0000-0000000000b1";
  const documentId = "b0000000-0000-0000-0000-0000000000c1";
  const attemptId = "b0000000-0000-0000-0000-0000000000d1";
  const attempt2Id = "b0000000-0000-0000-0000-0000000000d2";

  await sql
    .begin(async (tx) => {
      await tx`delete from public.user_roles where user_id = any(${[adminId, staffId, ghostId]})`;
      await tx`insert into public.user_roles (user_id, role) values (${adminId}, 'admin'), (${staffId}, 'staff')`;

      await tx`insert into public.patients (id, first_name, last_name, patient_id) values (${patientId}, 'P3P6', 'Synthetic', 'P3P6-TEST')`;
      await tx`insert into public.documents (id, patient_id, document_type) values (${documentId}, ${patientId}, 'Initial Evaluation')`;
      await tx`insert into public.fax_attempts (id, document_id, attempt_number, status, created_by) values (${attemptId}, ${documentId}, 1, 'Pending', ${adminId})`;
      await tx`insert into public.fax_attempts (id, document_id, attempt_number, status, created_by) values (${attempt2Id}, ${documentId}, 2, 'Pending', ${adminId})`;

      const asUser = (id) =>
        tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id })}, true)`;

      let spCounter = 0;
      async function expectError(fn) {
        const name = `sp_${spCounter++}`;
        await tx.unsafe(`savepoint ${name}`);
        let message = null;
        try {
          await fn();
        } catch (e) {
          message = e.message;
        } finally {
          await tx.unsafe(`rollback to savepoint ${name}`);
        }
        return message;
      }

      // sql.typed(value, 25) forces plain-text (OID 25) parameter encoding.
      // Without it, postgres.js detects timestamp-shaped strings and
      // re-serializes them through its own Date formatter, which only
      // carries millisecond precision -- silently truncating the stored
      // microsecond value and making an unmodified resubmission look stale.
      const call = (id, args) =>
        tx`select * from public.correct_fax_attempt(
          ${id}, ${sql.typed(args.expectedUpdatedAt, 25)}::timestamptz, ${args.attemptedAt ?? new Date().toISOString()},
          ${args.status}, ${args.failureReason ?? null}, ${args.confirmationNumber ?? null},
          ${args.notes ?? null}, ${args.reason}
        )`;

      // updated_at is cast to text everywhere it will be resubmitted as
      // _expected_updated_at: postgres.js parses timestamptz columns into JS
      // Date objects (millisecond precision), and re-serializing a Date
      // loses the column's microsecond precision, which would make a
      // same-value resubmission look "stale" against IS DISTINCT FROM.
      const [origBefore] =
        await tx`select updated_at::text as updated_at, created_at, created_by, attempt_number from public.fax_attempts where id = ${attemptId}`;
      const [countBefore] =
        await tx`select count(*)::int as n from public.fax_attempts where document_id = ${documentId}`;

      // T1: admin success, atomic with fax_attempt_corrections + audit_logs.
      await asUser(adminId);
      const [correctionsBefore] =
        await tx`select count(*)::int as n from public.fax_attempt_corrections`;
      const [auditBefore] = await tx`select count(*)::int as n from public.audit_logs`;
      const rows = await call(attemptId, {
        expectedUpdatedAt: origBefore.updated_at,
        status: "Sent Successfully",
        confirmationNumber: "REF-ADMIN",
        reason: "Admin correcting a mis-recorded status",
      });
      check(
        "T1 admin correction: function returns updated row",
        rows[0]?.status === "Sent Successfully",
      );
      const [afterT1] =
        await tx`select *, updated_at::text as updated_at_text from public.fax_attempts where id = ${attemptId}`;
      check("T1 admin correction: status actually updated", afterT1.status === "Sent Successfully");
      check(
        "T1 admin correction: attempt_number/document_id/created_by/created_at preserved",
        afterT1.attempt_number === origBefore.attempt_number &&
          afterT1.document_id === documentId &&
          afterT1.created_by === origBefore.created_by &&
          new Date(afterT1.created_at).getTime() === new Date(origBefore.created_at).getTime(),
      );
      check(
        "T1 admin correction: updated_at bumped (concurrency token changed)",
        new Date(afterT1.updated_at).getTime() > new Date(origBefore.updated_at).getTime(),
      );
      const [correctionsAfterT1] =
        await tx`select count(*)::int as n from public.fax_attempt_corrections`;
      const [auditAfterT1] = await tx`select count(*)::int as n from public.audit_logs`;
      check(
        "T1 admin correction: exactly one correction row written",
        correctionsAfterT1.n === correctionsBefore.n + 1,
      );
      check(
        "T1 admin correction: exactly one audit row written",
        auditAfterT1.n === auditBefore.n + 1,
      );
      const [corrRow] =
        await tx`select corrected_by, reason, before, after from public.fax_attempt_corrections order by corrected_at desc limit 1`;
      check(
        "T1 correction row records corrector, reason, before/after status",
        corrRow.corrected_by === adminId &&
          corrRow.reason === "Admin correcting a mis-recorded status" &&
          corrRow.before.status === "Pending" &&
          corrRow.after.status === "Sent Successfully",
      );
      // Filtered by document_id/action, not "order by created_at desc limit
      // 1": audit_logs.created_at defaults to now() (transaction start
      // time), so every row inserted during this one test transaction can
      // share an identical timestamp, making a global "latest" ambiguous.
      const [auditRow] =
        await tx`select action, user_id, document_id from public.audit_logs where document_id = ${documentId} and action = 'fax_attempt_corrected'`;
      check(
        "T1 audit row: actor, action, document scoped correctly",
        auditRow.action === "fax_attempt_corrected" &&
          auditRow.user_id === adminId &&
          auditRow.document_id === documentId,
      );
      const [countAfterT1] =
        await tx`select count(*)::int as n from public.fax_attempts where document_id = ${documentId}`;
      check(
        "T1 correction did not change the attempt count for the document",
        countAfterT1.n === countBefore.n,
      );

      // T2: staff success on the second synthetic attempt (staff, like admin, can correct).
      await asUser(staffId);
      const [attempt2Before] =
        await tx`select updated_at::text as updated_at from public.fax_attempts where id = ${attempt2Id}`;
      const rowsT2 = await call(attempt2Id, {
        expectedUpdatedAt: attempt2Before.updated_at,
        status: "Failed",
        failureReason: "Busy",
        reason: "Staff correcting failure reason",
      });
      check(
        "T2 staff correction succeeds",
        rowsT2[0]?.status === "Failed" && rowsT2[0]?.failure_reason === "Busy",
      );

      // T3: role-less caller denied (authenticated, no user_roles row).
      await asUser(ghostId);
      const ghostError = await expectError(() =>
        call(attemptId, {
          expectedUpdatedAt: afterT1.updated_at_text,
          status: "Cancelled",
          reason: "should be denied",
        }),
      );
      check("T3 role-less caller rejected", /FORBIDDEN/.test(ghostError ?? ""));

      // T4: unauthenticated caller (auth.uid() IS NULL) denied.
      await tx`select set_config('request.jwt.claims', '', true)`;
      const anonError = await expectError(() =>
        call(attemptId, {
          expectedUpdatedAt: afterT1.updated_at_text,
          status: "Cancelled",
          reason: "should be denied",
        }),
      );
      check("T4 unauthenticated caller rejected", /FORBIDDEN/.test(anonError ?? ""));

      // T5: missing correction reason rejected.
      await asUser(adminId);
      const reasonError = await expectError(() =>
        call(attemptId, {
          expectedUpdatedAt: afterT1.updated_at_text,
          status: "Cancelled",
          reason: "  ",
        }),
      );
      check("T5 blank reason rejected", /REASON_REQUIRED/.test(reasonError ?? ""));

      // T6: Failed status without a failure reason rejected (DB-side backstop).
      const failureReasonError = await expectError(() =>
        call(attemptId, {
          expectedUpdatedAt: afterT1.updated_at_text,
          status: "Failed",
          reason: "no failure reason given",
        }),
      );
      check(
        "T6 Failed without failure_reason rejected",
        /FAILURE_REASON_REQUIRED/.test(failureReasonError ?? ""),
      );

      // T7: stale _expected_updated_at rejected (someone else corrected it since it was loaded).
      const staleError = await expectError(() =>
        call(attemptId, {
          expectedUpdatedAt: origBefore.updated_at,
          status: "Cancelled",
          reason: "stale form resubmit",
        }),
      );
      check("T7 stale expected_updated_at rejected as CONFLICT", /CONFLICT/.test(staleError ?? ""));
      const [afterT7] = await tx`select status from public.fax_attempts where id = ${attemptId}`;
      check(
        "T7 stale conflict did not overwrite the current value",
        afterT7.status === "Sent Successfully",
      );

      // T8: audit-insert failure rolls back the attempt update, in the same call.
      const rollbackError = await expectError(async () => {
        // NOT VALID: skip validating existing rows (T1's own audit row, and
        // real history, already have action = 'fax_attempt_corrected') and
        // only enforce the constraint going forward, which is all this needs.
        await tx`alter table public.audit_logs add constraint tmp_break_fax_audit check (action <> 'fax_attempt_corrected') not valid`;
        await call(attemptId, {
          expectedUpdatedAt: afterT1.updated_at_text,
          status: "Cancelled",
          reason: "should roll back",
        });
      });
      check("T8 audit-insert failure surfaces as an error", rollbackError !== null);
      const [afterT8] =
        await tx`select status, updated_at from public.fax_attempts where id = ${attemptId}`;
      check(
        "T8 attempt update rolled back with the failed audit insert",
        afterT8.status === "Sent Successfully" &&
          new Date(afterT8.updated_at).getTime() === new Date(afterT1.updated_at).getTime(),
      );
      const [correctionsAfterT8] =
        await tx`select count(*)::int as n from public.fax_attempt_corrections`;
      check(
        "T8 correction-history insert rolled back too",
        correctionsAfterT8.n === correctionsAfterT1.n + 1, // +1 only for T2's real success
      );

      // Final sanity: attempt count for the document is still unchanged after every case above.
      const [countFinal] =
        await tx`select count(*)::int as n from public.fax_attempts where document_id = ${documentId}`;
      check(
        "Final: attempt count for the document unchanged across all cases",
        countFinal.n === countBefore.n,
      );

      // Never commit: this whole transaction touched only synthetic rows.
      throw new Error("__discard_test_transaction__");
    })
    .catch((e) => {
      if (e.message !== "__discard_test_transaction__") throw e;
    });

  await sql.end();

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nAll live correct-attempt checks passed. Real data was not touched (transaction rolled back).",
  );
}

await run();
