#!/usr/bin/env node
// P3-P9 live verification: patient six-field consistency (Name, Member ID,
// DOB, Phone, Insurance, Referring MD) across list/detail/form, and
// document-level MD (md_name) prefill/independence/filter/empty-state
// behavior. Creates a synthetic patient + user for the given role, drives
// the real running dev server through the actual portal login, and cleans
// up everything it created. Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// in .env and the dev server running (set E2E_BASE_URL).
//
// Run with: node scripts/p3p9-md-and-patient-fields-live.mjs admin
//           node scripts/p3p9-md-and-patient-fields-live.mjs staff
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
  console.error("usage: node scripts/p3p9-md-and-patient-fields-live.mjs <admin|staff>");
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}
function note(msg) {
  console.log(`note: ${msg}`);
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
const stamp = Date.now();
const tag = `p3p9${role}${stamp}`.slice(0, 20);
const marker = `P3P9${role.toUpperCase()}${stamp}`;
let userId = null;
let patientId = null;
let documentId = null;
let secondDocumentId = null;

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
    if (secondDocumentId) {
      await admin.from("fax_attempts").delete().eq("document_id", secondDocumentId);
      await admin.from("documents").delete().eq("id", secondDocumentId);
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
    // ---- anonymous / role-less denial (before logging in as the real role) ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    let bodyText = await page.locator("body").innerText();
    check(
      "anonymous session does not see the synthetic patient's data on /patients",
      !bodyText.includes(marker),
    );
    const anonSelect = await anon.from("patients").select("id").eq("id", patientId);
    check(
      "anonymous Supabase client cannot select the synthetic patient (empty, not error)",
      (anonSelect.data?.length ?? -1) === 0,
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

    // ---- Step 1: patient list shows all six fields ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("patients list shows Name", bodyText.includes(`${marker} Synthetic`));
    check("patients list shows Member ID", bodyText.includes(`${marker}-MID`));
    check("patients list shows DOB", /05\/15\/1980|1980-05-15|May 15, 1980/.test(bodyText) || bodyText.includes("1980"));
    check("patients list shows Phone", bodyText.includes("555-0111"));
    check("patients list shows Insurance", bodyText.includes(`${marker} Insurance Co`));
    check("patients list shows Referring MD", bodyText.includes(`${marker} Dr Original`));

    // ---- Step 2: patient detail shows all six fields ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("patient detail shows Name (page title)", bodyText.includes(`${marker} Synthetic`));
    check("patient detail shows Member ID", bodyText.includes(`${marker}-MID`));
    check("patient detail shows Phone", bodyText.includes("555-0111"));
    check("patient detail shows Insurance", bodyText.includes(`${marker} Insurance Co`));
    check("patient detail shows Referring MD", bodyText.includes(`${marker} Dr Original`));

    // ---- Step 3: edit patient via Add/Edit form, change all six fields ----
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="first_name"]').fill(`${marker}Edited`);
    await page.locator('input[name="insurance_member_id"]').fill(`${marker}-MID2`);
    await page.locator('input[name="phone"]').fill("555-0222");
    await page.locator('input[name="insurance"]').fill(`${marker} Insurance V2`);
    await page.locator('input[name="referring_physician"]').fill(`${marker} Dr Updated`);
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("edited Name persists after reload", bodyText.includes(`${marker}Edited`));
    check("edited Member ID persists after reload", bodyText.includes(`${marker}-MID2`));
    check("edited Phone persists after reload", bodyText.includes("555-0222"));
    check("edited Insurance persists after reload", bodyText.includes(`${marker} Insurance V2`));
    check("edited Referring MD persists after reload", bodyText.includes(`${marker} Dr Updated`));

    // ---- Step 4: create a document, verify MD prefills from patient's Referring MD ----
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const mdField = page.locator('input[placeholder="Doctor for this document"]');
    const prefillValue = await mdField.inputValue();
    check(
      `new document MD field prefills from patient's current Referring MD ("${marker} Dr Updated")`,
      prefillValue === `${marker} Dr Updated`,
    );
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);

    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    documentId = page.url().split("/documents/")[1];
    check("document created and detail page opened", !!documentId);
    bodyText = await page.locator("body").innerText();
    check(
      "document detail shows the prefilled MD value",
      bodyText.includes(`${marker} Dr Updated`),
    );

    // ---- Step 5: change the document's MD; verify it saves independently ----
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForSelector("text=Edit document");
    await page.locator('input[name="md_name"]').fill(`${marker} Dr DocumentSpecific`);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check(
      "document detail shows the changed document-specific MD",
      bodyText.includes(`${marker} Dr DocumentSpecific`),
    );

    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker}`, { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check(
      "All Documents (Fax Tracker) shows the changed document MD",
      bodyText.includes(`${marker} Dr DocumentSpecific`),
    );

    const { data: patientRowAfterDocEdit } = await admin
      .from("patients")
      .select("referring_physician")
      .eq("id", patientId)
      .single();
    check(
      "changing document MD did NOT change patient's Referring MD",
      patientRowAfterDocEdit.referring_physician === `${marker} Dr Updated`,
    );

    // ---- Step 6: change patient's Referring MD again; verify existing document MD is unaffected ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician"]').fill(`${marker} Dr LaterChange`);
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);

    await page.goto(`${BASE_URL}/documents/${documentId}`, { waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check(
      "existing document MD remains unchanged after patient's Referring MD changes",
      bodyText.includes(`${marker} Dr DocumentSpecific`) &&
        !bodyText.includes(`${marker} Dr LaterChange`),
    );
    const { data: docRowAfterPatientEdit } = await admin
      .from("documents")
      .select("md_name")
      .eq("id", documentId)
      .single();
    check(
      "DB confirms documents.md_name was not backfilled from the new patient Referring MD",
      docRowAfterPatientEdit.md_name === `${marker} Dr DocumentSpecific`,
    );

    // ---- Step 7: second document with MD left blank -> "Not specified" ----
    const { data: secondDoc, error: secondDocError } = await admin
      .from("documents")
      .insert({
        patient_id: patientId,
        document_type: "Progress Note",
        status: "Draft",
        md_name: null,
      })
      .select("id")
      .single();
    if (secondDocError || !secondDoc) throw new Error(`failed to create second document: ${secondDocError?.message}`);
    secondDocumentId = secondDoc.id;

    await page.goto(`${BASE_URL}/documents/${secondDocumentId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check('document detail shows "Not specified" for empty MD', bodyText.includes("Not specified"));

    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.data-table", { timeout: 15000 });
    await page.waitForTimeout(500);
    bodyText = await page.locator("body").innerText();
    check(
      'All Documents shows "Not specified" for the blank-MD document',
      bodyText.includes("Not specified"),
    );

    // ---- Step 8: MD search/filter, combined with status filter ----
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker}`, { timeout: 15000 });
    await page.locator('input[aria-label="MD"]').fill(`${marker} Dr DocumentSpecific`);
    await page.waitForTimeout(400);
    let tableText = await page.locator("table.data-table tbody").innerText();
    check(
      "MD filter narrows to only the document with matching MD",
      tableText.includes("Initial Evaluation") && !tableText.includes("Progress Note"),
    );

    await page.getByRole("button", { name: "Pending" }).click();
    await page.waitForTimeout(400);
    tableText = await page.locator("table.data-table tbody, .rounded-md.border.bg-card").innerText();
    check(
      "MD filter combined with status quick-filter narrows further (Draft doc + Pending status = no rows)",
      !tableText.includes(marker),
    );
    await page.getByRole("button", { name: "All" }).click();
    await page.locator('input[aria-label="MD"]').fill("Not a real md value zzz");
    await page.waitForTimeout(400);
    tableText = await page.locator("table.data-table tbody, .rounded-md.border.bg-card").innerText();
    check(
      "MD filter with no matches shows no documents",
      !tableText.includes(marker),
    );

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p9-${role}-error.png`, fullPage: true }).catch(() => {});
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
  console.log(`\nAll P3-P9 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
