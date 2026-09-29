#!/usr/bin/env node
// Live RLS boundary check for P3-P3 bulk upload inserts: confirms
// public.patients INSERT is reachable for admin and staff, and rejected for
// an authenticated role-less user and for a fully anonymous caller -- the
// same PostgREST insert the bulk-upload UI calls once per row. Synthetic
// accounts are created via the service role and deleted at the end; no real
// accounts or patients are touched.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
// in .env. Run with: node scripts/test-bulk-upload-permissions-live.mjs
import { readFileSync } from "node:fs";
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

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
const stamp = Date.now();
const marker = `PERM${stamp}`;
const cleanupUsers = [];

async function makeSyntheticAccount(tag, role) {
  const email = `synth-perm-${tag}-${stamp}@users.invalid`;
  const password = `Synth-${stamp}-${tag}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic ${tag}: ${error?.message}`);
  const id = data.user.id;
  cleanupUsers.push(id);
  if (role) await admin.from("user_roles").insert({ user_id: id, role });
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !signIn.session)
    throw new Error(`failed to sign in synthetic ${tag}: ${signInErr?.message}`);
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function samplePatient(tag) {
  return {
    first_name: marker,
    last_name: tag,
    patient_id: `${marker}-${tag}`,
    date_of_birth: "1980-01-01",
  };
}

async function cleanup() {
  await admin.from("patients").delete().ilike("first_name", `${marker}%`);
  for (const id of cleanupUsers) {
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

async function main() {
  try {
    const adminClient = await makeSyntheticAccount("admin", "admin");
    const staffClient = await makeSyntheticAccount("staff", "staff");
    const rolelessClient = await makeSyntheticAccount("roleless", null);

    const adminInsert = await adminClient.from("patients").insert(samplePatient("admin"));
    check("admin can insert a bulk-upload-shaped patient row", !adminInsert.error);

    const staffInsert = await staffClient.from("patients").insert(samplePatient("staff"));
    check("staff can insert a bulk-upload-shaped patient row", !staffInsert.error);

    const rolelessInsert = await rolelessClient.from("patients").insert(samplePatient("roleless"));
    check(
      "role-less authenticated caller is rejected",
      !!rolelessInsert.error && rolelessInsert.data === null,
    );

    const anonInsert = await anon.from("patients").insert(samplePatient("anon"));
    check(
      "anonymous caller (no session) is rejected",
      !!anonInsert.error && anonInsert.data === null,
    );

    const { data: survivors } = await admin
      .from("patients")
      .select("last_name")
      .ilike("first_name", `${marker}%`);
    const names = (survivors ?? []).map((r) => r.last_name).sort();
    check(
      "only the admin and staff rows were actually written",
      JSON.stringify(names) === JSON.stringify(["admin", "staff"]),
    );
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll bulk-upload permission-boundary checks passed. Synthetic data cleaned up.");
}

await main();
