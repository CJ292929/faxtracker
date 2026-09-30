#!/usr/bin/env node
// Verifies the Set New Password UI end-to-end against a real running
// deployment: creates a synthetic admin + synthetic staff login, logs in as
// the admin, opens the Set New Password dialog on the staff row, saves a new
// password, checks the row shows the masked password with working Eye and
// Copy controls, confirms the new password actually logs the staff account
// in, then deletes everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and a running
// app (set E2E_BASE_URL, default http://localhost:8085).
//
// Run with: node scripts/verify-reset-password-ui-live.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

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
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
const stamp = Date.now();
const tag = `rstui${stamp}`.slice(0, 16);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const createdUserIds = [];

async function makeSyntheticAccount(suffix, role) {
  const email = `synth-${tag}${suffix}@users.invalid`;
  const password = `Synth-${stamp}-${suffix}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user)
    throw new Error(`failed to create synthetic ${suffix}: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}${suffix}`.slice(0, 32);
  createdUserIds.push(id);
  await admin.from("user_logins").insert({ user_id: id, username });
  await admin.from("user_roles").insert({ user_id: id, role });
  return { id, username, password, email };
}

async function cleanup() {
  for (const id of createdUserIds) {
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
  const synthAdmin = await makeSyntheticAccount("boot", "admin");
  const synthStaff = await makeSyntheticAccount("staff", "staff");
  const newPassword = `Reset-${stamp}-ui-pw!`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.locator("#admin-username").fill(synthAdmin.username);
    await page.locator("#admin-password").fill(synthAdmin.password);
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.waitForURL(/\/(?:$|\?)/, { timeout: 15000 }).catch(() => {});

    // Client-side navigation (not a full page.goto reload): this app's
    // Preview-deployment auth storage is intentionally non-persistent across
    // hard reloads, so we exercise the same in-app routing a real admin uses.
    await page.getByRole("link", { name: "Settings" }).click();
    await page.locator("text=Staff Access").first().waitFor({ timeout: 10000 });
    check("Settings page loaded", await page.locator("text=Staff Access").first().isVisible());

    const staffSection = page.locator("section", {
      has: page.locator("h2", { hasText: "Staff Access" }),
    });
    const staffTable = staffSection.locator("table.data-table");
    await staffTable
      .locator("tbody tr", { hasText: synthStaff.username })
      .waitFor({ timeout: 10000 });

    const staffRow = staffTable.locator("tbody tr", { hasText: synthStaff.username });
    check(
      "Staff row shows Set New Password button (no session password known)",
      await staffRow.getByRole("button", { name: "Set New Password" }).isVisible(),
    );

    await staffRow.getByRole("button", { name: "Set New Password" }).click();
    await page.getByRole("dialog").waitFor({ timeout: 5000 });
    await page
      .getByRole("dialog")
      .locator('label:has-text("New Password") input')
      .fill(newPassword);
    await page
      .getByRole("dialog")
      .locator('label:has-text("Confirm Password") input')
      .fill(newPassword);
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10000 });

    const maskedText = await staffRow.innerText();
    check("Row shows masked password after reset", maskedText.includes("••••••••"));
    check("Row does not show plaintext password before reveal", !maskedText.includes(newPassword));

    await staffRow.locator("button[aria-label='Show password']").click();
    const revealedText = await staffRow.innerText();
    check("Eye icon reveals the exact reset password", revealedText.includes(newPassword));

    const copied = await page.evaluate(() => {
      window.__copiedText = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => {
        window.__copiedText = text;
        return orig(text);
      };
      return true;
    });
    check("clipboard hook installed", copied === true);
    await staffRow.locator("button[aria-label='Copy password']").click();
    const copiedText = await page.evaluate(() => window.__copiedText);
    check("Copy button copies the exact reset password", copiedText === newPassword);

    await staffRow.locator("button[aria-label='Hide password']").click();
    const hiddenAgainText = await staffRow.innerText();
    check("Eye icon hides password again on second click", !hiddenAgainText.includes(newPassword));

    // Leaving the Settings page unmounts its component tree, which clears
    // sessionPasswords (see the cleanup effect in src/routes/settings.tsx).
    // Plain React state also can't survive a real browser refresh, so this
    // covers the same code path a hard reload would exercise.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await page.waitForTimeout(500);
    await page.getByRole("link", { name: "Settings" }).click();
    await staffTable
      .locator("tbody tr", { hasText: synthStaff.username })
      .waitFor({ timeout: 10000 });
    const rowAfterLeaving = staffTable.locator("tbody tr", { hasText: synthStaff.username });
    check(
      "Password cell reverts to Set New Password button after leaving and returning to the page",
      await rowAfterLeaving.getByRole("button", { name: "Set New Password" }).isVisible(),
    );
  } finally {
    await browser.close();
  }

  // Confirm the reset password actually works for signing in.
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email: synthStaff.email,
    password: newPassword,
  });
  check("staff account signs in with the reset password", !signInErr && !!signIn.session);
  if (signIn?.session) await anon.auth.signOut();

  await cleanup();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("ERROR:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
