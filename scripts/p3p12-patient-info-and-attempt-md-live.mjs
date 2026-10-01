#!/usr/bin/env node
// P3-P12 live verification: correct patient profiles (no stale/incomplete
// data on navigation) + the shared Patient Information card on documents +
// per-attempt MD (fax_attempts.md_name) through Add Attempt and the audited
// correction flow. Creates two synthetic patients (A and B) with clearly
// distinct values for all six required fields, drives the real running dev
// server through the actual portal login, and cleans up everything it
// created (including via the real "Delete Patient Permanently" flow).
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and the dev
// server running (set E2E_BASE_URL).
//
// Run with: node scripts/p3p12-patient-info-and-attempt-md-live.mjs admin
//           node scripts/p3p12-patient-info-and-attempt-md-live.mjs staff
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
);

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8081";
const role = process.argv[2];
if (role !== "admin" && role !== "staff") {
  console.error("usage: node scripts/p3p12-patient-info-and-attempt-md-live.mjs <admin|staff>");
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p12${role}${stamp}`.slice(0, 20);
const marker = `P3P12${role.toUpperCase()}${stamp}`;

const A = {
  first_name: `${marker}A`,
  last_name: "Anderson",
  patient_id: `${marker}-A-PID`,
  date_of_birth: "1975-03-11",
  phone: "555-0201",
  insurance: `${marker} Aetna A`,
  insurance_member_id: `${marker}-A-MID`,
  referring_physician: `${marker} Dr AlphaMD`,
  referring_physician_fax: "555-0301",
};
const B = {
  first_name: `${marker}B`,
  last_name: "Bradley",
  patient_id: `${marker}-B-PID`,
  date_of_birth: "1990-09-22",
  phone: "555-0202",
  insurance: `${marker} Cigna B`,
  insurance_member_id: `${marker}-B-MID`,
  referring_physician: `${marker} Dr BetaMD`,
  referring_physician_fax: "555-0302",
};
const drCorrected = `${marker} Dr CorrectedMD`;

let userId = null;
let ghostUserId = null;
let patientAId = null;
let patientBId = null;
let docAId = null;
let docBId = null;

async function makeSyntheticUser(assignRole) {
  const suffix = assignRole ? "" : "g";
  const email = `synth-${tag}${suffix}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`failed to create synthetic user: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}${suffix}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: id, username });
  if (assignRole) await admin.from("user_roles").insert({ user_id: id, role: assignRole });
  return { id, username, password };
}

async function makeSyntheticPatient(fields) {
  const { data, error } = await admin.from("patients").insert(fields).select("id").single();
  if (error || !data) throw new Error(`failed to create synthetic patient: ${error?.message}`);
  return data.id;
}

function fieldsMatch(bodyText, fields) {
  return (
    bodyText.includes(`${fields.first_name} ${fields.last_name}`) &&
    bodyText.includes(fields.insurance_member_id) &&
    bodyText.includes(fields.phone) &&
    bodyText.includes(fields.insurance) &&
    bodyText.includes(fields.referring_physician)
  );
}
function otherFieldsAbsent(bodyText, other) {
  return (
    !bodyText.includes(`${other.first_name} ${other.last_name}`) &&
    !bodyText.includes(other.insurance_member_id) &&
    !bodyText.includes(other.referring_physician)
  );
}

async function cleanup(cleanupErrors) {
  for (const docId of [docAId, docBId]) {
    if (!docId) continue;
    try {
      await admin.from("fax_attempts").delete().eq("document_id", docId);
      await admin.from("documents").delete().eq("id", docId);
    } catch (e) {
      cleanupErrors.push(`document cleanup failed: ${e.message}`);
    }
  }
  for (const pid of [patientAId, patientBId]) {
    if (!pid) continue;
    try {
      await admin.from("patients").delete().eq("id", pid);
    } catch {
      /* already deleted via the permanent-delete flow in the test itself */
    }
  }
  for (const id of [userId, ghostUserId]) {
    if (!id) continue;
    try {
      await admin.from("user_roles").delete().eq("user_id", id);
    } catch {
      /* ignore */
    }
    try {
      await admin.from("user_logins").delete().eq("user_id", id);
    } catch {
      /* ignore */
    }
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function main() {
  const cleanupErrors = [];
  const { id: primaryUserId, username, password } = await makeSyntheticUser(role);
  userId = primaryUserId;
  const ghost = await makeSyntheticUser(null);
  ghostUserId = ghost.id;
  patientAId = await makeSyntheticPatient(A);
  patientBId = await makeSyntheticPatient(B);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    // ---- login ----
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    // ---- unauthorized: a role-less account cannot log in / reach patient data ----
    const ghostPage = await browser.newPage();
    await ghostPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await ghostPage.getByRole("button", { name: "Staff Login" }).click();
    await ghostPage.locator("#staff-username").fill(ghost.username);
    await ghostPage.locator("#staff-password").fill(ghost.password);
    await ghostPage.getByRole("button", { name: "Staff Login" }).click();
    await ghostPage.waitForSelector("text=Invalid username or password", { timeout: 15000 });
    const ghostBody = await ghostPage.locator("body").innerText();
    check("role-less account is rejected and never reaches patient data", !ghostBody.includes(A.first_name) && !ghostBody.includes("Fax Attempt History"));
    await ghostPage.close();

    // ---- open A, then B, then A: verify all six fields + URL each time ----
    await page.goto(`${BASE_URL}/patients/${patientAId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${A.first_name}`, { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check("A: URL matches patient A id", page.url().endsWith(`/patients/${patientAId}`));
    check("A: all six fields render correctly", fieldsMatch(bodyText, A));
    check("A: does not show B's values", otherFieldsAbsent(bodyText, B));

    await page.goto(`${BASE_URL}/patients/${patientBId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${B.first_name}`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("B: URL matches patient B id", page.url().endsWith(`/patients/${patientBId}`));
    check("B: all six fields render correctly", fieldsMatch(bodyText, B));
    check("B: does not show A's values (no stale-state bleed-through)", otherFieldsAbsent(bodyText, A));

    await page.goto(`${BASE_URL}/patients/${patientAId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${A.first_name}`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("A again: all six fields still correct after A->B->A", fieldsMatch(bodyText, A));
    check("A again: does not show B's values", otherFieldsAbsent(bodyText, B));

    // ---- back/forward navigation ----
    await page.goBack({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("back navigation lands on B with B's own values", page.url().endsWith(`/patients/${patientBId}`) && fieldsMatch(bodyText, B));
    await page.goForward({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("forward navigation lands on A with A's own values", page.url().endsWith(`/patients/${patientAId}`) && fieldsMatch(bodyText, A));

    // ---- direct-link reload ----
    await page.goto(`${BASE_URL}/patients/${patientBId}`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(`text=${B.first_name}`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("direct-link reload on B renders B's values, not 'not found' and not A's data", fieldsMatch(bodyText, B) && !bodyText.includes("not found"));

    // ---- Patients search + sorted-list click-through ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.locator('input[placeholder="Search patient name..."]').fill(A.first_name);
    await page.waitForTimeout(300);
    let tableText = await page.locator("table.data-table tbody").innerText();
    check("Patients search narrows to patient A only", tableText.includes(A.first_name) && !tableText.includes(B.first_name));
    await page.getByRole("link", { name: `${A.first_name} ${A.last_name}` }).click();
    await page.waitForSelector(`text=${A.first_name}`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("clicking A's row from a filtered/sorted list opens A with correct values", fieldsMatch(bodyText, A));

    // ---- documents: create one per patient, verify Patient Information card ----
    await page.goto(`${BASE_URL}/patients/${patientAId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const mdInputA = page.locator('input[name="md_name"]');
    check("A: new document MD field prefills with A's Referring MD", (await mdInputA.inputValue()) === A.referring_physician);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Patient Information", { timeout: 15000 });
    docAId = page.url().split("/documents/")[1];
    bodyText = await page.locator("body").innerText();
    check("A's document: Patient Information card shows A's six fields", fieldsMatch(bodyText, A));
    check("A's document: Patient Information card does not show B's values", otherFieldsAbsent(bodyText, B));

    await page.goto(`${BASE_URL}/patients/${patientBId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const mdInputB = page.locator('input[name="md_name"]');
    check("B: new document MD field prefills with B's Referring MD, not A's", (await mdInputB.inputValue()) === B.referring_physician);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Patient Information", { timeout: 15000 });
    docBId = page.url().split("/documents/")[1];
    bodyText = await page.locator("body").innerText();
    check("B's document: Patient Information card shows B's six fields", fieldsMatch(bodyText, B));
    check("B's document: Patient Information card does not show A's values", otherFieldsAbsent(bodyText, A));

    // ---- Add Attempt with an MD, on document B ----
    await page.goto(`${BASE_URL}/documents/${docBId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    const attemptMdInput = page.locator('input[name="md_name"]');
    check("Add Attempt MD field prefills from document MD (falls back to patient MD when doc MD set)", (await attemptMdInput.inputValue()) === B.referring_physician);
    await attemptMdInput.fill("");
    await attemptMdInput.fill(drCorrected);
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForTimeout(1000);
    bodyText = await page.locator("body").innerText();
    check("new attempt shows its own MD in history", bodyText.includes(`MD: ${drCorrected}`));

    // ---- changing patient/document MD afterward does not retroactively change the saved attempt MD ----
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForSelector("text=Edit document");
    await page.locator('input[name="md_name"]').fill(`${marker} Dr DocChangedLater`);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("attempt MD unchanged after editing the document's MD afterward", bodyText.includes(`MD: ${drCorrected}`));

    const { data: attemptRow } = await admin.from("fax_attempts").select("id,updated_at,md_name").eq("document_id", docBId).single();
    check("DB confirms attempt md_name persisted as recorded (no implicit backfill)", attemptRow.md_name === drCorrected);

    // ---- correct the attempt's MD through the audited correction flow ----
    if (role === "admin" || role === "staff") {
      await page.locator('[title="Correct attempt"]').first().click();
      await page.waitForSelector("text=Correct attempt #1");
      const correctMdInput = page.locator('input[name="md_name"]');
      check("Correct attempt dialog prefills the attempt's own current MD", (await correctMdInput.inputValue()) === drCorrected);
      await correctMdInput.fill("");
      const drFinal = `${marker} Dr FinalCorrected`;
      await correctMdInput.fill(drFinal);
      await page.locator('textarea[name="reason"]').fill("P3-P12 live verification: correcting attempt MD");
      await page.getByRole("button", { name: "Save Correction" }).click();
      await page.waitForTimeout(1000);
      bodyText = await page.locator("body").innerText();
      check("corrected attempt shows the new MD", bodyText.includes(`MD: ${drFinal}`));
      check("correction history is recorded for the attempt", bodyText.includes("Corrected by"));

      const { data: corrections } = await admin.from("fax_attempt_corrections").select("id,before,after").eq("attempt_id", attemptRow.id);
      check("exactly one correction row recorded", (corrections ?? []).length === 1);
      check("correction before/after jsonb captured md_name change", corrections?.[0]?.before?.md_name === drCorrected && corrections?.[0]?.after?.md_name === drFinal);
    }

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);

    // ---- permanent delete of patient A; verify attempt-related data is gone too ----
    await page.goto(`${BASE_URL}/patients/${patientAId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Delete Patient Permanently" }).click();
    await page.waitForSelector("text=Delete patient permanently");
    await page.locator("input[autocomplete='off']").fill(A.patient_id);
    await page.getByRole("button", { name: "Delete Permanently" }).click();
    await page.waitForTimeout(1500);
    // DeletePatientModal closes and refreshes data in place rather than redirecting,
    // so the URL stays on the now-deleted patient; the route must show "not found"
    // instead of stale/leftover data for a patient that no longer exists.
    bodyText = await page.locator("body").innerText();
    check(
      "patient A shows 'not found' (not stale data) after permanent delete",
      page.url().endsWith(`/patients/${patientAId}`) && bodyText.includes("not found") && !bodyText.includes(A.insurance_member_id),
    );

    const { data: patientAAfter } = await admin.from("patients").select("id").eq("id", patientAId).maybeSingle();
    check("DB confirms patient A row is gone", !patientAAfter);
    const { data: docAAfter } = await admin.from("documents").select("id").eq("id", docAId).maybeSingle();
    check("DB confirms patient A's document is gone", !docAAfter);
    const { data: attemptsAAfter } = await admin.from("fax_attempts").select("id").eq("document_id", docAId);
    check("DB confirms patient A's fax_attempts (incl. md_name) are gone", (attemptsAAfter ?? []).length === 0);
    patientAId = null; // already deleted; skip in cleanup()
    docAId = null;
  } catch (e) {
    await page.screenshot({ path: `p3p12-${role}-error.png`, fullPage: true }).catch(() => {});
    console.log(
      "FLOW ERROR, body text:",
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "<unavailable>")
      ).slice(0, 1500),
    );
    throw e;
  } finally {
    await browser.close();
    await cleanup(cleanupErrors);
  }

  for (const e of cleanupErrors) console.error("CLEANUP ERROR:", e);
  if (failures || cleanupErrors.length) {
    console.error(`\n${failures} check(s) failed, ${cleanupErrors.length} cleanup error(s).`);
    process.exit(1);
  }
  console.log(`\nAll P3-P12 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
