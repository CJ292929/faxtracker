#!/usr/bin/env node
// Live end-to-end check for P3-P3 patient bulk upload: creates one synthetic
// staff account (service role), logs into the real running dev server
// through the actual Staff Login form, downloads the generated template,
// uploads a synthetic completed copy, walks the review screen, confirms the
// import, and verifies the created patient renders in the Patients tab --
// then deletes every synthetic row it created. Nothing here touches real
// patients or real accounts.
//
// Requires the dev server running at http://localhost:8081 and
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_PUBLISHABLE_KEY in .env.
// Run with: node scripts/e2e-bulk-upload-live.mjs
import { readFileSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import XLSX from "xlsx";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8081";
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `e2ebu${stamp}`.slice(0, 20);
const marker = `E2E${stamp}`;
const uploadPath = `./e2e-bulk-upload-${stamp}.xlsx`;
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

function buildUploadFile() {
  const rows = [
    ["Name", "Member ID", "DOB", "Phone", "Insurance", "Referring MD"],
    [`${marker} Valid`, `MID-${stamp}`, "04/12/1975", "555-0001", "Medicare", "Dr. Test"],
    [`${marker} BadDob`, "", "13/40/2999", "", "", ""],
    [`${marker}NoLast`, "", "", "", "", ""],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Patients");
  XLSX.writeFile(workbook, uploadPath);
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
  try {
    unlinkSync(uploadPath);
  } catch {
    /* already gone */
  }
}

async function main() {
  const cleanupErrors = [];
  const { username, password } = await makeSyntheticStaff();
  buildUploadFile();

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

    await page.getByRole("button", { name: "Bulk Upload Patients" }).click();
    await page.waitForSelector("text=Bulk Upload Patients");
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(uploadPath);
    await page.getByRole("button", { name: /^Import \d+ Patients?$/ }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: "e2e-bulk-upload-review.png", fullPage: true });

    const bodyText = await page.locator("body").innerText();
    check(
      `review screen shows the valid row "${marker} Valid"`,
      bodyText.includes(`${marker} Valid`),
    );
    check(
      "review screen flags the bad-DOB row with an error",
      bodyText.includes("not a real calendar date") || bodyText.includes("Invalid DOB"),
    );
    check(
      "review screen flags the missing-last-name row",
      bodyText.includes("first and last name"),
    );

    await page.getByRole("button", { name: /^Import \d+ Patients?$/ }).click();
    await page.waitForSelector("text=Done", { timeout: 20000 });
    await page.screenshot({ path: "e2e-bulk-upload-results.png", fullPage: true });
    const resultsText = await page.locator("body").innerText();
    check("results screen reports at least one created row", /created/i.test(resultsText));

    await page.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(1000);
    const listText = await page.locator("body").innerText();
    check(
      `imported patient "${marker} Valid" appears in the Patients list`,
      listText.includes(`${marker} Valid`),
    );
    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
  } catch (e) {
    await page.screenshot({ path: "e2e-bulk-upload-error.png", fullPage: true }).catch(() => {});
    console.log(
      "FLOW ERROR, body text:",
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "<unavailable>")
      ).slice(0, 800),
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
  console.log("\nAll live bulk-upload E2E checks passed. Synthetic data cleaned up.");
}

await main();
