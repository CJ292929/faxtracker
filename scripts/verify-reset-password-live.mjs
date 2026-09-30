#!/usr/bin/env node
// Live verification of admin-controlled password resets against the real
// Supabase project. Creates a synthetic admin + a synthetic staff account
// (service role, timestamp-tagged), exercises resetPassword() from
// src/lib/reset-password-core.ts directly against the real service-role
// client, then deletes only the synthetic accounts it created. Real
// accounts are never touched.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
// in .env. Run with:
//   node --experimental-strip-types scripts/verify-reset-password-live.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resetPassword } from "../src/lib/reset-password-core.ts";

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
          .replace(/^"|"$/g, ""),
      ];
    }),
);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
const stamp = Date.now();
const createdUserIds = [];

async function makeSyntheticAccount(tag, role) {
  const email = `synth-${tag}-${stamp}@users.invalid`;
  const password = `Synth-${stamp}-${tag}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic ${tag}: ${error?.message}`);
  const id = data.user.id;
  const username = `synth${tag}${stamp}`.slice(0, 32);
  createdUserIds.push(id);
  await admin.from("user_logins").insert({ user_id: id, username });
  await admin.from("user_roles").insert({ user_id: id, role });
  return { id, username, password, email };
}

async function cleanup() {
  for (const id of createdUserIds) {
    try {
      await admin.from("user_roles").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.from("user_logins").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {}
  }
  console.log(`cleaned up ${createdUserIds.length} synthetic account(s)`);
}

async function main() {
  const synthAdmin = await makeSyntheticAccount("admin", "admin");
  const synthStaff = await makeSyntheticAccount("staff", "staff");
  const newPassword = `Reset-${stamp}-new-pw!`;

  // 1) Admin resets the staff account's password.
  const resetResult = await resetPassword(
    synthAdmin.id,
    {
      targetUserId: synthStaff.id,
      password: newPassword,
      confirmPassword: newPassword,
    },
    admin,
  );
  check("admin successfully resets staff password", resetResult.ok === true);

  // 2) Sign in with the new password to prove Supabase Auth was actually updated.
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: synthStaff.email,
    password: newPassword,
  });
  check("staff account signs in with the new password", !signInErr && !!signIn.session);
  if (signIn?.session) {
    await anon.auth.signOut();
  }

  // 3) Old password no longer works.
  const { error: oldPasswordErr } = await anon.auth.signInWithPassword({
    email: synthStaff.email,
    password: synthStaff.password,
  });
  check("old password is rejected after reset", !!oldPasswordErr);

  // 4) Audit log recorded the reset, without the password.
  const { data: auditRows } = await admin
    .from("audit_logs")
    .select("user_id, action, description")
    .eq("action", "password_reset")
    .order("created_at", { ascending: false })
    .limit(1);
  const auditRow = auditRows?.[0];
  check(
    "audit row recorded actor and target username, never the password",
    !!auditRow &&
      auditRow.user_id === synthAdmin.id &&
      auditRow.description.includes(synthStaff.username) &&
      !auditRow.description.includes(newPassword) &&
      !JSON.stringify(auditRow).includes(newPassword),
  );

  // 5) A staff (non-admin) caller is denied.
  const staffDenied = await resetPassword(
    synthStaff.id,
    {
      targetUserId: synthAdmin.id,
      password: "Should-Not-Work-1!",
      confirmPassword: "Should-Not-Work-1!",
    },
    admin,
  );
  check(
    "staff caller is denied",
    staffDenied.ok === false && staffDenied.error === "Only administrators can reset passwords.",
  );

  // 6) An anonymous / role-less caller id is denied.
  const anonDenied = await resetPassword(
    "00000000-0000-0000-0000-000000000000",
    {
      targetUserId: synthStaff.id,
      password: "Should-Not-Work-1!",
      confirmPassword: "Should-Not-Work-1!",
    },
    admin,
  );
  check(
    "anonymous/role-less caller is denied",
    anonDenied.ok === false && anonDenied.error === "Only administrators can reset passwords.",
  );

  // 7) Neither denial actually changed the admin's password.
  const { data: adminStillSignsIn, error: adminSignInErr } = await anon.auth.signInWithPassword({
    email: synthAdmin.email,
    password: synthAdmin.password,
  });
  check(
    "denied reset attempts left the target password untouched",
    !adminSignInErr && !!adminStillSignsIn.session,
  );
  if (adminStillSignsIn?.session) {
    await anon.auth.signOut();
  }
}

main()
  .catch(async (err) => {
    console.error("ERROR:", err);
    failures++;
  })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
