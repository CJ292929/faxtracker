#!/usr/bin/env node
// P3-P5 live workflow walkthrough: for a given role ("admin" or "staff"),
// creates a synthetic patient + user, logs into the real running dev server
// through the actual portal login form, creates a document with its MD,
// adds an attachment, records fax attempts (including edge cases for
// required-field validation), reopens the document, and compares the
// displayed status/history against direct DB reads. Cleans up everything
// it created. Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and
// the dev server running (set E2E_BASE_URL, default http://localhost:8082).
//
// Run with: node scripts/p3p5-document-fax-attempt-live.mjs admin
//           node scripts/p3p5-document-fax-attempt-live.mjs staff
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8082";
const role = process.argv[2];
if (role !== "admin" && role !== "staff") {
  console.error("usage: node scripts/p3p5-document-fax-attempt-live.mjs <admin|staff>");
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
const stamp = Date.now();
const tag = `p3p5${role}${stamp}`.slice(0, 20);
const marker = `P3P5${role.toUpperCase()}${stamp}`;
const uploadPath = `./p3p5-upload-${stamp}.pdf`;
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
      referring_physician: `${marker} Dr Referring`,
      referring_physician_fax: "555-0100",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create synthetic patient: ${error?.message}`);
  patientId = data.id;
}

function buildUploadFile() {
  writeFileSync(uploadPath, `%PDF-1.4 synthetic test file ${marker}\n`);
}

async function cleanup(cleanupErrors) {
  try {
    if (documentId) {
      await admin.from("fax_attempts").delete().eq("document_id", documentId);
      await admin.from("document_files").delete().eq("document_id", documentId);
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
  try {
    unlinkSync(uploadPath);
  } catch {
    /* already gone */
  }
}

async function main() {
  const cleanupErrors = [];
  const { username, password } = await makeSyntheticUser();
  await makeSyntheticPatient();
  buildUploadFile();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    // ---- login ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    // ---- open synthetic patient ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: "networkidle" });
    await page.waitForSelector(`text=${marker} Synthetic`, { timeout: 15000 });
    check(`${role} can open the synthetic patient record`, true);

    // ---- Step 1: create document + document-level MD ----
    await page.getByRole("button", { name: "Add Document / Fax" }).click();
    await page.waitForSelector("text=Add document / fax");
    await page.locator('input[placeholder="Doctor for this document"]').fill(`${marker} MD Name`);
    await page.getByRole("button", { name: "Save Fax Record" }).click();
    await page.waitForTimeout(1200);

    // find and open the created document
    await page.getByRole("link", { name: "Initial Evaluation" }).first().click();
    await page.waitForSelector("text=Document Information", { timeout: 15000 });
    const url = page.url();
    documentId = url.split("/documents/")[1];
    check("document detail page opened and documentId captured", !!documentId);

    // ---- Step 2: add an attachment ----
    await page.getByRole("button", { name: "Update Upload" }).click();
    await page.waitForSelector("text=Document upload");
    await page.locator('input[type="file"]').setInputFiles(uploadPath);
    await page.locator('select[name="uploaded"]').selectOption("No");
    await page.getByRole("button", { name: "Save Upload Status" }).click();
    await page.waitForSelector("text=ATTACHED FILES", { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check(
      `attached file "${uploadPath.split("/").pop()}" appears on the document`,
      bodyText.includes(uploadPath.split("/").pop()),
    );
    check(
      "no uncaught page errors while saving the upload (regression guard for the currentTarget-after-await bug)",
      pageErrors.length === 0,
    );
    if (pageErrors.length) console.log("page errors:", pageErrors);

    // ---- Step 3a: fax attempt with a FAILURE status and NO failure reason ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    await page.locator('select[name="status"]').selectOption("Failed");
    // deliberately leave failure_reason blank
    const saveBtn = page.getByRole("button", { name: "Save Attempt" });
    await saveBtn.click();
    await page.waitForTimeout(1200);
    bodyText = await page.locator("body").innerText();
    const failureAttemptModalStillOpen = bodyText.includes("Add fax attempt");
    check(
      "attempt form requires a failure reason when status is Failed (should still show the modal / an error)",
      failureAttemptModalStillOpen,
    );
    if (failureAttemptModalStillOpen) {
      // close it out validly so the flow can continue
      await page.locator('select[name="failure_reason"]').selectOption("Busy");
      await page.getByRole("button", { name: "Save Attempt" }).click();
      await page.waitForTimeout(1200);
    }

    // ---- Step 3b: fax attempt with Sent Successfully and NO confirmation number ----
    await page.getByRole("button", { name: "Add Attempt" }).first().click();
    await page.waitForSelector("text=Add fax attempt");
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.getByRole("button", { name: "Save Attempt" }).click();
    await page.waitForTimeout(1200);
    bodyText = await page.locator("body").innerText();
    const sentAttemptModalStillOpen = bodyText.includes("Add fax attempt");
    note(
      `Sent Successfully attempt ${sentAttemptModalStillOpen ? "was blocked" : "was accepted"} with confirmation number left blank`,
    );
    if (sentAttemptModalStillOpen) {
      await page.locator('input[name="confirmation_number"]').fill(`${marker}-CONF`);
      await page.getByRole("button", { name: "Save Attempt" }).click();
      await page.waitForTimeout(1200);
    }

    // ---- Step 4: reopen and verify against DB ----
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=Fax Attempt History", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();

    const { data: dbAttempts } = await admin
      .from("fax_attempts")
      .select("*")
      .eq("document_id", documentId)
      .order("attempt_number");
    const { data: dbFiles } = await admin
      .from("document_files")
      .select("*")
      .eq("document_id", documentId);
    check(
      `DB has ${dbAttempts?.length ?? 0} fax_attempts row(s) for this document (expect 2)`,
      (dbAttempts?.length ?? 0) === 2,
    );
    check("DB has 1 document_files row for this document", (dbFiles?.length ?? 0) === 1);
    check(
      "UI attempt history shows the same attempt count as the DB",
      bodyText.includes(`Attempt #${dbAttempts?.length ?? -1}`) ||
        (dbAttempts ?? []).every((a) => bodyText.includes(`Attempt #${a.attempt_number}`)),
    );
    for (const a of dbAttempts ?? []) {
      check(
        `UI shows attempt #${a.attempt_number} status "${a.status}"`,
        bodyText.includes(a.status),
      );
      if (a.confirmation_number) {
        check(
          `UI shows attempt #${a.attempt_number} confirmation number`,
          bodyText.includes(a.confirmation_number),
        );
      }
    }
    check("UI shows the document MD name", bodyText.includes(`${marker} MD Name`));
    check(
      "UI document status derivation matches expectation (Awaiting Response, since Sent Successfully exists but not received)",
      bodyText.includes("Awaiting Response"),
    );

    // ---- Step 5: attempt to correct/edit an attempt via the UI ----
    const editAttemptControlCount = await page
      .getByRole("button", { name: /edit attempt/i })
      .count();
    check(
      "no per-attempt edit/correct control exists in the UI (expected — reported, not fixed)",
      editAttemptControlCount === 0,
    );

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: `p3p5-${role}-error.png`, fullPage: true }).catch(() => {});
    console.log(
      "FLOW ERROR, body text:",
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "<unavailable>")
      ).slice(0, 1200),
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
  console.log(`\nAll P3-P5 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
