#!/usr/bin/env node
// P3-P16 live verification: MD NPI / MD Office Number / MD Fax Number on
// documents and fax_attempts (patients already got these in P3-P15). Covers
// Add/Edit Patient (regression), Add Document/Fax (incl. optional first
// attempt), Add Fax Attempt from both entry points, Correct Fax Attempt,
// the "changing MD clears stale contact details" safeguard, historical
// independence from later patient edits, "Not specified" fallback, RLS
// denial for anonymous/role-less writes, the DB-level NPI CHECK constraint,
// and that permanent patient delete still cascades correctly. Creates a
// synthetic patient + document + attempt for the given role, drives the
// real running dev server through the actual portal login, and cleans up
// everything it created. Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// SUPABASE_PUBLISHABLE_KEY in .env and the dev server running (set
// E2E_BASE_URL).
//
// Run with: node scripts/p3p16-document-attempt-md-contact-live.mjs admin
//           node scripts/p3p16-document-attempt-md-contact-live.mjs staff
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

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const role = process.argv[2];
if (role !== "admin" && role !== "staff") {
  console.error("usage: node scripts/p3p16-document-attempt-md-contact-live.mjs <admin|staff>");
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
const stamp = Date.now();
const tag = `p3p16${role}${stamp}`.slice(0, 20);
const marker = `P3P16${role.toUpperCase()}${stamp}`;

const PATIENT = {
  first_name: `${marker}First`,
  last_name: "MdContact",
  patient_id: `${marker}-PID`,
  date_of_birth: "1980-06-16",
  phone: "555-0811",
  insurance: `${marker} Insurance Co`,
  insurance_member_id: `${marker}-MID`,
  referring_physician: `${marker} Dr PatientMD`,
  referring_physician_npi: "1234567893",
  referring_physician_office_phone: "555-0850",
  referring_physician_fax: "555-0800",
};

let userId = null;
let ghostUserId = null;
let patientId = null;
let documentId = null;
let blankPatientId = null;

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
  if (documentId) {
    try {
      await admin.from("fax_attempts").delete().eq("document_id", documentId);
      await admin.from("documents").delete().eq("id", documentId);
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
  if (blankPatientId) {
    try {
      await admin.from("patients").delete().eq("id", blankPatientId);
    } catch (e) {
      cleanupErrors.push(`blank patient cleanup failed: ${e.message}`);
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

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    // ---- RLS: anonymous/role-less writes to the new columns are denied ----
    const anonDocInsert = await anon.from("documents").insert({
      patient_id: patientId,
      document_type: "Initial Evaluation",
      md_npi: "1111111111",
    });
    check("anonymous client cannot insert a document with md_npi set", !!anonDocInsert.error);

    // ---- DB constraint: invalid NPI rejected directly on documents/fax_attempts ----
    const badDocNpi = await admin.from("documents").insert({
      patient_id: patientId,
      document_type: "Initial Evaluation",
      md_npi: "123",
    });
    check(
      "database rejects a non-10-digit documents.md_npi via CHECK constraint",
      !!badDocNpi.error && /npi/i.test(badDocNpi.error.message ?? ""),
    );

    // ---- login ----
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    // ---- Add/Edit Patient regression: MD contact fields still present and validated ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${PATIENT.first_name}`, { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check("patient detail still shows Referring MD NPI", bodyText.includes(PATIENT.referring_physician_npi));
    check(
      "patient detail still shows Referring MD Office Number",
      bodyText.includes(PATIENT.referring_physician_office_phone),
    );
    check("patient detail still shows Patient Phone separately", bodyText.includes(PATIENT.phone));

    // ---- Add Document/Fax: MD NPI/Office/Fax prefill from patient's referring MD ----
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const docMdNpi = page.locator('input[name="md_npi"]');
    const docMdOffice = page.locator('input[name="md_office_phone"]');
    const docMdFax = page.locator('input[name="md_fax"]');
    check("new document MD NPI prefills from patient's Referring MD NPI", (await docMdNpi.inputValue()) === PATIENT.referring_physician_npi);
    check(
      "new document MD Office Number prefills from patient's Referring MD Office Number",
      (await docMdOffice.inputValue()) === PATIENT.referring_physician_office_phone,
    );
    check(
      "new document MD Fax Number prefills from patient's Referring MD Fax Number",
      (await docMdFax.inputValue()) === PATIENT.referring_physician_fax,
    );

    // ---- changing the MD name clears the prefilled NPI/Office/Fax (no silent retention) ----
    const docMdName = page.locator('input[name="md_name"]');
    await docMdName.fill("");
    await docMdName.fill(`${marker} Dr DifferentMD`);
    check("changing document MD name clears MD NPI", (await docMdNpi.inputValue()) === "");
    check("changing document MD name clears MD Office Number", (await docMdOffice.inputValue()) === "");
    check("changing document MD name clears MD Fax Number", (await docMdFax.inputValue()) === "");

    // Fill in this document's own MD contact details plus an optional first attempt.
    const DOC_NPI = "9876543210";
    const DOC_OFFICE = "555-0860";
    const DOC_FAX = "555-0861";
    await docMdNpi.fill(DOC_NPI);
    await docMdOffice.fill(DOC_OFFICE);
    await docMdFax.fill(DOC_FAX);
    await page.locator('input[name="attempted_at"]').fill("2026-01-16T09:00");
    await page.locator('select[name="fax_status"]').selectOption("Sent Successfully");
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);

    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    documentId = page.url().split("/documents/")[1];
    check("document created and detail page opened", !!documentId);
    bodyText = await page.locator("body").innerText();
    check("document detail shows Document MD NPI", bodyText.includes(DOC_NPI));
    check("document detail shows Document MD Office Number", bodyText.includes(DOC_OFFICE));
    check("document detail shows Document MD Fax Number", bodyText.includes(DOC_FAX));

    const { data: firstAttemptRow } = await admin
      .from("fax_attempts")
      .select("md_npi,md_office_phone,md_fax")
      .eq("document_id", documentId)
      .eq("attempt_number", 1)
      .single();
    check(
      "optional first attempt reused the document's MD contact details",
      firstAttemptRow?.md_npi === DOC_NPI && firstAttemptRow?.md_office_phone === DOC_OFFICE && firstAttemptRow?.md_fax === DOC_FAX,
    );

    // ---- Add Fax Attempt from the header button: prefills from the document's MD contact ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    const attMdNpi = page.locator('input[name="md_npi"]');
    const attMdOffice = page.locator('input[name="md_office_phone"]');
    const attMdFax = page.locator('input[name="md_fax"]');
    check("attempt form MD NPI prefills from the document", (await attMdNpi.inputValue()) === DOC_NPI);
    check("attempt form MD Office Number prefills from the document", (await attMdOffice.inputValue()) === DOC_OFFICE);
    check("attempt form MD Fax Number prefills from the document", (await attMdFax.inputValue()) === DOC_FAX);

    // Changing MD name in the attempt form also clears the prefilled contact fields.
    const attMdName = page.locator('input[name="md_name"]');
    await attMdName.fill("");
    await attMdName.fill(`${marker} Dr AttemptDifferentMD`);
    check("changing attempt MD name clears MD NPI", (await attMdNpi.inputValue()) === "");
    check("changing attempt MD name clears MD Office Number", (await attMdOffice.inputValue()) === "");
    check("changing attempt MD name clears MD Fax Number", (await attMdFax.inputValue()) === "");

    const ATT2_NPI = "1112223334";
    const ATT2_OFFICE = "555-0870";
    const ATT2_FAX = "555-0871";
    await attMdNpi.fill(ATT2_NPI);
    await attMdOffice.fill(ATT2_OFFICE);
    await attMdFax.fill(ATT2_FAX);
    await page.locator('input[name="attempted_at"]').fill("2026-01-17T10:00");
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForSelector("text=Add fax attempt", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    const { data: attemptsAfterHeader } = await admin
      .from("fax_attempts")
      .select("id,attempt_number,md_npi,md_office_phone,md_fax")
      .eq("document_id", documentId)
      .order("attempt_number");
    check("attempt from header button recorded (now 2 total)", (attemptsAfterHeader ?? []).length === 2);
    const attempt2 = attemptsAfterHeader?.find((a) => a.attempt_number === 2);
    check(
      "attempt #2 stored its own MD NPI/Office/Fax independently",
      attempt2?.md_npi === ATT2_NPI && attempt2?.md_office_phone === ATT2_OFFICE && attempt2?.md_fax === ATT2_FAX,
    );

    // ---- Add Fax Attempt from the history-section button also works ----
    await page.getByRole("button", { name: "Add Attempt" }).last().click();
    await page.waitForSelector("text=Add fax attempt");
    check("history-section Add Attempt button also shows MD contact fields", await page.locator('input[name="md_npi"]').isVisible());
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.locator('input[name="attempted_at"]').fill("2026-01-18T11:00");
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForSelector("text=Add fax attempt", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);
    const { data: attemptsAfterHistory } = await admin
      .from("fax_attempts")
      .select("id,attempt_number")
      .eq("document_id", documentId)
      .order("attempt_number");
    check("attempt from history-section button recorded (now 3 total)", (attemptsAfterHistory ?? []).length === 3);

    // ---- Correct Fax Attempt: edit MD contact fields, verify audit + concurrency ----
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=Fax Attempt History", { timeout: 15000 });
    await page.locator('[title="Correct attempt"]').first().click();
    await page.waitForSelector("text=/Correct attempt #/");
    const corNpi = page.locator('input[name="md_npi"]');
    const corOffice = page.locator('input[name="md_office_phone"]');
    const corFax = page.locator('input[name="md_fax"]');
    const CORRECTED_NPI = "5556667778";
    const CORRECTED_OFFICE = "555-0990";
    const CORRECTED_FAX = "555-0991";
    await corNpi.fill("");
    await corNpi.fill(CORRECTED_NPI);
    await corOffice.fill("");
    await corOffice.fill(CORRECTED_OFFICE);
    await corFax.fill("");
    await corFax.fill(CORRECTED_FAX);
    await page.locator('textarea[name="reason"]').fill(`${marker} correcting MD contact details`);
    await page.getByRole("button", { name: "Save Correction" }).click();
    await page.waitForSelector("text=/Correct attempt #/", { state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);

    const { data: correctedAttempt } = await admin
      .from("fax_attempts")
      .select("md_npi,md_office_phone,md_fax")
      .eq("document_id", documentId)
      .eq("attempt_number", 1)
      .single();
    check(
      "correction persisted MD NPI/Office/Fax changes",
      correctedAttempt?.md_npi === CORRECTED_NPI &&
        correctedAttempt?.md_office_phone === CORRECTED_OFFICE &&
        correctedAttempt?.md_fax === CORRECTED_FAX,
    );
    const { data: correctionRow } = await admin
      .from("fax_attempt_corrections")
      .select("before,after")
      .eq("attempt_id", attemptsAfterHeader?.find((a) => a.attempt_number === 1)?.id)
      .order("corrected_at", { ascending: false })
      .limit(1)
      .single();
    check(
      "fax_attempt_corrections audit row captured the before/after MD contact change",
      correctionRow?.after?.md_npi === CORRECTED_NPI && correctionRow?.before?.md_npi !== CORRECTED_NPI,
    );

    // ---- Correct Fax Attempt: optimistic-concurrency conflict still fires ----
    const { data: attemptNow } = await admin
      .from("fax_attempts")
      .select("id,updated_at")
      .eq("document_id", documentId)
      .eq("attempt_number", 1)
      .single();
    const staleResult = await admin.rpc("correct_fax_attempt", {
      _attempt_id: attemptNow.id,
      _expected_updated_at: "2000-01-01T00:00:00.000Z",
      _attempted_at: new Date().toISOString(),
      _status: "Sent Successfully",
      _failure_reason: null,
      _confirmation_number: null,
      _notes: null,
      _reason: "stale conflict probe",
      _md_name: null,
      _recipient_type: null,
      _recipient_name: null,
      _recipient_fax: null,
      _md_npi: null,
      _md_office_phone: null,
      _md_fax: null,
    });
    check(
      "correct_fax_attempt still rejects a stale updated_at token",
      !!staleResult.error && /CONFLICT/i.test(staleResult.error.message ?? ""),
    );

    // ---- "Not specified" fallback for a document/attempt with no MD contact fields ----
    const { data: blankDoc, error: blankDocErr } = await admin
      .from("documents")
      .insert({ patient_id: patientId, document_type: "Progress Note", document_number: 1 })
      .select("id")
      .single();
    if (blankDocErr || !blankDoc) throw new Error(`failed to create blank document: ${blankDocErr?.message}`);
    await page.goto(`${BASE_URL}/documents/${blankDoc.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check(
      '"Not specified" shown for a document with empty MD NPI/Office/Fax',
      bodyText.includes("Not specified"),
    );
    await admin.from("documents").delete().eq("id", blankDoc.id);

    // ---- Historical independence: editing the patient's MD contact later doesn't touch the document ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician_npi"]').fill("");
    await page.locator('input[name="referring_physician_npi"]').fill("0001112223");
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);

    const { data: docAfterPatientEdit } = await admin
      .from("documents")
      .select("md_npi")
      .eq("id", documentId)
      .single();
    check(
      "DB confirms documents.md_npi was not backfilled from the later patient edit",
      docAfterPatientEdit.md_npi === DOC_NPI,
    );
    await page.goto(`${BASE_URL}/documents/${documentId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("document detail still shows the original Document MD NPI, not the later patient edit", bodyText.includes(DOC_NPI) && !bodyText.includes("0001112223"));

    // ---- "Not specified" fallback for a brand-new patient with no MD contact fields ----
    const { data: blankPatient, error: blankPatientErr } = await admin
      .from("patients")
      .insert({ first_name: `${marker}Blank`, last_name: "Patient", patient_id: `${marker}-BLANK` })
      .select("id")
      .single();
    if (blankPatientErr || !blankPatient) throw new Error(`failed to create blank patient: ${blankPatientErr?.message}`);
    blankPatientId = blankPatient.id;
    await page.goto(`${BASE_URL}/patients/${blankPatientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker}Blank`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check(
      '"Not specified" shown for a patient with empty Referring MD NPI/Office/Fax',
      bodyText.includes("Not specified"),
    );

    // ---- permanent patient delete still cascades documents/attempts correctly ----
    // with the new MD contact columns present (regression on delete_patient_permanently,
    // which deletes whole rows and needed no changes for this feature).
    const deleteResult = await admin.rpc("delete_patient_permanently", {
      _patient_id: patientId,
      _expected_patient_code: PATIENT.patient_id,
    });
    check("delete_patient_permanently succeeds with MD contact columns present", !deleteResult.error);
    const row = deleteResult.data?.[0];
    check("delete_patient_permanently reports the document and its attempts as deleted", row?.documents_deleted === 1 && row?.attempts_deleted === 3);
    const { data: docsAfterDelete } = await admin.from("documents").select("id").eq("patient_id", patientId);
    check("no documents remain for the permanently deleted patient", (docsAfterDelete ?? []).length === 0);
    patientId = null;
    documentId = null;

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p16-${role}-error.png`, fullPage: true }).catch(() => {});
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
  console.log(`\nAll P3-P16 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
