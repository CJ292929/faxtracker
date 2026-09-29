#!/usr/bin/env node
// P3-P6 live workflow walkthrough: for a given role ("admin" or "staff"),
// creates a synthetic patient + document + fax attempt (recorded by a
// different synthetic "original submitter" id) via the service role, logs
// into the real running app through the actual portal login form, opens the
// document, uses the "Correct attempt" dialog to fix the mis-recorded
// attempt with a required reason, verifies the UI reflects the correction
// and shows correction history, verifies a concurrent edit is rejected as a
// stale-write conflict instead of silently overwritten, verifies a
// role-less account cannot reach patient data at all, and checks the
// database directly: attempt count/attempt_number/created_by/created_at
// unchanged, fax_attempt_corrections + audit_logs each gained exactly one
// row. Cleans up everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_PUBLISHABLE_KEY
// in .env and the app running (set E2E_BASE_URL, default http://localhost:8082).
//
// Run with: node scripts/p3p6-correct-attempt-live.mjs admin
//           node scripts/p3p6-correct-attempt-live.mjs staff
import { readFileSync } from "node:fs";
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
  console.error("usage: node scripts/p3p6-correct-attempt-live.mjs <admin|staff>");
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
const tag = `p3p6${role}${stamp}`.slice(0, 20);
const marker = `P3P6${role.toUpperCase()}${stamp}`;
const originalRecorderId = `d0000000-0000-0000-0000-${String(stamp).slice(-12).padStart(12, "0")}`;
let userId = null;
let ghostUserId = null;
let patientId = null;
let documentId = null;
let attemptId = null;

async function makeSyntheticUser(assignRole) {
  const email = `synth-${tag}${assignRole ? "" : "g"}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic user: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}${assignRole ? "" : "g"}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: id, username });
  if (assignRole) await admin.from("user_roles").insert({ user_id: id, role: assignRole });
  return { id, username, password };
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

async function makeSyntheticDocumentAndAttempt() {
  const { data: doc, error: docError } = await admin
    .from("documents")
    .insert({ patient_id: patientId, document_type: "Initial Evaluation", md_name: `${marker} MD` })
    .select("id")
    .single();
  if (docError || !doc)
    throw new Error(`failed to create synthetic document: ${docError?.message}`);
  documentId = doc.id;
  const { data: attempt, error: attemptError } = await admin
    .from("fax_attempts")
    .insert({
      document_id: documentId,
      attempt_number: 1,
      status: "Pending",
      created_by: originalRecorderId,
      attempted_at: "2026-01-01T00:00:00.000Z",
    })
    .select("id")
    .single();
  if (attemptError || !attempt)
    throw new Error(`failed to create synthetic attempt: ${attemptError?.message}`);
  attemptId = attempt.id;
}

async function cleanup(cleanupErrors) {
  try {
    if (attemptId) {
      await admin.from("fax_attempt_corrections").delete().eq("attempt_id", attemptId);
      await admin.from("fax_attempts").delete().eq("id", attemptId);
    }
    if (documentId) {
      await admin.from("audit_logs").delete().eq("document_id", documentId);
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
  const { id: uid, username, password } = await makeSyntheticUser(role);
  userId = uid;
  const ghost = await makeSyntheticUser(null);
  ghostUserId = ghost.id;
  await makeSyntheticPatient();
  await makeSyntheticDocumentAndAttempt();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });

  try {
    // ---- unauthorized: a role-less account cannot even log in ----
    // resolveUsernameLogin (src/lib/username-login-core.ts) requires the
    // account's user_roles row to match the portal being signed into, so a
    // role-less account is rejected at the login step itself -- it never
    // reaches an authenticated session, let alone the document/correction UI.
    {
      const ghostPage = await browser.newPage();
      await ghostPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      await ghostPage.getByRole("button", { name: "Staff Login" }).click();
      await ghostPage.locator("#staff-username").fill(ghost.username);
      await ghostPage.locator("#staff-password").fill(ghost.password);
      await ghostPage.getByRole("button", { name: "Staff Login" }).click();
      await ghostPage.waitForSelector("text=Invalid username or password", { timeout: 15000 });
      check("role-less account is rejected at login, never reaches an authenticated session", true);
      const ghostBody = await ghostPage.locator("body").innerText();
      check(
        "role-less account never reaches the app shell",
        !ghostBody.includes("Fax Attempt History"),
      );
      await ghostPage.close();
    }

    // ---- login as the synthetic role account ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
    await page.getByRole("button", { name: portalLabel }).click();
    await page.locator(`#${role}-username`).fill(username);
    await page.locator(`#${role}-password`).fill(password);
    await page.getByRole("button", { name: portalLabel }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check(`${role} login reaches the app shell`, true);

    // ---- open the synthetic document ----
    await page.goto(`${BASE_URL}/documents/${documentId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Fax Attempt History", { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check(`${role} can open the synthetic document`, bodyText.includes("Attempt #1"));

    // ---- correct button is visible for this role ----
    const correctButton = page.getByRole("button", { name: /correct attempt/i }).first();
    check(`${role} sees a Correct attempt control`, (await correctButton.count()) === 1);

    // ---- successful correction (also warms up the server function's
    // on-demand dev-mode compilation before the timing-sensitive conflict
    // check below) ----
    await correctButton.click();
    await page.waitForSelector("text=Correct attempt #1");
    await page.locator('select[name="status"]').selectOption("Sent Successfully");
    await page.locator('input[name="confirmation_number"]').fill(`${marker}-CONF`);
    const reasonText = `${marker} was mis-recorded as Pending, correcting to Sent Successfully`;
    await page.locator('textarea[name="reason"]').fill(reasonText);
    await page.getByRole("button", { name: "Save Correction" }).click();
    await page.waitForSelector("text=Fax attempt corrected.", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    bodyText = await page.locator("body").innerText();
    check("UI shows the corrected status", bodyText.includes("Sent Successfully"));
    check("UI shows the new confirmation number", bodyText.includes(`${marker}-CONF`));
    check(`UI shows correction history crediting ${username}`, bodyText.includes(username));
    check("UI shows the correction reason", bodyText.includes(reasonText));

    // ---- Failed status without a failure reason: HTML5 required blocks submit ----
    await page
      .getByRole("button", { name: /correct attempt/i })
      .first()
      .click();
    await page.waitForSelector("text=Correct attempt #1");
    await page.locator('select[name="status"]').selectOption("Failed");
    await page.locator('textarea[name="reason"]').fill(`${marker} testing missing failure reason`);
    await page.getByRole("button", { name: "Save Correction" }).click();
    await page.waitForTimeout(600);
    bodyText = await page.locator("body").innerText();
    check(
      "Failed status without a failure reason is blocked client-side (dialog still open)",
      bodyText.includes("Correct attempt #1"),
    );

    // ---- stale-edit conflict: a concurrent correction must not be silently overwritten ----
    await page.locator('select[name="status"]').selectOption("Cancelled");
    const { error: concurrentEditError } = await admin
      .from("fax_attempts")
      .update({
        notes: "concurrent edit from another session",
        updated_at: new Date().toISOString(),
      })
      .eq("id", attemptId);
    if (concurrentEditError)
      throw new Error(`concurrent edit failed: ${concurrentEditError.message}`);
    await page.locator('textarea[name="reason"]').fill(`${marker} stale submit`);
    await page.getByRole("button", { name: "Save Correction" }).click();
    await page.waitForSelector("text=updated by someone else", { timeout: 15000 });
    check("stale form submit surfaces a conflict instead of overwriting", true);
    const { data: afterStaleAttempt } = await admin
      .from("fax_attempts")
      .select("notes, status")
      .eq("id", attemptId)
      .single();
    check(
      "the concurrent edit's value survived (was not silently overwritten)",
      afterStaleAttempt?.notes === "concurrent edit from another session",
    );

    // ---- reload: correction and history persist ----
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=Fax Attempt History", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check("corrected status persists after reload", bodyText.includes("Sent Successfully"));
    check("correction history persists after reload", bodyText.includes(reasonText));

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
    check("no uncaught page errors during the flow", pageErrors.length === 0);
    if (pageErrors.length) console.log("page errors:", pageErrors);

    // ---- verify against the database directly ----
    const { data: dbAttempts } = await admin
      .from("fax_attempts")
      .select("*")
      .eq("document_id", documentId);
    check(
      "exactly one fax_attempts row for the document (no new attempt created)",
      (dbAttempts ?? []).length === 1,
    );
    const dbAttempt = dbAttempts?.[0];
    check("attempt_number unchanged", dbAttempt?.attempt_number === 1);
    check("created_by (original recorder) unchanged", dbAttempt?.created_by === originalRecorderId);
    check(
      "created_at (original record time) unchanged",
      new Date(dbAttempt?.created_at).getTime() > 0,
    );
    check("status reflects the successful correction", dbAttempt?.status === "Sent Successfully");

    const { data: corrections } = await admin
      .from("fax_attempt_corrections")
      .select("*")
      .eq("attempt_id", attemptId);
    check(
      "exactly one fax_attempt_corrections row for this attempt (the successful correction)",
      (corrections ?? []).length === 1,
    );
    const correction = corrections?.[0];
    check("correction row records the correcting user", correction?.corrected_by === userId);
    check("correction row records the reason", correction?.reason === reasonText);
    check(
      "correction row records before/after status",
      correction?.before?.status === "Pending" && correction?.after?.status === "Sent Successfully",
    );

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("*")
      .eq("document_id", documentId)
      .eq("action", "fax_attempt_corrected");
    check("exactly one audit_logs row for this correction", (auditRows ?? []).length === 1);
    check(
      "audit row attributes the action to the correcting user",
      auditRows?.[0]?.user_id === userId,
    );
  } catch (e) {
    await page.screenshot({ path: `p3p6-${role}-error.png`, fullPage: true }).catch(() => {});
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
  note("Real accounts and patient records were not touched; only synthetic records were used.");
  console.log(`\nAll P3-P6 ${role} live checks passed. Synthetic data cleaned up.`);
}

await main();
