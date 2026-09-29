#!/usr/bin/env node
// One-off manual check: reproduce the reported "nonworking arrow icon" in
// the Patients tab for both admin and staff. Creates synthetic accounts,
// logs in through the real Staff Login / Admin Login forms, seeds one
// synthetic patient, clicks the row's arrow (ChevronRight) button, and
// checks whether it navigates to the patient detail route. Cleans up after.
import { readFileSync, unlinkSync } from "node:fs";
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

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8081";
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const marker = `ARROWCHK${stamp}`;
const users = [];
let patientRowId = null;

async function makeSyntheticUser(role) {
  const tag = `arrow${role}${stamp}`.slice(0, 20);
  const email = `synth-${tag}@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic ${role}: ${error?.message}`);
  await admin.from("user_logins").insert({ user_id: data.user.id, username: tag });
  await admin.from("user_roles").insert({ user_id: data.user.id, role });
  users.push(data.user.id);
  return { username: tag, password };
}

async function seedPatient() {
  const { data, error } = await admin
    .from("patients")
    .insert({
      first_name: marker,
      last_name: "Test",
      patient_id: `ARR-${stamp}`,
      date_of_birth: "1980-01-01",
    })
    .select("id")
    .single();
  if (error) throw new Error(`failed to seed patient: ${error.message}`);
  patientRowId = data.id;
}

async function loginAs(page, role, creds) {
  await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
  const portalLabel = role === "admin" ? "Admin Login" : "Staff Login";
  await page.getByRole("button", { name: portalLabel }).click();
  await page.locator(`#${role}-username`).fill(creds.username);
  await page.locator(`#${role}-password`).fill(creds.password);
  await page.getByRole("button", { name: portalLabel }).click();
  await page.waitForSelector("text=Patients", { timeout: 15000 });
}

async function checkArrowFor(role) {
  const creds = await makeSyntheticUser(role);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  try {
    await loginAs(page, role, creds);
    await page.locator('input[placeholder="Search patient name..."]').fill(marker);
    await page.waitForTimeout(400);
    const row = page.locator("tr", { hasText: marker });
    await row.waitFor({ timeout: 10000 });
    const arrowBtn = row.locator('a[href*="/patients/"] svg, button:has(svg)').first();
    await page.screenshot({ path: `arrow-check-${role}-before.png` });

    const arrowLink = row
      .locator("a")
      .filter({ has: page.locator("svg") })
      .last();
    const href = await arrowLink.getAttribute("href");
    check(
      `[${role}] arrow row-action link has href to a patient detail route`,
      !!href && href.includes("/patients/"),
    );

    await arrowLink.click();
    await page.waitForTimeout(800);
    const url = page.url();
    check(
      `[${role}] clicking arrow navigates to patient detail`,
      url.includes("/patients/") && url.split("/patients/")[1]?.length > 0,
    );
    // Not just the URL: the detail route is nested under /patients in
    // TanStack Router's file convention (patients_.$patientId.tsx opts out
    // of that nesting) -- a regression back to a nested patients.$patientId
    // file would change the URL but silently fail to render the detail
    // page's content, which a URL-only check would miss.
    const bodyText = await page.locator("body").innerText();
    check(
      `[${role}] patient detail page content actually renders after navigating`,
      bodyText.includes("Add Document") && bodyText.includes(marker),
    );
    await page.screenshot({ path: `arrow-check-${role}-after.png` });
    check(`[${role}] no console errors while clicking arrow`, consoleErrors.length === 0);
    if (consoleErrors.length) console.log(`[${role}] console errors:`, consoleErrors);
  } catch (e) {
    console.log(`[${role}] FLOW ERROR:`, e.message);
    await page.screenshot({ path: `arrow-check-${role}-error.png` }).catch(() => {});
    failures++;
  } finally {
    await browser.close();
  }
}

async function cleanup() {
  if (patientRowId) {
    try {
      await admin.from("patients").delete().eq("id", patientRowId);
    } catch {
      /* ignore */
    }
  }
  for (const uid of users) {
    try {
      await admin.from("user_roles").delete().eq("user_id", uid);
    } catch {
      /* ignore */
    }
    try {
      await admin.from("user_logins").delete().eq("user_id", uid);
    } catch {
      /* ignore */
    }
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
}

async function main() {
  await seedPatient();
  await checkArrowFor("staff");
  await checkArrowFor("admin");
  await cleanup();
  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll arrow-icon checks passed.");
}

await main();
