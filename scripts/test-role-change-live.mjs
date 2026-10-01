#!/usr/bin/env node
// Live verification of public.change_user_role against the real database
// for P3-P2R2. Two layers:
//
//  A) Direct-SQL checks (admin success + atomic audit, self-demotion,
//     staff/role-less direct-call denial, audit-insert-failure rollback)
//     run inside one Postgres transaction on synthetic uuids that is
//     always ROLLBACK'd at the end -- nothing here is ever committed, so
//     it never touches the two real accounts.
//
//  B) Real synthetic Supabase accounts (created via the service role,
//     deleted at the end) for the checks that need the actual PostgREST/
//     auth boundary: an anonymous direct RPC call, and a true two
//     -connection concurrent "two admins demote each other" race.
//
// Requires SUPABASE_DB_MIGRATION_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_PUBLISHABLE_KEY in .env. Run with: node scripts/test-role-change-live.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

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

// ---------- A) direct-SQL, uncommitted transaction ----------
async function runSqlChecks() {
  const sql = postgres(env.SUPABASE_DB_MIGRATION_URL);
  const admin1 = "a0000000-0000-0000-0000-0000000000a1";
  const admin2 = "a0000000-0000-0000-0000-0000000000a2";
  const staffX = "a0000000-0000-0000-0000-0000000000f1";
  const target = "a0000000-0000-0000-0000-0000000000b1";
  const ghost = "a0000000-0000-0000-0000-0000000000c1";

  await sql
    .begin(async (tx) => {
      // Isolate: this transaction never commits, so wiping user_roles here
      // has zero effect on the real table once we roll back.
      await tx`delete from public.user_roles`;
      await tx`delete from public.user_logins where user_id = any(${[admin1, admin2, staffX, target, ghost]})`;
      await tx`insert into public.user_roles (user_id, role) values
      (${admin1}, 'admin'), (${admin2}, 'admin'), (${staffX}, 'staff'), (${target}, 'staff')`;
      // user_logins.user_id references auth.users, so synthetic (non-real)
      // ids can't have a login row here; the audit description falls back to
      // the raw user id in that case, which the assertion below accounts for.

      const asUser = (id) =>
        tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id })}, true)`;

      // A Postgres error poisons the rest of the transaction until rolled
      // back to a savepoint, so every call expected to fail runs inside one.
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

      // T1: admin success, atomic with audit.
      await asUser(admin1);
      const [before] = await tx`select count(*)::int as n from public.audit_logs`;
      const rows = await tx`select * from public.change_user_role(${target}, 'admin')`;
      const [after] = await tx`select count(*)::int as n from public.audit_logs`;
      const [targetRow] = await tx`select role from public.user_roles where user_id = ${target}`;
      check(
        "T1 admin promotes target: function returns changed row",
        rows[0]?.new_role === "admin",
      );
      check("T1 admin promotes target: role actually updated", targetRow.role === "admin");
      check("T1 admin promotes target: exactly one audit row written", after.n === before.n + 1);
      const [auditRow] =
        await tx`select action, user_id, description from public.audit_logs order by created_at desc limit 1`;
      check(
        "T1 audit row has actor, action, and old->new description",
        auditRow.action === "role_changed" &&
          auditRow.user_id === admin1 &&
          auditRow.description.includes(target) &&
          /staff/.test(auditRow.description) &&
          /admin/.test(auditRow.description),
      );

      // T2: self-demotion denied.
      await asUser(admin1);
      const selfDemotionError = await expectError(
        () => tx`select * from public.change_user_role(${admin1}, 'staff')`,
      );
      check("T2 self-demotion rejected", /SELF_DEMOTION/.test(selfDemotionError ?? ""));
      const [admin1Row] = await tx`select role from public.user_roles where user_id = ${admin1}`;
      check("T2 self-demotion: caller role unchanged", admin1Row.role === "admin");

      // T3: staff caller denied (simulates a direct RPC call bypassing the UI).
      await asUser(staffX);
      const staffError = await expectError(
        () => tx`select * from public.change_user_role(${admin2}, 'staff')`,
      );
      check("T3 staff-role direct call rejected", /FORBIDDEN/.test(staffError ?? ""));
      const [admin2Row] = await tx`select role from public.user_roles where user_id = ${admin2}`;
      check("T3 staff-role direct call: target role unchanged", admin2Row.role === "admin");

      // T4: role-less caller denied (authenticated user, no user_roles row).
      await asUser(ghost);
      const ghostError = await expectError(
        () => tx`select * from public.change_user_role(${target}, 'staff')`,
      );
      check("T4 role-less caller rejected", /FORBIDDEN/.test(ghostError ?? ""));

      // T5: unauthenticated caller (auth.uid() IS NULL) denied.
      await tx`select set_config('request.jwt.claims', '', true)`;
      const anonError = await expectError(
        () => tx`select * from public.change_user_role(${target}, 'staff')`,
      );
      check("T5 unauthenticated caller rejected", /FORBIDDEN/.test(anonError ?? ""));

      // T6: audit-insert failure rolls back the role update, in the same call.
      await asUser(admin1);
      const rollbackError = await expectError(async () => {
        // NOT VALID: skip validating existing rows (T1's own audit row, and
        // real history, already have action = 'role_changed') and only
        // enforce the constraint going forward, which is all this needs.
        await tx`alter table public.audit_logs add constraint tmp_break_audit check (action <> 'role_changed') not valid`;
        await tx`select * from public.change_user_role(${target}, 'staff')`;
      });
      check("T6 audit-insert failure surfaces as an error", rollbackError !== null);
      const [targetAfterFail] =
        await tx`select role from public.user_roles where user_id = ${target}`;
      check(
        "T6 role update rolled back with the failed audit insert",
        targetAfterFail.role === "admin",
      );

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
  const users = {};
  const cleanup = [];

  async function makeSyntheticAdmin(tag) {
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
    cleanup.push(id);
    await admin
      .from("user_logins")
      .insert({ user_id: id, username: `synth${tag}${stamp}`.slice(0, 32) });
    await admin.from("user_roles").insert({ user_id: id, role: "admin" });
    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (signInErr || !signIn.session)
      throw new Error(`failed to sign in synthetic user ${tag}: ${signInErr?.message}`);
    return { id, token: signIn.session.access_token };
  }

  function scopedClient(token) {
    return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  try {
    // Anonymous direct RPC call: no session at all.
    const { error: anonRpcError } = await anon.rpc("change_user_role", {
      _target_user_id: "00000000-0000-0000-0000-000000000000",
      _new_role: "staff",
    });
    check(
      "anonymous direct RPC call is rejected",
      !!anonRpcError && /permission denied|FORBIDDEN/i.test(anonRpcError.message),
    );

    // Two real synthetic admins, concurrently demoting each other.
    users.a = await makeSyntheticAdmin("a");
    users.b = await makeSyntheticAdmin("b");
    const clientA = scopedClient(users.a.token);
    const clientB = scopedClient(users.b.token);

    const [resA, resB] = await Promise.all([
      clientA.rpc("change_user_role", { _target_user_id: users.b.id, _new_role: "staff" }),
      clientB.rpc("change_user_role", { _target_user_id: users.a.id, _new_role: "staff" }),
    ]);
    const succeeded = [resA, resB].filter((r) => !r.error).length;
    check("concurrent mutual demotion: exactly one request succeeds", succeeded === 1);
    const { data: finalRoles } = await admin
      .from("user_roles")
      .select("user_id, role")
      .in("user_id", [users.a.id, users.b.id]);
    const finalAdmins = (finalRoles ?? []).filter((r) => r.role === "admin").length;
    check(
      "concurrent mutual demotion: exactly one of the two remains admin (never zero)",
      finalAdmins === 1,
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
  console.log("\nAll live role-change checks passed. Real accounts were not touched.");
}

await main();
