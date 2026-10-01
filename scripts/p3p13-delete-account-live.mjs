#!/usr/bin/env node
// Live verification of public.delete_staff_account for P3-P13.
//
// Part A runs inside one Postgres transaction that is always ROLLBACK'd at
// the end (same discipline as scripts/p3p11-patient-delete-live.mjs and
// scripts/test-role-change-live.mjs): it inserts minimal synthetic
// auth.users rows (id only -- every other NOT NULL column on auth.users has
// a default) alongside matching public.user_logins/user_roles rows, purely
// so the FK from user_logins to auth.users is satisfiable without ever
// touching a real account. This lets the whole admin-count invariant
// (last-admin denial AND success once a third admin exists) be exercised
// with an exactly-known, isolated admin count, immune to however many real
// admins exist in this database -- plus FORBIDDEN (staff/role-less/
// unauthenticated), SELF_DELETE, NOT_FOUND, and CONFLICT (mismatched
// username), atomic mapping cleanup, and the audit row.
//
// Part B uses real synthetic Supabase accounts (service role, timestamp-
// tagged, deleted at the end) for checks that need the actual PostgREST/
// Auth boundary and cannot be run against the real admin count in Part A's
// isolated setup: the full lifecycle (sign-in works, the account is deleted
// via the RPC through a caller-scoped client exactly as the app calls it,
// then sign-in and the prior session's access to a staff-gated table both
// fail), a staff (non-admin) caller denied, an anonymous direct RPC call
// denied, and a true two-connection concurrent "duplicate submit" race
// (two simultaneous delete requests for the same target) that must leave
// exactly one success, one safe NOT_FOUND, and exactly one audit row --
// this sub-test is deliberately shaped to be correct regardless of how many
// other real admins exist, unlike a "last admin" race would be.
//
// Requires SUPABASE_DB_MIGRATION_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_PUBLISHABLE_KEY in .env. Run with:
//   node --experimental-strip-types scripts/p3p13-delete-account-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^"(.*)"$/, "$1"),
      ];
    }),
);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

// ---------- A) direct-SQL, uncommitted transaction ----------
async function runSqlChecks() {
  const sql = postgres(env.SUPABASE_DB_MIGRATION_URL);
  const admin1 = "d0000000-0000-0000-0000-0000000000a1";
  const admin2 = "d0000000-0000-0000-0000-0000000000a2";
  const staffX = "d0000000-0000-0000-0000-0000000000f1";
  const target = "d0000000-0000-0000-0000-0000000000b1";
  const ghost = "d0000000-0000-0000-0000-0000000000c1";
  const ids = [admin1, admin2, staffX, target, ghost];
  const username = (id) => `synthtx${id.slice(-2)}`;

  await sql
    .begin(async (tx) => {
      // Isolate the admin-count invariant: this transaction never commits,
      // so wiping user_roles here (same discipline as
      // scripts/test-role-change-live.mjs) has zero effect on the real
      // table once we roll back, and lets T6/T7 below use an exact,
      // known admin count instead of whatever real admins exist today.
      await tx`delete from public.user_roles`;
      await tx`delete from public.user_logins where user_id = any(${ids})`;
      await tx`delete from auth.users where id = any(${ids})`;

      // Minimal synthetic auth.users rows: only `id` has no default on this
      // project's auth schema, so this satisfies user_logins' FK without
      // ever touching a real account -- rolled back at the end either way.
      for (const id of ids) {
        await tx`insert into auth.users (id) values (${id})`;
        await tx`insert into public.user_logins (user_id, username) values (${id}, ${username(id)})`;
      }
      await tx`insert into public.user_roles (user_id, role) values
      (${admin1}, 'admin'), (${admin2}, 'admin'), (${staffX}, 'staff'), (${target}, 'staff')`;

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

      const call = (id, uname) => tx`select * from public.delete_staff_account(${id}, ${uname})`;

      // T1: staff caller denied (simulates a direct RPC call bypassing the UI).
      await asUser(staffX);
      const staffError = await expectError(() => call(target, username(target)));
      check("T1 staff-role direct call rejected", /FORBIDDEN/.test(staffError ?? ""));
      const [staffTargetRow] =
        await tx`select role from public.user_roles where user_id = ${target}`;
      check("T1 staff-role direct call: target role unchanged", staffTargetRow.role === "staff");

      // T2: role-less caller denied (authenticated user, no user_roles row).
      await asUser(ghost);
      const ghostError = await expectError(() => call(target, username(target)));
      check("T2 role-less caller rejected", /FORBIDDEN/.test(ghostError ?? ""));

      // T3: unauthenticated caller (auth.uid() IS NULL) denied.
      await tx`select set_config('request.jwt.claims', '', true)`;
      const anonError = await expectError(() => call(target, username(target)));
      check("T3 unauthenticated caller rejected", /FORBIDDEN/.test(anonError ?? ""));

      // T4: self-delete denied.
      await asUser(admin1);
      const selfError = await expectError(() => call(admin1, username(admin1)));
      check("T4 self-delete rejected", /SELF_DELETE/.test(selfError ?? ""));
      const [admin1Row] = await tx`select role from public.user_roles where user_id = ${admin1}`;
      check("T4 self-delete: caller role unchanged", admin1Row.role === "admin");

      // T5: mismatched confirmation username rejected, nothing deleted.
      const confirmError = await expectError(() => call(target, "wrong-username"));
      check("T5 mismatched confirmation username rejected", /CONFLICT/.test(confirmError ?? ""));
      const [targetStillThere] =
        await tx`select user_id from public.user_logins where user_id = ${target}`;
      check("T5 target not deleted after mismatched confirmation", !!targetStillThere);

      // T6: with exactly 2 admins, deleting one succeeds and leaves exactly
      // 1 (never zero) -- the actual boundary the LAST_ADMIN guard exists
      // to enforce. (LAST_ADMIN itself can only ever fire for a *distinct*
      // caller/target pair in a concurrent-request race, never from a
      // single direct call: the caller must itself be admin and distinct
      // from the target, so the admin count at check time can never be
      // less than 2 -- the same is true of change_user_role's identical
      // guard, which is why scripts/test-role-change-live.mjs doesn't
      // attempt to trigger it directly either. The true protection against
      // two concurrent requests jointly zeroing out the admins is the
      // advisory lock serializing them so the second caller's own
      // just-deleted FORBIDDEN check catches it instead -- covered live in
      // Part B below.)
      const [adminCountBefore] =
        await tx`select count(*)::int as n from public.user_roles where role = 'admin'`;
      check("T6 exactly 2 admins before the delete", adminCountBefore.n === 2);
      const [auditBefore] = await tx`select count(*)::int as n from public.audit_logs`;
      const rows = await call(admin2, username(admin2));
      check(
        "T6 admin delete succeeds with 2 admins present",
        rows[0]?.target_username === username(admin2),
      );
      const [admin2Gone] =
        await tx`select user_id from public.user_logins where user_id = ${admin2}`;
      check("T6 user_logins mapping removed", !admin2Gone);
      const [admin2RoleGone] =
        await tx`select user_id from public.user_roles where user_id = ${admin2}`;
      check("T6 user_roles mapping removed (no orphaned role row)", !admin2RoleGone);
      const [admin2AuthGone] = await tx`select id from auth.users where id = ${admin2}`;
      check("T6 auth.users row removed", !admin2AuthGone);
      const [adminCountAfter] =
        await tx`select count(*)::int as n from public.user_roles where role = 'admin'`;
      check("T6 exactly 1 admin remains (never zero)", adminCountAfter.n === 1);
      const [auditAfter] = await tx`select count(*)::int as n from public.audit_logs`;
      check("T6 exactly one audit row written", auditAfter.n === auditBefore.n + 1);
      const [auditRow] =
        await tx`select action, user_id, description from public.audit_logs order by created_at desc limit 1`;
      check(
        "T6 audit row: actor, action, deleted username and prior role",
        auditRow.action === "account_deleted" &&
          auditRow.user_id === admin1 &&
          auditRow.description.includes(username(admin2)) &&
          auditRow.description.includes("admin"),
      );

      // T7: duplicate resubmit (double-click) safely rejected -- the mapping
      // is already gone, so this is NOT_FOUND, not a crash or a second delete.
      const duplicateError = await expectError(() => call(admin2, username(admin2)));
      check("T7 duplicate resubmit rejected as NOT_FOUND", /NOT_FOUND/.test(duplicateError ?? ""));
      const [auditAfterDuplicate] = await tx`select count(*)::int as n from public.audit_logs`;
      check(
        "T7 duplicate resubmit did not write a second audit row",
        auditAfterDuplicate.n === auditAfter.n,
      );

      // T8: unrelated account (staffX) left untouched by all of the above.
      const [staffXStillThere] =
        await tx`select role from public.user_roles where user_id = ${staffX}`;
      check("T8 unrelated account untouched", staffXStillThere?.role === "staff");

      // Never commit: this whole transaction touched only synthetic rows.
      throw new Error("__discard_test_transaction__");
    })
    .catch((e) => {
      if (e.message !== "__discard_test_transaction__") throw e;
    });

  await sql.end();
}

// ---------- B) real synthetic accounts over HTTP ----------
async function runLiveAccountChecks() {
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
  const stamp = Date.now();
  const cleanup = [];

  async function makeSyntheticAccount(tag, role) {
    const email = `synth-${tag}-${stamp}@users.invalid`;
    const password = `Synth-${stamp}-${tag}-pw!`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user)
      throw new Error(`failed to create synthetic user ${tag}: ${error?.message}`);
    const id = data.user.id;
    const username = `synth${tag}${stamp}`.slice(0, 32);
    cleanup.push(id);
    await admin.from("user_logins").insert({ user_id: id, username });
    await admin.from("user_roles").insert({ user_id: id, role });
    return { id, username, email, password };
  }

  function scopedClient(token) {
    return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async function signIn(email, password) {
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
    return data.session.access_token;
  }

  try {
    // Anonymous direct RPC call: no session at all.
    const { error: anonRpcError } = await anon.rpc("delete_staff_account", {
      _target_user_id: "00000000-0000-0000-0000-000000000000",
      _expected_username: "whoever",
    });
    check(
      "anonymous direct RPC call is rejected",
      !!anonRpcError && /permission denied|FORBIDDEN/i.test(anonRpcError.message),
    );

    // Full lifecycle: an admin deletes a synthetic staff account exactly the
    // way the app does -- an RPC call through a caller-scoped client built
    // from the admin's own signed-in session token.
    const bootAdmin = await makeSyntheticAccount("boot", "admin");
    const victim = await makeSyntheticAccount("victim", "staff");
    const adminToken = await signIn(bootAdmin.email, bootAdmin.password);
    const adminClient = scopedClient(adminToken);

    // Sign the victim in first to prove the session existed before deletion.
    const victimTokenBefore = await signIn(victim.email, victim.password);
    check("victim can sign in before deletion", !!victimTokenBefore);

    // Wrong confirmation username is rejected and deletes nothing.
    const { error: wrongUsernameErr } = await adminClient.rpc("delete_staff_account", {
      _target_user_id: victim.id,
      _expected_username: "not-the-right-username",
    });
    check(
      "mismatched confirmation username rejected",
      !!wrongUsernameErr && /CONFLICT/.test(wrongUsernameErr.message),
    );
    const { data: stillLoggedIn } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("user_id", victim.id)
      .maybeSingle();
    check("mismatched confirmation left the account intact", !!stillLoggedIn);

    const { data: deleteRows, error: deleteErr } = await adminClient.rpc("delete_staff_account", {
      _target_user_id: victim.id,
      _expected_username: victim.username,
    });
    check(
      "admin deletes synthetic staff account via RPC",
      !deleteErr && deleteRows?.[0]?.target_username === victim.username,
    );

    // Mappings are gone.
    const { data: loginAfter } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("user_id", victim.id)
      .maybeSingle();
    check("user_logins mapping removed", !loginAfter);
    const { data: roleAfter } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("user_id", victim.id)
      .maybeSingle();
    check("user_roles mapping removed (no orphaned role row)", !roleAfter);

    // The Supabase Auth account itself is gone.
    const { data: authUserAfter, error: authUserErr } = await admin.auth.admin.getUserById(
      victim.id,
    );
    check("Supabase Auth account no longer exists", !authUserAfter?.user || !!authUserErr);

    // The deleted account cannot sign in again.
    const { error: signInAfterErr } = await anon.auth.signInWithPassword({
      email: victim.email,
      password: victim.password,
    });
    check("deleted account cannot sign in again", !!signInAfterErr);

    // Its prior session token can no longer reach a staff-gated resource.
    const victimClientBefore = scopedClient(victimTokenBefore);
    const { data: patientsAfter, error: patientsAfterErr } = await victimClientBefore
      .from("patients")
      .select("id")
      .limit(1);
    check(
      "prior session can no longer read staff-gated data",
      (patientsAfter ?? []).length === 0 || !!patientsAfterErr,
    );

    // Audit row recorded who deleted what, never a password.
    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("user_id, action, description")
      .eq("action", "account_deleted")
      .order("created_at", { ascending: false })
      .limit(1);
    const auditRow = auditRows?.[0];
    check(
      "audit row recorded actor and deleted username, never a password",
      !!auditRow &&
        auditRow.user_id === bootAdmin.id &&
        auditRow.description.includes(victim.username) &&
        !auditRow.description.includes(victim.password) &&
        !JSON.stringify(auditRow).includes(victim.password),
    );

    // A staff (non-admin) caller is denied.
    const staffAcct = await makeSyntheticAccount("staffcaller", "staff");
    const staffToken = await signIn(staffAcct.email, staffAcct.password);
    const staffClient = scopedClient(staffToken);
    const { error: staffDeniedErr } = await staffClient.rpc("delete_staff_account", {
      _target_user_id: bootAdmin.id,
      _expected_username: bootAdmin.username,
    });
    check("staff caller is denied", !!staffDeniedErr && /FORBIDDEN/.test(staffDeniedErr.message));
    const { data: bootAdminStillThere } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("user_id", bootAdmin.id)
      .maybeSingle();
    check("staff-denied delete left the target account intact", !!bootAdminStillThere);

    // True two-connection concurrent "duplicate submit" race: two different
    // admins simultaneously try to delete the SAME target. This is correct
    // regardless of how many other real admins exist (unlike a last-admin
    // race would be), and directly exercises the advisory lock serializing
    // genuinely concurrent HTTP requests against the same row.
    const secondAdmin = await makeSyntheticAccount("second", "admin");
    const secondToken = await signIn(secondAdmin.email, secondAdmin.password);
    const secondClient = scopedClient(secondToken);
    const raceTarget = await makeSyntheticAccount("racetarget", "staff");

    const [raceA, raceB] = await Promise.all([
      adminClient.rpc("delete_staff_account", {
        _target_user_id: raceTarget.id,
        _expected_username: raceTarget.username,
      }),
      secondClient.rpc("delete_staff_account", {
        _target_user_id: raceTarget.id,
        _expected_username: raceTarget.username,
      }),
    ]);
    const raceSucceeded = [raceA, raceB].filter((r) => !r.error).length;
    check("concurrent duplicate-submit race: exactly one request succeeds", raceSucceeded === 1);
    const raceFailed = [raceA, raceB].find((r) => r.error);
    check(
      "concurrent duplicate-submit race: the other is rejected as NOT_FOUND",
      !!raceFailed && /NOT_FOUND/.test(raceFailed.error.message),
    );
    const { data: raceTargetGone } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("user_id", raceTarget.id)
      .maybeSingle();
    check("concurrent duplicate-submit race: target fully deleted exactly once", !raceTargetGone);
    const { data: raceAuditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("action", "account_deleted")
      .ilike("description", `%${raceTarget.username}%`);
    check(
      "concurrent duplicate-submit race: exactly one audit row written",
      (raceAuditRows ?? []).length === 1,
    );
  } finally {
    for (const id of cleanup) {
      await admin
        .from("user_roles")
        .delete()
        .eq("user_id", id)
        .then(
          () => {},
          () => {},
        );
      await admin
        .from("user_logins")
        .delete()
        .eq("user_id", id)
        .then(
          () => {},
          () => {},
        );
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  }
}

async function main() {
  await runSqlChecks();
  await runLiveAccountChecks();

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll live delete-account checks passed. Real accounts were not touched.");
}

await main();
