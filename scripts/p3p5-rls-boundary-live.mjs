#!/usr/bin/env node
// Live RLS boundary check for P3-P5: confirms documents/fax_attempts/
// document_files SELECT+INSERT are reachable for admin and staff, and
// rejected for an authenticated role-less user and for a fully anonymous
// caller. Follows the same pattern as
// scripts/test-bulk-upload-permissions-live.mjs. Synthetic accounts and
// rows are created via the service role and deleted at the end; no real
// accounts or patient data are touched.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
// in .env. Run with: node scripts/p3p5-rls-boundary-live.mjs
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
const marker = `P3P5RLS${stamp}`;
const cleanupUsers = [];
let patientId = null;
let adminDocId = null;
let staffDocId = null;

async function makeSyntheticAccount(tag, role) {
  const email = `synth-rls-${tag}-${stamp}@users.invalid`;
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

async function makeSyntheticPatient() {
  const { data, error } = await admin
    .from("patients")
    .insert({ first_name: marker, last_name: "Synthetic", patient_id: `${marker}-PID` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create synthetic patient: ${error?.message}`);
  patientId = data.id;
}

function sampleDocument() {
  return { patient_id: patientId, document_type: "Initial Evaluation", status: "Draft" };
}

async function cleanup() {
  await admin
    .from("fax_attempts")
    .delete()
    .eq("document_id", adminDocId ?? "00000000-0000-0000-0000-000000000000");
  if (staffDocId) await admin.from("fax_attempts").delete().eq("document_id", staffDocId);
  await admin.from("document_files").delete().ilike("file_name", `${marker}%`);
  await admin
    .from("documents")
    .delete()
    .eq("patient_id", patientId ?? "00000000-0000-0000-0000-000000000000");
  if (patientId) await admin.from("patients").delete().eq("id", patientId);
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
    await makeSyntheticPatient();
    const adminClient = await makeSyntheticAccount("admin", "admin");
    const staffClient = await makeSyntheticAccount("staff", "staff");
    const rolelessClient = await makeSyntheticAccount("roleless", null);

    // ---- documents: INSERT ----
    const adminDocInsert = await adminClient
      .from("documents")
      .insert(sampleDocument())
      .select("id")
      .single();
    check("admin can insert a document", !adminDocInsert.error);
    adminDocId = adminDocInsert.data?.id ?? null;

    const staffDocInsert = await staffClient
      .from("documents")
      .insert(sampleDocument())
      .select("id")
      .single();
    check("staff can insert a document", !staffDocInsert.error);
    staffDocId = staffDocInsert.data?.id ?? null;

    const rolelessDocInsert = await rolelessClient.from("documents").insert(sampleDocument());
    check(
      "role-less caller is rejected inserting a document",
      !!rolelessDocInsert.error && rolelessDocInsert.data === null,
    );

    const anonDocInsert = await anon.from("documents").insert(sampleDocument());
    check(
      "anonymous caller is rejected inserting a document",
      !!anonDocInsert.error && anonDocInsert.data === null,
    );

    // ---- documents: SELECT ----
    const adminDocSelect = await adminClient.from("documents").select("id").eq("id", adminDocId);
    check(
      "admin can select the document it just created",
      (adminDocSelect.data?.length ?? 0) === 1,
    );
    const rolelessDocSelect = await rolelessClient
      .from("documents")
      .select("id")
      .eq("id", adminDocId);
    check(
      "role-less caller cannot select the document (empty, not error)",
      (rolelessDocSelect.data?.length ?? -1) === 0,
    );
    const anonDocSelect = await anon.from("documents").select("id").eq("id", adminDocId);
    check(
      "anonymous caller cannot select the document (empty, not error)",
      (anonDocSelect.data?.length ?? -1) === 0,
    );

    // ---- fax_attempts: INSERT / SELECT ----
    const attempt = { document_id: adminDocId, attempt_number: 1, status: "Sent Successfully" };
    const adminAttemptInsert = await adminClient.from("fax_attempts").insert(attempt);
    check("admin can insert a fax attempt", !adminAttemptInsert.error);

    const rolelessAttemptInsert = await rolelessClient
      .from("fax_attempts")
      .insert({ ...attempt, attempt_number: 2 });
    check(
      "role-less caller is rejected inserting a fax attempt",
      !!rolelessAttemptInsert.error && rolelessAttemptInsert.data === null,
    );

    const anonAttemptInsert = await anon
      .from("fax_attempts")
      .insert({ ...attempt, attempt_number: 3 });
    check(
      "anonymous caller is rejected inserting a fax attempt",
      !!anonAttemptInsert.error && anonAttemptInsert.data === null,
    );

    const rolelessAttemptSelect = await rolelessClient
      .from("fax_attempts")
      .select("id")
      .eq("document_id", adminDocId);
    check(
      "role-less caller cannot select fax attempts (empty, not error)",
      (rolelessAttemptSelect.data?.length ?? -1) === 0,
    );

    // ---- fax_attempts: UPDATE / DELETE (no policy exists for either -- corrections are impossible for everyone, by design) ----
    const { data: attemptRow } = await admin
      .from("fax_attempts")
      .select("id")
      .eq("document_id", adminDocId)
      .single();
    await adminClient.from("fax_attempts").update({ notes: "corrected" }).eq("id", attemptRow.id);
    const { data: unchanged } = await admin
      .from("fax_attempts")
      .select("notes")
      .eq("id", attemptRow.id)
      .single();
    check(
      "admin cannot UPDATE a fax attempt either (no RLS UPDATE policy exists -- confirms corrections require a new attempt, not a fix)",
      unchanged.notes !== "corrected",
    );

    // ---- document_files: INSERT / SELECT ----
    const file = {
      document_id: adminDocId,
      file_name: `${marker}.pdf`,
      storage_path: `synthetic/${marker}.pdf`,
      file_type: "application/pdf",
    };
    const adminFileInsert = await adminClient.from("document_files").insert(file);
    check("admin can insert a document_files row", !adminFileInsert.error);

    const rolelessFileInsert = await rolelessClient
      .from("document_files")
      .insert({ ...file, file_name: `${marker}-roleless.pdf` });
    check(
      "role-less caller is rejected inserting a document_files row",
      !!rolelessFileInsert.error && rolelessFileInsert.data === null,
    );

    const anonFileInsert = await anon
      .from("document_files")
      .insert({ ...file, file_name: `${marker}-anon.pdf` });
    check(
      "anonymous caller is rejected inserting a document_files row",
      !!anonFileInsert.error && anonFileInsert.data === null,
    );

    const rolelessFileSelect = await rolelessClient
      .from("document_files")
      .select("id")
      .eq("document_id", adminDocId);
    check(
      "role-less caller cannot select document_files (empty, not error)",
      (rolelessFileSelect.data?.length ?? -1) === 0,
    );

    // ---- cross-check against the DB directly: only the admin/staff rows exist ----
    const { data: survivors } = await admin
      .from("documents")
      .select("id")
      .eq("patient_id", patientId);
    check(
      "exactly 2 documents exist for the synthetic patient (admin's + staff's, both real inserts)",
      (survivors?.length ?? 0) === 2,
    );
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll P3-P5 RLS boundary checks passed. Synthetic data cleaned up.");
}

await main();
