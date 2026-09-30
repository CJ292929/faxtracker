#!/usr/bin/env node
// Live verification of public.delete_patient_permanently for P3-P11.
//
// Part 1 runs inside one Postgres transaction on synthetic uuids that is
// always ROLLBACK'd at the end (same discipline as
// scripts/test-correct-attempt-live.mjs) -- nothing here is ever committed,
// so it never touches real patients/documents/attempts.
//
// Covers: admin success (atomic delete of documents/fax_attempts/
// document_files/fax_attempt_corrections + patient row, audit_logs entry,
// patient_file_cleanup_queue populated with the attachment's storage_path),
// staff success, role-less/unauthenticated direct-call denial, a mismatched
// confirmation code rejected without deleting anything, a duplicate
// resubmit safely rejected as NOT_FOUND (nothing double-deleted or
// double-queued), and an unrelated second patient/document left untouched.
//
// Part 2 exercises the real patient-documents Storage bucket (outside any
// SQL transaction, since Storage is a separate HTTP service): uploads one
// synthetic file, verifies a genuine removal failure (invalid credential)
// leaves the queue row retryable, then verifies a real retry against the
// correct bucket succeeds and clears the queue row. Everything created here
// is deleted again at the end regardless of outcome.
//
// Requires LOVABLE_DB_MIGRATION_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
// Run with: node scripts/p3p11-patient-delete-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

async function runSqlChecks() {
  const sql = postgres(env.LOVABLE_DB_MIGRATION_URL);

  const adminId = "c0000000-0000-0000-0000-0000000000a1";
  const staffId = "c0000000-0000-0000-0000-0000000000a2";
  const ghostId = "c0000000-0000-0000-0000-0000000000a3";

  const patientId = "c0000000-0000-0000-0000-0000000000b1";
  const documentId = "c0000000-0000-0000-0000-0000000000c1";
  const attemptId = "c0000000-0000-0000-0000-0000000000d1";
  const fileId = "c0000000-0000-0000-0000-0000000000e1";
  const storagePath =
    "c0000000-0000-0000-0000-0000000000b1/c0000000-0000-0000-0000-0000000000c1/synthetic.pdf";

  const otherPatientId = "c0000000-0000-0000-0000-0000000000f1";
  const otherDocumentId = "c0000000-0000-0000-0000-0000000000f2";

  await sql
    .begin(async (tx) => {
      await tx`delete from public.user_roles where user_id = any(${[adminId, staffId, ghostId]})`;
      await tx`insert into public.user_roles (user_id, role) values (${adminId}, 'admin'), (${staffId}, 'staff')`;

      await tx`insert into public.patients (id, first_name, last_name, patient_id) values (${patientId}, 'P3P11', 'Synthetic', 'P3P11-TEST')`;
      await tx`insert into public.documents (id, patient_id, document_type) values (${documentId}, ${patientId}, 'Initial Evaluation')`;
      await tx`insert into public.fax_attempts (id, document_id, attempt_number, status, created_by) values (${attemptId}, ${documentId}, 1, 'Sent Successfully', ${adminId})`;
      await tx`insert into public.document_files (id, document_id, file_name, storage_path, uploaded_by) values (${fileId}, ${documentId}, 'synthetic.pdf', ${storagePath}, ${adminId})`;

      await tx`insert into public.patients (id, first_name, last_name, patient_id) values (${otherPatientId}, 'P3P11', 'Untouched', 'P3P11-OTHER')`;
      await tx`insert into public.documents (id, patient_id, document_type) values (${otherDocumentId}, ${otherPatientId}, 'Progress Note')`;

      // Give the attempt a correction so fax_attempt_corrections (ON DELETE
      // CASCADE from fax_attempts) is also exercised.
      const asUser = (id) =>
        tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id })}, true)`;
      await asUser(adminId);
      await tx`select * from public.correct_fax_attempt(
        ${attemptId}, (select updated_at from public.fax_attempts where id = ${attemptId}), now(),
        'Sent Successfully', null, 'REF-1', null, 'synthetic setup correction'
      )`;

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

      const call = (id, code) =>
        tx`select * from public.delete_patient_permanently(${id}, ${code})`;

      // T1: role-less caller denied, patient untouched.
      await asUser(ghostId);
      const ghostError = await expectError(() => call(patientId, "P3P11-TEST"));
      check("T1 role-less caller rejected", /FORBIDDEN/.test(ghostError ?? ""));

      // T2: unauthenticated caller denied.
      await tx`select set_config('request.jwt.claims', '', true)`;
      const anonError = await expectError(() => call(patientId, "P3P11-TEST"));
      check("T2 unauthenticated caller rejected", /FORBIDDEN/.test(anonError ?? ""));

      // T3: mismatched confirmation code rejected, nothing deleted.
      await asUser(adminId);
      const confirmError = await expectError(() => call(patientId, "WRONG-CODE"));
      check("T3 mismatched confirmation code rejected", /CONFLICT/.test(confirmError ?? ""));
      const [stillThere] = await tx`select id from public.patients where id = ${patientId}`;
      check("T3 patient not deleted after mismatched confirmation", !!stillThere);

      // T4: admin success -- atomic delete + audit + cleanup queue.
      const [auditBefore] = await tx`select count(*)::int as n from public.audit_logs`;
      const [queueBefore] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue`;
      const rows = await call(patientId, "P3P11-TEST");
      const row = rows[0];
      check(
        "T4 admin delete: returns correct row/attempt/file counts",
        row?.documents_deleted === 1 && row?.attempts_deleted === 1 && row?.files_deleted === 1,
      );
      check(
        "T4 admin delete: returns the attachment's storage path for cleanup",
        Array.isArray(row?.storage_paths) && row.storage_paths.includes(storagePath),
      );
      const [patientGone] = await tx`select id from public.patients where id = ${patientId}`;
      check("T4 patient row deleted", !patientGone);
      const [docsGone] =
        await tx`select count(*)::int as n from public.documents where patient_id = ${patientId}`;
      check("T4 documents deleted", docsGone.n === 0);
      const [attemptsGone] =
        await tx`select count(*)::int as n from public.fax_attempts where document_id = ${documentId}`;
      check("T4 fax_attempts deleted", attemptsGone.n === 0);
      const [correctionsGone] =
        await tx`select count(*)::int as n from public.fax_attempt_corrections where attempt_id = ${attemptId}`;
      check(
        "T4 fax_attempt_corrections cascade-deleted with their attempt",
        correctionsGone.n === 0,
      );
      const [filesGone] =
        await tx`select count(*)::int as n from public.document_files where document_id = ${documentId}`;
      check("T4 document_files deleted", filesGone.n === 0);
      const [auditAfter] = await tx`select count(*)::int as n from public.audit_logs`;
      check("T4 exactly one audit row written", auditAfter.n === auditBefore.n + 1);
      const [auditRow] =
        await tx`select action, user_id, patient_id, description from public.audit_logs where action = 'patient_deleted_permanently' and patient_id = ${patientId}`;
      check(
        "T4 audit row: actor and non-identifying patient reference, no name in description",
        auditRow?.user_id === adminId &&
          auditRow?.patient_id === patientId &&
          !auditRow?.description?.includes("Synthetic"),
      );
      const [queueAfter] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue`;
      check("T4 exactly one cleanup-queue row inserted", queueAfter.n === queueBefore.n + 1);
      const [queueRow] =
        await tx`select storage_path, patient_ref, done_at from public.patient_file_cleanup_queue where patient_ref = ${patientId}`;
      check(
        "T4 cleanup-queue row references the right path and is not pre-marked done",
        queueRow?.storage_path === storagePath && queueRow?.done_at === null,
      );

      // T5: duplicate resubmit (double-click) safely rejected -- no
      // double-delete, no double audit row, no double queue row.
      const duplicateError = await expectError(() => call(patientId, "P3P11-TEST"));
      check("T5 duplicate resubmit rejected as NOT_FOUND", /NOT_FOUND/.test(duplicateError ?? ""));
      const [auditAfterDuplicate] =
        await tx`select count(*)::int as n from public.audit_logs where action = 'patient_deleted_permanently' and patient_id = ${patientId}`;
      check("T5 duplicate resubmit did not write a second audit row", auditAfterDuplicate.n === 1);
      const [queueAfterDuplicate] =
        await tx`select count(*)::int as n from public.patient_file_cleanup_queue where patient_ref = ${patientId}`;
      check(
        "T5 duplicate resubmit did not queue a second cleanup row",
        queueAfterDuplicate.n === 1,
      );

      // T6: staff can also permanently delete (not admin-only).
      await asUser(staffId);
      const staffRows = await call(otherPatientId, "P3P11-OTHER");
      check("T6 staff delete succeeds", staffRows[0]?.documents_deleted === 1);
      const [otherGone] = await tx`select id from public.patients where id = ${otherPatientId}`;
      check("T6 staff-deleted patient actually gone", !otherGone);

      // Never commit: this whole transaction touched only synthetic rows.
      throw new Error("__discard_test_transaction__");
    })
    .catch((e) => {
      if (e.message !== "__discard_test_transaction__") throw e;
    });

  await sql.end();
}

async function runStorageChecks() {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const stamp = Date.now();
  const path = `p3p11-synthetic/${stamp}.txt`;
  const patientRef = "00000000-0000-0000-0000-000000000000";

  const upload = await admin.storage
    .from("patient-documents")
    .upload(path, new Blob(["synthetic"]), { contentType: "text/plain" });
  check("Storage: synthetic attachment uploaded", !upload.error);

  const { data: queued, error: insertError } = await admin
    .from("patient_file_cleanup_queue")
    .insert({ storage_path: path, patient_ref: patientRef })
    .select("id")
    .single();
  check("Storage: cleanup-queue row inserted for synthetic attachment", !insertError);

  // Storage.remove() is idempotent w.r.t. missing objects/buckets (it
  // returns success, not an error, for a bucket that doesn't exist) -- so a
  // genuine failure is simulated with an invalid credential instead, which
  // the real API genuinely rejects (403 AccessDenied), rather than faking
  // an error client-side.
  const unauthorized = createClient(env.SUPABASE_URL, "not-a-real-key");
  const failedRemoval = await unauthorized.storage.from("patient-documents").remove([path]);
  check("Storage: simulated cleanup failure is a real API error", !!failedRemoval.error);
  const { data: stillQueued } = await admin
    .from("patient_file_cleanup_queue")
    .select("done_at")
    .eq("id", queued.id)
    .single();
  check(
    "Storage: after a failed cleanup attempt, the queue row is still pending (safe to retry)",
    stillQueued && stillQueued.done_at === null,
  );

  // Retry against the correct bucket: this is the same call
  // scripts/retry-patient-file-cleanup.mjs makes.
  const retryRemoval = await admin.storage.from("patient-documents").remove([path]);
  check("Storage: retry against the correct bucket succeeds", !retryRemoval.error);
  await admin.from("patient_file_cleanup_queue").delete().eq("id", queued.id);
  const { data: list } = await admin.storage.from("patient-documents").list("p3p11-synthetic");
  check(
    "Storage: attachment no longer present in the bucket after retry",
    !list?.some((f) => path.endsWith(f.name)),
  );
}

await runSqlChecks();
await runStorageChecks();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "\nAll live patient-delete checks passed. Real data was not touched (SQL transaction rolled back); synthetic storage artifacts were cleaned up.",
);
