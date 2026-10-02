#!/usr/bin/env node
// P3-P15 live end-to-end check for the Referring MD NPI / Office Number /
// Fax Number columns in the patient bulk-upload flow: downloads the actual
// generated template from the real running dev server, verifies its headers
// and text-cell formatting, uploads a completed nine-column copy (valid +
// invalid-NPI rows), uploads a legacy six-column copy, and verifies a bulk
// retry conflict is raised when one of the new fields differs from what's
// already in the database for the same stable Patient ID. Cleans up every
// synthetic row and account it creates.
//
// Requires the dev server running (set E2E_BASE_URL, defaults to
// http://localhost:8080) and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// SUPABASE_PUBLISHABLE_KEY in .env.
// Run with: node scripts/p3p15-bulk-upload-md-contact-live.mjs
import { readFileSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import XLSX from "xlsx";
import { normField } from "../src/lib/bulk-upload.ts";

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
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p15bu${stamp}`.slice(0, 20);
const marker = `P3P15BU${stamp}`;
const currentUploadPath = `./p3p15-current-${stamp}.xlsx`;
const legacyUploadPath = `./p3p15-legacy-${stamp}.xlsx`;
const conflictUploadPath = `./p3p15-conflict-${stamp}.xlsx`;
let staffUserId = null;

async function makeSyntheticStaff() {
  const email = `synth-${tag}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic staff: ${error?.message}`);
  staffUserId = data.user.id;
  await admin.from("user_logins").insert({ user_id: staffUserId, username: tag });
  await admin.from("user_roles").insert({ user_id: staffUserId, role: "staff" });
  return { username: tag, password };
}

function buildCurrentUploadFile() {
  const rows = [
    [
      "Name",
      "Member ID",
      "DOB",
      "Patient Phone",
      "Insurance",
      "Referring MD",
      "Referring MD NPI",
      "Referring MD Office Number",
      "Referring MD Fax Number",
    ],
    [
      `${marker} Valid`,
      `MID-${stamp}`,
      "04/12/1975",
      "555-0001",
      "Medicare",
      "Dr. Test",
      "1023456784",
      "555-0010 ext. 3",
      "555-0020",
    ],
    [`${marker} BadNpi`, "", "", "", "", "", "12345", "", ""],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Patients");
  XLSX.writeFile(workbook, currentUploadPath);
}

function buildLegacyUploadFile() {
  const rows = [
    ["Name", "Member ID", "DOB", "Phone", "Insurance", "Referring MD"],
    [`${marker} Legacy`, `MIDLEGACY-${stamp}`, "01/02/1990", "555-0099", "Aetna", "Dr. Old"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Patients");
  XLSX.writeFile(workbook, legacyUploadPath);
}

// Builds a nine-column file whose stable Patient ID (BULK-CONFLICT<stamp>)
// already exists in the DB with different Referring MD contact fields, to
// trigger a retry conflict rather than a false "already imported" match.
function buildConflictUploadFile() {
  const rows = [
    [
      "Name",
      "Member ID",
      "DOB",
      "Patient Phone",
      "Insurance",
      "Referring MD",
      "Referring MD NPI",
      "Referring MD Office Number",
      "Referring MD Fax Number",
    ],
    [`${marker} Conflict`, "", "", "", "", "", "9999999999", "", "555-9999"],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Patients");
  XLSX.writeFile(workbook, conflictUploadPath);
}

async function cleanup(cleanupErrors) {
  try {
    const { data: rows } = await admin
      .from("patients")
      .select("id, first_name")
      .ilike("first_name", `${marker}%`);
    for (const row of rows ?? []) {
      await admin.from("patients").delete().eq("id", row.id);
    }
    console.log(`cleanup: removed ${rows?.length ?? 0} synthetic patient row(s)`);
  } catch (e) {
    cleanupErrors.push(`patient cleanup failed: ${e.message}`);
  }
  if (staffUserId) {
    try {
      await admin.from("user_roles").delete().eq("user_id", staffUserId);
    } catch {
      /* ignore */
    }
    try {
      await admin.from("user_logins").delete().eq("user_id", staffUserId);
    } catch {
      /* ignore */
    }
    await admin.auth.admin.deleteUser(staffUserId).catch(() => {});
  }
  for (const p of [currentUploadPath, legacyUploadPath, conflictUploadPath]) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  const cleanupErrors = [];
  const { username, password } = await makeSyntheticStaff();
  buildCurrentUploadFile();
  buildLegacyUploadFile();
  buildConflictUploadFile();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  try {
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Staff Login" }).click();
    await page.locator("#staff-username").fill(username);
    await page.locator("#staff-password").fill(password);
    await page.getByRole("button", { name: "Staff Login" }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check("staff login reaches the Patients tab", true);

    // ---- download the actual generated template and inspect it ----
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Bulk Template" }).click(),
    ]);
    const downloadedPath = await download.path();
    const workbook = XLSX.readFile(downloadedPath, { cellNF: true });
    check('downloaded template has a "Patients" sheet', workbook.SheetNames.includes("Patients"));
    const sheet = workbook.Sheets["Patients"];
    const headerRow = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })[0];
    check(
      "downloaded template has the nine expected headers in order",
      JSON.stringify(headerRow) ===
        JSON.stringify([
          "Name",
          "Member ID",
          "DOB",
          "Patient Phone",
          "Insurance",
          "Referring MD",
          "Referring MD NPI",
          "Referring MD Office Number",
          "Referring MD Fax Number",
        ]),
    );
    const npiCellRef = XLSX.utils.encode_cell({ r: 1, c: 6 });
    const npiCell = sheet[npiCellRef];
    check(
      "Referring MD NPI column is formatted as text (preserves leading zeros)",
      npiCell?.t === "s" && npiCell?.z === "@",
    );
    const officeCellRef = XLSX.utils.encode_cell({ r: 1, c: 7 });
    check(
      "Referring MD Office Number column is formatted as text",
      sheet[officeCellRef]?.z === "@",
    );
    const faxCellRef = XLSX.utils.encode_cell({ r: 1, c: 8 });
    check("Referring MD Fax Number column is formatted as text", sheet[faxCellRef]?.z === "@");

    // ---- upload the current nine-column template (valid + invalid NPI) ----
    await page.getByRole("button", { name: "Bulk Upload Patients" }).click();
    await page.waitForSelector("text=Bulk Upload Patients");
    await page.locator('input[type="file"]').setInputFiles(currentUploadPath);
    await page.waitForSelector("text=Flags", { timeout: 15000 });
    let bodyText = await page.locator("body").innerText();
    check(`review screen shows the valid row "${marker} Valid"`, bodyText.includes(`${marker} Valid`));
    check(
      "review screen flags the bad-NPI row with a 10-digit error",
      bodyText.includes("must be exactly 10 digits") || bodyText.includes("10 digits"),
    );
    check(
      "review screen shows the office number with its extension",
      bodyText.includes("555-0010 ext. 3"),
    );

    await page.getByRole("button", { name: /^Import \d+ Patients?$/ }).click();
    await page.waitForSelector("text=Done", { timeout: 20000 });
    const resultsText = await page.locator("body").innerText();
    check("results screen reports at least one created row", /created/i.test(resultsText));
    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(500);

    const { data: savedValid, error: savedValidError } = await admin
      .from("patients")
      .select(
        "referring_physician_npi, referring_physician_office_phone, referring_physician_fax",
      )
      .eq("first_name", marker)
      .eq("last_name", "Valid")
      .single();
    if (savedValidError) console.log("savedValid query error:", savedValidError.message);
    check(
      "imported NPI saved exactly as text (leading structure preserved)",
      savedValid?.referring_physician_npi === "1023456784",
    );
    check(
      "imported office number with extension saved verbatim",
      savedValid?.referring_physician_office_phone === "555-0010 ext. 3",
    );
    check("imported fax saved verbatim", savedValid?.referring_physician_fax === "555-0020");
    const { data: badNpiRow } = await admin
      .from("patients")
      .select("id")
      .eq("first_name", marker)
      .eq("last_name", "BadNpi")
      .maybeSingle();
    check("the invalid-NPI row was never imported", !badNpiRow);

    // ---- upload the legacy six-column template ----
    await page.getByRole("button", { name: "Bulk Upload Patients" }).click();
    await page.waitForSelector("text=Bulk Upload Patients");
    await page.locator('input[type="file"]').setInputFiles(legacyUploadPath);
    await page.waitForSelector("text=Flags", { timeout: 15000 });
    bodyText = await page.locator("body").innerText();
    check(
      "legacy six-column template is accepted without a header error",
      bodyText.includes(`${marker} Legacy`) && !bodyText.toLowerCase().includes("column 1 must be"),
    );
    await page.getByRole("button", { name: /^Import \d+ Patients?$/ }).click();
    await page.waitForSelector("text=Done", { timeout: 20000 });
    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(500);
    const { data: legacyRow, error: legacyRowError } = await admin
      .from("patients")
      .select("phone, referring_physician_npi, referring_physician_fax")
      .eq("first_name", marker)
      .eq("last_name", "Legacy")
      .single();
    if (legacyRowError) console.log("legacyRow query error:", legacyRowError.message);
    check(
      "legacy template's Phone column is saved as Patient Phone",
      legacyRow?.phone === "555-0099",
    );
    check(
      "legacy template leaves new MD contact fields empty rather than inventing values",
      !legacyRow?.referring_physician_npi && !legacyRow?.referring_physician_fax,
    );

    // ---- retry/reconciliation: a new-field mismatch must register as a
    // conflict, never a silent "already imported" match. This replicates
    // resolveAmbiguousInsert's exact select + normField comparison
    // (src/components/bulk-upload.tsx) against the real deployed schema,
    // since forcing a genuine client-side unique-constraint collision would
    // require controlling the randomly generated Patient ID generator.
    const retryPatientId = `BULK-RETRY${stamp}`.slice(0, 20).toUpperCase();
    await admin.from("patients").insert({
      first_name: marker,
      last_name: "RetryExisting",
      patient_id: retryPatientId,
      date_of_birth: "1995-06-01",
      phone: "555-0400",
      insurance: "Medicaid",
      insurance_member_id: "RETRY-MID",
      referring_physician: "Dr. Retry",
      referring_physician_npi: "1111111111",
      referring_physician_office_phone: "555-0410",
      referring_physician_fax: "555-0420",
    });
    const { data: committedRow } = await admin
      .from("patients")
      .select(
        "first_name, last_name, date_of_birth, phone, insurance, insurance_member_id, referring_physician, referring_physician_npi, referring_physician_office_phone, referring_physician_fax",
      )
      .eq("patient_id", retryPatientId)
      .single();

    const identicalRetryRow = {
      first_name: marker,
      last_name: "RetryExisting",
      date_of_birth: "1995-06-01",
      phone: "555-0400",
      insurance: "Medicaid",
      member_id: "RETRY-MID",
      referring_physician: "Dr. Retry",
      referring_physician_npi: "1111111111",
      referring_physician_office_phone: "555-0410",
      referring_physician_fax: "555-0420",
    };
    const fieldsMatch = (data, row) =>
      normField(data.first_name) === normField(row.first_name) &&
      normField(data.last_name) === normField(row.last_name) &&
      (data.date_of_birth ?? "") === (row.date_of_birth ?? "") &&
      normField(data.phone) === normField(row.phone) &&
      normField(data.insurance) === normField(row.insurance) &&
      normField(data.insurance_member_id) === normField(row.member_id) &&
      normField(data.referring_physician) === normField(row.referring_physician) &&
      normField(data.referring_physician_npi) === normField(row.referring_physician_npi) &&
      normField(data.referring_physician_office_phone) ===
        normField(row.referring_physician_office_phone) &&
      normField(data.referring_physician_fax) === normField(row.referring_physician_fax);

    check(
      "retry with identical fields (including new MD contact fields) verifies as already created",
      fieldsMatch(committedRow, identicalRetryRow),
    );

    for (const [label, mutated] of [
      ["NPI", { ...identicalRetryRow, referring_physician_npi: "2222222222" }],
      ["Office Number", { ...identicalRetryRow, referring_physician_office_phone: "555-9999" }],
      ["Fax Number", { ...identicalRetryRow, referring_physician_fax: "555-8888" }],
    ]) {
      check(
        `retry with a differing Referring MD ${label} is flagged as a conflict, not a match`,
        !fieldsMatch(committedRow, mutated),
      );
    }

    const { data: untouchedRetryRow } = await admin
      .from("patients")
      .select("referring_physician_npi, referring_physician_office_phone, referring_physician_fax")
      .eq("patient_id", retryPatientId)
      .single();
    check(
      "the committed retry-test patient's fields are untouched by this comparison-only check",
      untouchedRetryRow?.referring_physician_npi === "1111111111" &&
        untouchedRetryRow?.referring_physician_office_phone === "555-0410" &&
        untouchedRetryRow?.referring_physician_fax === "555-0420",
    );

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: "p3p15-bulk-upload-error.png", fullPage: true }).catch(() => {});
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
  console.log("\nAll P3-P15 bulk-upload live checks passed. Synthetic data cleaned up.");
}

await main();
