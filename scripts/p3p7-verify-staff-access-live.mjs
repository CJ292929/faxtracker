#!/usr/bin/env node
// Verifies P3-P7 Staff Access table: creates a synthetic admin + a synthetic
// staff login through the real running app, checks the Username/Role/
// Password/Actions table renders correctly, checks the eye icon reveals the
// just-created password, checks pre-existing accounts show "Unavailable",
// screenshots the result, then deletes everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and the app
// running (set E2E_BASE_URL, default http://localhost:8085). Screenshots are
// written to the directory given as the first CLI arg (default ".").
//
// Run with: node scripts/p3p7-verify-staff-access-live.mjs [screenshotDir]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const SHOT_DIR = process.argv[2] || ".";
mkdirSync(SHOT_DIR, { recursive: true });

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    }),
);

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8085";
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p7v${stamp}`.slice(0, 16);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

let bootstrapAdminId = null;
const createdUserIds = [];

async function makeSyntheticAdmin() {
  const email = `synth-${tag}boot@users.invalid`;
  const password = `Synth-${stamp}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create bootstrap admin: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}boot`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: id, username });
  await admin.from("user_roles").insert({ user_id: id, role: "admin" });
  bootstrapAdminId = id;
  createdUserIds.push(id);
  return { username, password };
}

async function cleanup() {
  for (const id of createdUserIds) {
    if (!id) continue;
    try {
      await admin.from("user_roles").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.from("user_logins").delete().eq("user_id", id);
    } catch {}
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {}
  }
  console.log(`cleaned up ${createdUserIds.length} synthetic account(s)`);
}

(async () => {
  const bootAdmin = await makeSyntheticAdmin();
  console.log(`note: bootstrap admin username=${bootAdmin.username}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.locator("#admin-username").fill(bootAdmin.username);
    await page.locator("#admin-password").fill(bootAdmin.password);
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.waitForURL(/\/(?:$|\?)/, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector("text=Dashboard", { timeout: 15000 }).catch(() => {});

    await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    check("Settings page loaded", await page.locator("text=Staff Access").first().isVisible());

    const staffSection = page.locator("section", {
      has: page.locator("h2", { hasText: "Staff Access" }),
    });
    const staffTable = staffSection.locator("table.data-table");

    // Table header check
    const headers = await staffTable.locator("thead th").allInnerTexts();
    check(
      "Staff Access table has Username | Role | Password | Actions columns",
      JSON.stringify(headers.map((h) => h.toLowerCase())) ===
        JSON.stringify(["username", "role", "password", "actions"]),
    );

    await page.screenshot({
      path: path.join(SHOT_DIR, "01-staff-access-before.png"),
      fullPage: true,
    });

    // Pre-existing bootstrap admin row itself has no session password -> Unavailable
    const selfRow = staffTable.locator("tbody tr", { hasText: bootAdmin.username });
    check(
      "Bootstrap admin's own row shows Unavailable password (no session-created password)",
      (await selfRow.innerText()).includes("Unavailable"),
    );
    check("Bootstrap admin row labeled (YOU)", (await selfRow.innerText()).includes("(YOU)"));

    // Create a new staff login via the panel
    const staffUsername = `${tag}staff`.slice(0, 32);
    const staffPassword = `Created-${stamp}-pw!`;
    await page.locator('label:has-text("Username") input').first().fill(staffUsername);
    await page.locator('label:has-text("Password") input').first().fill(staffPassword);
    await page.locator('label:has-text("Confirm Password") input').first().fill(staffPassword);
    await page.getByRole("button", { name: "Create Login" }).click();
    await page.waitForTimeout(1500);
    createdUserIds.push(
      (
        await admin
          .from("user_logins")
          .select("user_id")
          .eq("username", staffUsername)
          .maybeSingle()
      ).data?.user_id,
    );

    const newRow = staffTable.locator("tbody tr", { hasText: staffUsername });
    check("New staff row appears in Staff Access table", (await newRow.count()) === 1);

    // Password should be masked by default
    const maskedText = await newRow.innerText();
    check("New row shows masked password by default", maskedText.includes("••••••••"));
    check(
      "New row does NOT show plaintext password before reveal",
      !maskedText.includes(staffPassword),
    );

    // Click the eye icon to reveal
    await newRow.locator("button[aria-label='Show password']").click();
    const revealedText = await newRow.innerText();
    check("Eye icon reveals the exact created password", revealedText.includes(staffPassword));
    await page.screenshot({
      path: path.join(SHOT_DIR, "02-staff-access-password-revealed.png"),
      fullPage: true,
    });

    // Click again to hide
    await newRow.locator("button[aria-label='Hide password']").click();
    const hiddenAgainText = await newRow.innerText();
    check(
      "Eye icon hides password again on second click",
      !hiddenAgainText.includes(staffPassword),
    );

    // Role badge check
    check(
      "New row shows STAFF role badge",
      (await newRow.innerText()).toUpperCase().includes("STAFF"),
    );

    await page.screenshot({
      path: path.join(SHOT_DIR, "03-staff-access-final.png"),
      fullPage: true,
    });
  } finally {
    await browser.close();
    await cleanup();
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("ERROR:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
