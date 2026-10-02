#!/usr/bin/env node
// P3-P15 live verification: Referring MD NPI / Office Number / Fax Number on
// the patient Add/Edit form, patient detail page, and the shared
// PatientInfoCard (patient detail + document detail). Also verifies the
// document-creation fax default (Referring MD recipient prefills from the
// patient's Referring MD Fax Number, is editable, and never retroactively
// changes a saved document), NPI validation, and RLS denial for
// anonymous/role-less writes. Creates a synthetic patient + user for the
// given role, drives the real running dev server through the actual portal
// login, and cleans up everything it created. Requires SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_PUBLISHABLE_KEY in .env and the dev
// server running (set E2E_BASE_URL).
//
// Run with: node scripts/p3p15-patient-md-contact-live.mjs admin
//           node scripts/p3p15-patient-md-contact-live.mjs staff
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
  console.error("usage: node scripts/p3p15-patient-md-contact-live.mjs <admin|staff>");
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
const tag = `p3p15${role}${stamp}`.slice(0, 20);
const marker = `P3P15${role.toUpperCase()}${stamp}`;
let userId = null;
let patientId = null;
let documentId = null;

async function makeSyntheticUser() {
  const email = `synth-${tag}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic ${role}: ${error?.message}`);
  userId = data.user.id;
  await admin.from("user_logins").insert({ user_id: userId, username: tag });
  await admin.from("user_roles").insert({ user_id: userId, role });
  return { username: tag, password };
}

async function makeSyntheticPatient() {
  const { data, error } = await admin
    .from("patients")
    .insert({
      first_name: marker,
      last_name: "Synthetic",
      patient_id: `${marker}-PID`,
      date_of_birth: "1980-05-15",
      phone: "555-0111",
      insurance: `${marker} Insurance Co`,
      insurance_member_id: `${marker}-MID`,
      referring_physician: `${marker} Dr Original`,
      referring_physician_npi: "1234567893",
      referring_physician_office_phone: "555-0150",
      referring_physician_fax: "555-0100",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create synthetic patient: ${error?.message}`);
  patientId = data.id;
}

async function cleanup(cleanupErrors) {
  try {
    if (documentId) {
      await admin.from("fax_attempts").delete().eq("document_id", documentId);
      await admin.from("documents").delete().eq("id", documentId);
    }
  } catch (e) {
    cleanupErrors.push(`document cleanup failed: ${e.message}`);
  }
  try {
    if (patientId) await admin.from("patients").delete().eq("id", patientId);
  } catch (e) {
    cleanupErrors.push(`patient cleanup failed: ${e.message}`);
  }
  if (userId) {
    try {
      await admin.from("user_roles").delete().eq("user_id", userId);
    } catch {
      /* ignore */
    }
    try {
      await admin.from("user_logins").delete().eq("user_id", userId);
    } catch {
      /* ignore */
    }
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
}

async function main() {
  const cleanupErrors = [];
  const { username, password } = await makeSyntheticUser();
  await makeSyntheticPatient();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    // ---- RLS: anonymous / role-less writes to the new columns are denied ----
    const anonUpdate = await anon
      .from("patients")
      .update({ referring_physician_npi: "0000000000" })
      .eq("id", patientId);
    check(
      "anonymous Supabase client cannot update referring_physician_npi",
      !!anonUpdate.error || (anonUpdate.count ?? 0) === 0,
    );
    const { data: unaffected } = await admin
      .from("patients")
      .select("referring_physician_npi")
      .eq("id", patientId)
      .single();
    check(
      "patient NPI unchanged after denied anonymous update",
      unaffected.referring_physician_npi === "1234567893",
    );
    const anonInsert = await anon.from("patients").insert({
      first_name: "Anon",
      last_name: "ShouldFail",
      patient_id: `${marker}-ANONFAIL`,
      referring_physician_npi: "1111111111",
    });
    check("anonymous Supabase client cannot insert a patient", !!anonInsert.error);

    // ---- DB constraint: invalid NPI is rejected at the database level ----
    const badNpiInsert = await admin.from("patients").insert({
      first_name: "Bad",
      last_name: "Npi",
      patient_id: `${marker}-BADNPI`,
      referring_physician_npi: "12345",
    });
    check(
      "database rejects a non-10-digit NPI via CHECK constraint",
      !!badNpiInsert.error && /npi/i.test(badNpiInsert.error.message ?? ""),
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

    // ---- patient detail shows the shared PatientInfoCard with new fields ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check(
      "patient detail shows Patient Phone label",
      /patient phone/i.test(bodyText),
    );
    check("patient detail shows Patient Phone value", bodyText.includes("555-0111"));
    check("patient detail shows Referring MD NPI", bodyText.includes("1234567893"));
    check("patient detail shows Referring MD Office Number", bodyText.includes("555-0150"));
    check("patient detail shows Referring MD Fax Number", bodyText.includes("555-0100"));

    // ---- edit patient: change all three fields, verify persistence ----
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician_npi"]').fill("9876543210");
    await page.locator('input[name="referring_physician_office_phone"]').fill("555-0250");
    await page.locator('input[name="referring_physician_fax"]').fill("555-0200");
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("edited NPI persists after reload", bodyText.includes("9876543210"));
    check("edited Office Number persists after reload", bodyText.includes("555-0250"));
    check("edited Fax Number persists after reload", bodyText.includes("555-0200"));

    // ---- invalid NPI is rejected client-side without saving ----
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician_npi"]').fill("42");
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(500);
    bodyText = await page.locator("body").innerText();
    check(
      "invalid NPI (not 10 digits) shows a validation error and keeps the modal open",
      bodyText.includes("10 digits") && bodyText.includes("Edit patient"),
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
    const { data: afterRejectedEdit } = await admin
      .from("patients")
      .select("referring_physician_npi")
      .eq("id", patientId)
      .single();
    check(
      "rejected invalid NPI was never saved to the database",
      afterRejectedEdit.referring_physician_npi === "9876543210",
    );

    // ---- callable tel: link on Referring MD Office Number ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    const officeLink = page.locator('a[href^="tel:"]', { hasText: "555-0250" });
    check("Referring MD Office Number renders as a tel: link", (await officeLink.count()) > 0);

    // ---- document creation: Referring MD recipient prefills fax from patient ----
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const recipientType = await page.locator('select[name="recipient_type"]').inputValue();
    check('new document defaults Recipient to "Referring MD"', recipientType === "Referring MD");
    const faxField = page.locator('input[name="recipient_fax"]');
    check(
      "Recipient fax number prefills from patient's Referring MD Fax Number",
      (await faxField.inputValue()) === "555-0200",
    );
    await faxField.fill("555-0299-edited");
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);

    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    documentId = page.url().split("/documents/")[1];
    check("document created and detail page opened", !!documentId);
    bodyText = await page.locator("body").innerText();
    check(
      "saved document kept the admin's edited fax number, not the raw prefill",
      bodyText.includes("555-0299-edited"),
    );

    // ---- document detail's Patient Information card shows the fields too ----
    check(
      "document detail Patient Information card shows Referring MD NPI",
      bodyText.includes("9876543210"),
    );
    check(
      "document detail Patient Information card shows Referring MD Fax Number",
      bodyText.includes("555-0200"),
    );

    // ---- changing patient's fax afterward never touches the saved document ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician_fax"]').fill("555-0300-later");
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);

    await page.goto(`${BASE_URL}/documents/${documentId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    // Scoped to the "Document Information" card specifically -- the page's
    // separate "Patient Information" card (PatientInfoCard) legitimately
    // shows the patient's *current* fax, so checking the whole page body
    // would false-fail here once the patient's fax is edited.
    const docInfoText = await page
      .locator("h2:has-text('Document Information')")
      .locator("xpath=..")
      .innerText();
    check(
      "Document Information card still shows the saved fax, not the later patient edit",
      docInfoText.includes("555-0299-edited") && !docInfoText.includes("555-0300-later"),
    );
    const { data: docRow } = await admin
      .from("documents")
      .select("recipient_fax")
      .eq("id", documentId)
      .single();
    check(
      "DB confirms documents.recipient_fax was not backfilled from the new patient fax",
      docRow.recipient_fax === "555-0299-edited",
    );

    // ---- "Not specified" fallback for a patient with no MD contact fields ----
    const { data: blankPatient, error: blankErr } = await admin
      .from("patients")
      .insert({
        first_name: `${marker}Blank`,
        last_name: "Fields",
        patient_id: `${marker}-BLANK`,
      })
      .select("id")
      .single();
    if (blankErr || !blankPatient) throw new Error(`failed to create blank patient: ${blankErr?.message}`);
    await page.goto(`${BASE_URL}/patients/${blankPatient.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker}Blank`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check(
      '"Not specified" shown for empty Referring MD NPI/Office/Fax',
      bodyText.includes("Not specified"),
    );
    await admin.from("patients").delete().eq("id", blankPatient.id);

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p15-${role}-error.png`, fullPage: true }).catch(() => {});
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
  console.log(`\nAll P3-P15 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
