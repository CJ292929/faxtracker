#!/usr/bin/env node
// P3-P14 live verification: both "Add Attempt" buttons on the document page
// now open the same complete form layout as "Add document / fax" (Patient
// Information, read-only Document Information, editable Recipient Type /
// Recipient Name / Recipient Fax Number, the searchable MD selector, and the
// Fax Attempt fields), and saving it creates exactly one attempt on the
// existing document with its own independently-stored recipient + MD, never
// rewriting earlier attempts. Creates one synthetic patient + document,
// drives the real running dev server through the actual portal login, and
// cleans up everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and the dev
// server running (set E2E_BASE_URL).
//
// Run with: node scripts/p3p14-attempt-form-parity-live.mjs admin
//           node scripts/p3p14-attempt-form-parity-live.mjs staff
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
  console.error("usage: node scripts/p3p14-attempt-form-parity-live.mjs <admin|staff>");
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p14${role}${stamp}`.slice(0, 20);
const marker = `P3P14${role.toUpperCase()}${stamp}`;

const PATIENT = {
  first_name: `${marker}First`,
  last_name: "Parity",
  patient_id: `${marker}-PID`,
  date_of_birth: "1980-05-14",
  phone: "555-0401",
  insurance: `${marker} Aetna`,
  insurance_member_id: `${marker}-MID`,
  referring_physician: `${marker} Dr PatientMD`,
  referring_physician_fax: "555-0501",
};
const DOC = {
  document_type: "Initial Evaluation",
  document_number: 42,
  document_date: "2026-01-15",
  recipient_type: "Insurance",
  recipient_name: `${marker} OriginalInsurer`,
  recipient_fax: "555-0601",
  md_name: `${marker} Dr DocMD`,
  status: "Draft",
};
const ATTEMPT1 = {
  recipientType: "Referring MD",
  recipientName: `${marker} Attempt1 Recipient`,
  recipientFax: "555-0701",
  mdName: `${marker} Dr Attempt1MD`,
  confirmationNumber: `${marker}-REF1`,
};
const ATTEMPT2 = {
  recipientType: "Other",
  recipientName: `${marker} Attempt2 Recipient`,
  recipientFax: "555-0702",
  mdName: `${marker} Dr Attempt2MD`,
};

let userId = null;
let ghostUserId = null;
let patientId = null;
let docId = null;

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

async function cleanup(cleanupErrors) {
  if (docId) {
    try {
      await admin.from("fax_attempts").delete().eq("document_id", docId);
      await admin.from("documents").delete().eq("id", docId);
    } catch (e) {
      cleanupErrors.push(`document cleanup failed: ${e.message}`);
    }
  }
  if (patientId) {
    try {
      await admin.from("patients").delete().eq("id", patientId);
    } catch (e) {
      cleanupErrors.push(`patient cleanup failed: ${e.message}`);
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

  const { data: patientRow, error: patientError } = await admin
    .from("patients")
    .insert(PATIENT)
    .select("id")
    .single();
  if (patientError || !patientRow) throw new Error(`failed to create synthetic patient: ${patientError?.message}`);
  patientId = patientRow.id;

  const { data: docRow, error: docError } = await admin
    .from("documents")
    .insert({ ...DOC, patient_id: patientId })
    .select("id")
    .single();
  if (docError || !docRow) throw new Error(`failed to create synthetic document: ${docError?.message}`);
  docId = docRow.id;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    // ---- unauthorized: a role-less account cannot log in / reach document data ----
    const ghostPage = await browser.newPage();
    await ghostPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await ghostPage.getByRole("button", { name: "Staff Login" }).click();
    await ghostPage.locator("#staff-username").fill(ghost.username);
    await ghostPage.locator("#staff-password").fill(ghost.password);
    await ghostPage.getByRole("button", { name: "Staff Login" }).click();
    await ghostPage.waitForSelector("text=Invalid username or password", { timeout: 15000 });
    check("role-less account is denied login and never reaches document data", true);
    await ghostPage.close();

    // ---- login ----
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    await page.goto(`${BASE_URL}/documents/${docId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Patient Information", { timeout: 15000 });

    const [docsBefore] = await Promise.all([
      admin.from("documents").select("id").eq("patient_id", patientId),
    ]);
    const documentCountBefore = (docsBefore.data ?? []).length;

    // ---- header "Add Attempt" button opens the complete form ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    let bodyText = await page.locator("body").innerText();
    check(
      "header Add Attempt: Patient Information section shows the patient's six fields",
      bodyText.includes(`${PATIENT.first_name} ${PATIENT.last_name}`) &&
        bodyText.includes(PATIENT.insurance_member_id) &&
        bodyText.includes(PATIENT.phone) &&
        bodyText.includes(PATIENT.insurance) &&
        bodyText.includes(PATIENT.referring_physician),
    );
    check(
      "header Add Attempt: Document Information section shows type/number/date",
      bodyText.includes(DOC.document_type) && bodyText.includes(String(DOC.document_number)),
    );
    const mdInput = page.locator('input[name="md_name"]');
    check("MD selector is visible and prefilled from the document's MD", (await mdInput.isVisible()) && (await mdInput.inputValue()) === DOC.md_name);
    check(
      "Recipient fields are visible and prefilled from the document",
      (await page.locator('select[name="recipient_type"]').inputValue()) === DOC.recipient_type &&
        (await page.locator('input[name="recipient_name"]').inputValue()) === DOC.recipient_name &&
        (await page.locator('input[name="recipient_fax"]').inputValue()) === DOC.recipient_fax,
    );

    // ---- Cancel writes nothing ----
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector("text=Add fax attempt", { state: "detached" });
    const { data: attemptsAfterCancel } = await admin.from("fax_attempts").select("id").eq("document_id", docId);
    check("Cancel creates no fax_attempts row", (attemptsAfterCancel ?? []).length === 0);

    // ---- history-section "Add Attempt" button also opens the complete form ----
    await page.getByRole("button", { name: "Add Attempt" }).last().click();
    await page.waitForSelector("text=Add fax attempt");
    check("history-section Add Attempt button also opens the complete form", await page.locator('input[name="md_name"]').isVisible());

    // ---- Failed status requires a failure reason ----
    await page.locator('select[name="status"]').selectOption("Failed");
    const failureReasonSelect = page.locator('select[name="failure_reason"]');
    check("Failure reason becomes required when status is Failed", await failureReasonSelect.evaluate((el) => el.required));
    await page.locator('select[name="status"]').selectOption("Sent Successfully");

    // ---- fill and save attempt #1 ----
    await page.locator('select[name="recipient_type"]').selectOption(ATTEMPT1.recipientType);
    await page.locator('input[name="recipient_name"]').fill(ATTEMPT1.recipientName);
    await page.locator('input[name="recipient_fax"]').fill(ATTEMPT1.recipientFax);
    await mdInput.fill("");
    await page.locator('input[name="md_name"]').fill(ATTEMPT1.mdName);
    await page.locator('input[name="confirmation_number"]').fill(ATTEMPT1.confirmationNumber);
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForSelector("text=Add fax attempt", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    const { data: attemptsAfterFirst } = await admin
      .from("fax_attempts")
      .select("id,recipient_type,recipient_name,recipient_fax,md_name")
      .eq("document_id", docId)
      .order("attempt_number");
    check("exactly one attempt exists on the existing document after saving", (attemptsAfterFirst ?? []).length === 1);
    const attempt1Row = attemptsAfterFirst?.[0];
    check(
      "attempt #1 stored its own recipient + MD independently",
      attempt1Row?.recipient_type === ATTEMPT1.recipientType &&
        attempt1Row?.recipient_name === ATTEMPT1.recipientName &&
        attempt1Row?.recipient_fax === ATTEMPT1.recipientFax &&
        attempt1Row?.md_name === ATTEMPT1.mdName,
    );

    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check(
      "recipient + MD edits for attempt #1 persist after reload",
      bodyText.includes(`MD: ${ATTEMPT1.mdName}`) && bodyText.includes(ATTEMPT1.recipientName) && bodyText.includes(ATTEMPT1.recipientFax),
    );

    const { data: docsAfterFirst } = await admin.from("documents").select("id").eq("patient_id", patientId);
    check("document count unchanged after Add Attempt", (docsAfterFirst ?? []).length === documentCountBefore);

    // ---- add a second attempt with different recipient/MD; earlier attempt must be untouched ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    check(
      "attempt #2 form prefills recipient/MD from the document, not the previous attempt",
      (await page.locator('input[name="md_name"]').inputValue()) === DOC.md_name &&
        (await page.locator('input[name="recipient_name"]').inputValue()) === DOC.recipient_name,
    );
    await page.locator('select[name="recipient_type"]').selectOption(ATTEMPT2.recipientType);
    await page.locator('input[name="recipient_name"]').fill(ATTEMPT2.recipientName);
    await page.locator('input[name="recipient_fax"]').fill(ATTEMPT2.recipientFax);
    await page.locator('input[name="md_name"]').fill("");
    await page.locator('input[name="md_name"]').fill(ATTEMPT2.mdName);
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForSelector("text=Add fax attempt", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    const { data: attemptsAfterSecond } = await admin
      .from("fax_attempts")
      .select("id,attempt_number,recipient_name,md_name")
      .eq("document_id", docId)
      .order("attempt_number");
    check("attempt count increased by exactly one (now two total)", (attemptsAfterSecond ?? []).length === 2);
    const first = attemptsAfterSecond?.find((a) => a.attempt_number === 1);
    const second = attemptsAfterSecond?.find((a) => a.attempt_number === 2);
    check(
      "earlier attempt #1 retains its original recipient + MD after attempt #2 is added",
      first?.recipient_name === ATTEMPT1.recipientName && first?.md_name === ATTEMPT1.mdName,
    );
    check(
      "attempt #2 stored its own distinct recipient + MD",
      second?.recipient_name === ATTEMPT2.recipientName && second?.md_name === ATTEMPT2.mdName,
    );

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p14-${role}-error.png`, fullPage: true }).catch(() => {});
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
  console.log(`\nAll P3-P14 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
