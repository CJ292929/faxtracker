#!/usr/bin/env node
// P3-P10 live verification: independent per-document MD (documents.md_name)
// via the searchable MD selector. Creates a synthetic patient + user for the
// given role, drives the real running dev server through the actual portal
// login, and cleans up everything it created. Requires SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY in .env and the dev server running (set
// E2E_BASE_URL).
//
// Run with: node scripts/p3p10-per-document-md-live.mjs admin
//           node scripts/p3p10-per-document-md-live.mjs staff
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
  console.error("usage: node scripts/p3p10-per-document-md-live.mjs <admin|staff>");
  process.exit(1);
}

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p10${role}${stamp}`.slice(0, 20);
const marker = `P3P10${role.toUpperCase()}${stamp}`;
const drRivera = `${marker} Dr Rivera`;
const drLonzaga = `${marker} Dr Lonzaga`;
const drSantos = `${marker} Dr Santos`;
let userId = null;
let patientId = null;
let initialEvalId = null;
let progressReportId = null;
let thirdDocId = null;

async function makeSyntheticUser() {
  const email = `synth-${tag}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
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
      referring_physician: drRivera,
      referring_physician_fax: "555-0100",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create synthetic patient: ${error?.message}`);
  patientId = data.id;
}

async function cleanup(cleanupErrors) {
  for (const docId of [initialEvalId, progressReportId, thirdDocId]) {
    if (!docId) continue;
    try {
      await admin.from("fax_attempts").delete().eq("document_id", docId);
      await admin.from("documents").delete().eq("id", docId);
    } catch (e) {
      cleanupErrors.push(`document cleanup failed: ${e.message}`);
    }
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
    // ---- login ----
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    // ---- Step 1: patient Referring MD is Dr. Rivera (set at creation) ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check("patient detail shows Referring MD Dr. Rivera", bodyText.includes(drRivera));

    // ---- Step 2: create Initial Evaluation, confirm MD combobox prefills Dr. Rivera ----
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const mdInput = page.locator('input[name="md_name"]');
    check("new Initial Evaluation MD field prefills with patient's Referring MD (Dr. Rivera)", (await mdInput.inputValue()) === drRivera);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    initialEvalId = page.url().split("/documents/")[1];
    bodyText = await page.locator("body").innerText();
    check("Initial Evaluation detail shows Dr. Rivera", bodyText.includes(drRivera));

    // ---- Step 3: create Progress Note, replace prefilled MD with Dr. Lonzaga ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    await page.locator('[role="dialog"] select.field').first().selectOption("Progress Note");
    const mdInput2 = page.locator('input[name="md_name"]');
    check("second document MD field also prefills with Dr. Rivera before edit", (await mdInput2.inputValue()) === drRivera);
    await mdInput2.fill("");
    await mdInput2.fill(drLonzaga);
    // Recipient name is a distinct field (fax target, can be non-doctor) and is left at its own
    // default here on purpose, to prove it is independent of the MD field rather than merged with it.
    await page.locator('input[name="recipient_name"]').fill(`${marker} Some Insurance Co`);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("link", { name: "Progress Note" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    progressReportId = page.url().split("/documents/")[1];
    bodyText = await page.locator("body").innerText();
    check(
      "Progress Note detail shows Dr. Lonzaga as MD and the distinct recipient name, not Dr. Rivera",
      bodyText.includes(drLonzaga) && bodyText.includes(`${marker} Some Insurance Co`) && !bodyText.includes(drRivera),
    );

    // ---- Step 4: reload, confirm each document still shows its own doctor ----
    await page.goto(`${BASE_URL}/documents/${initialEvalId}`, { waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("after reload, Initial Evaluation still shows Dr. Rivera", bodyText.includes(drRivera));
    await page.goto(`${BASE_URL}/documents/${progressReportId}`, { waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("after reload, Progress Note still shows Dr. Lonzaga", bodyText.includes(drLonzaga));

    // ---- Step 5: change patient Referring MD to Dr. Santos ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit Patient" }).click();
    await page.waitForSelector("text=Edit patient");
    await page.locator('input[name="referring_physician"]').fill(drSantos);
    await page.getByRole("button", { name: "Save Patient" }).click();
    await page.waitForTimeout(1000);

    // ---- Step 6: existing documents unaffected; a new document defaults to Dr. Santos ----
    await page.goto(`${BASE_URL}/documents/${initialEvalId}`, { waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("Initial Evaluation MD remains Dr. Rivera after patient MD change", bodyText.includes(drRivera) && !bodyText.includes(drSantos));
    await page.goto(`${BASE_URL}/documents/${progressReportId}`, { waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("Progress Note MD remains Dr. Lonzaga after patient MD change", bodyText.includes(drLonzaga) && !bodyText.includes(drSantos));

    const { data: doc1AfterPatientEdit } = await admin.from("documents").select("md_name").eq("id", initialEvalId).single();
    check("DB confirms Initial Evaluation md_name is still Dr. Rivera (no backfill)", doc1AfterPatientEdit.md_name === drRivera);
    const { data: doc2AfterPatientEdit } = await admin.from("documents").select("md_name").eq("id", progressReportId).single();
    check("DB confirms Progress Note md_name is still Dr. Lonzaga (no backfill)", doc2AfterPatientEdit.md_name === drLonzaga);

    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    const mdInput3 = page.locator('input[name="md_name"]');
    check("a new document created after the patient MD change prefills with Dr. Santos", (await mdInput3.inputValue()) === drSantos);

    // ---- Step 6b: suggestions include patient's current MD and prior document MDs ----
    await mdInput3.fill("");
    await mdInput3.fill(marker);
    await page.waitForTimeout(200);
    const suggestionTexts = await page.locator("ul li button").allInnerTexts();
    check("MD suggestions include Dr. Rivera (prior document)", suggestionTexts.includes(drRivera));
    check("MD suggestions include Dr. Lonzaga (prior document)", suggestionTexts.includes(drLonzaga));
    check("MD suggestions include Dr. Santos (patient's current Referring MD)", suggestionTexts.includes(drSantos));
    await page.locator("ul li button", { hasText: drRivera }).click();
    check("clicking a suggestion fills the MD field", (await mdInput3.inputValue()) === drRivera);
    await page.getByRole("button", { name: "Cancel" }).click();

    // ---- Step 7: edit one document's MD; patient and other document remain unchanged ----
    await page.goto(`${BASE_URL}/documents/${initialEvalId}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForSelector("text=Edit document");
    await page.locator('input[name="md_name"]').fill(`${marker} Dr EditedOnDocument`);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1000);
    await page.reload({ waitUntil: "networkidle" });
    bodyText = await page.locator("body").innerText();
    check("edited document shows its new MD", bodyText.includes(`${marker} Dr EditedOnDocument`));

    const { data: patientAfterDocEdit } = await admin.from("patients").select("referring_physician").eq("id", patientId).single();
    check("editing a document's MD did not change the patient's Referring MD", patientAfterDocEdit.referring_physician === drSantos);
    const { data: otherDocAfterEdit } = await admin.from("documents").select("md_name").eq("id", progressReportId).single();
    check("editing one document's MD did not change the other document's MD", otherDocAfterEdit.md_name === drLonzaga);

    // ---- Step 8: MD filter returns correct documents ----
    await page.goto(`${BASE_URL}/fax-tracker`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker}`, { timeout: 15000 });
    await page.locator('input[aria-label="MD"]').fill(`${marker} Dr EditedOnDocument`);
    await page.waitForTimeout(400);
    let tableText = await page.locator("table.data-table tbody").innerText();
    check("MD filter narrows to only the edited Initial Evaluation", tableText.includes("Initial Evaluation") && !tableText.includes("Progress Note"));

    await page.locator('input[aria-label="MD"]').fill(drLonzaga);
    await page.waitForTimeout(400);
    tableText = await page.locator("table.data-table tbody").innerText();
    check("MD filter narrows to only the Progress Note (Dr. Lonzaga)", tableText.includes("Progress Note") && !tableText.includes("Initial Evaluation"));

    await page.locator('input[aria-label="MD"]').fill("");

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p10-${role}-error.png`, fullPage: true }).catch(() => {});
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
  console.log(`\nAll P3-P10 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
