#!/usr/bin/env node
// Verifies P3-P13 Delete Account UI: creates a synthetic bootstrap admin and
// two synthetic staff accounts through the real running app, exercises the
// Delete Account dialog (wrong-confirmation disabled state, Cancel performs
// no mutation, typed-confirmation delete succeeds and the row disappears),
// screenshots each step, then deletes everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env and E2E_BASE_URL
// pointing at a running deployment (Preview or Production).
//
// Run with: node --experimental-strip-types scripts/p3p13-delete-account-ui-live.mjs [screenshotDir]
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

const BASE_URL = process.env.E2E_BASE_URL;
if (!BASE_URL) {
  console.error("Set E2E_BASE_URL to the deployment under test.");
  process.exit(1);
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const tag = `p3p13v${stamp}`.slice(0, 14);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const createdUserIds = [];

async function makeSyntheticAccount(label, role) {
  const email = `synth-${tag}${label}@users.invalid`;
  const password = `Synth-${stamp}-${label}-pw!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`failed to create synthetic ${label}: ${error?.message}`);
  const id = data.user.id;
  const username = `${tag}${label}`.slice(0, 32);
  await admin.from("user_logins").insert({ user_id: id, username });
  await admin.from("user_roles").insert({ user_id: id, role });
  createdUserIds.push(id);
  return { id, username, password };
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
  const bootAdmin = await makeSyntheticAccount("boot", "admin");
  const cancelTarget = await makeSyntheticAccount("cancel", "staff");
  const deleteTarget = await makeSyntheticAccount("victim", "staff");
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
    await staffTable
      .locator("tbody tr", { hasText: cancelTarget.username })
      .waitFor({ timeout: 10000 });
    await staffTable
      .locator("tbody tr", { hasText: deleteTarget.username })
      .waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "01-staff-access-before.png"), fullPage: true });

    // ---- Cancel path: no mutation ----
    const cancelRow = staffTable.locator("tbody tr", { hasText: cancelTarget.username });
    await cancelRow.locator(`button[aria-label="Delete account ${cancelTarget.username}"]`).click();
    const cancelDialog = page.locator('[role="dialog"][aria-label="Delete account permanently"]');
    await cancelDialog.waitFor({ timeout: 5000 });
    check(
      "Cancel dialog shows the target username and role",
      (await cancelDialog.innerText()).includes(cancelTarget.username) &&
        /staff/i.test(await cancelDialog.innerText()),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, "02-delete-dialog-open.png"), fullPage: true });

    const cancelConfirmInput = cancelDialog.locator("input");
    const cancelDeleteButton = cancelDialog.getByRole("button", { name: /Delete Permanently/i });
    check("Delete button disabled before typing anything", await cancelDeleteButton.isDisabled());
    await cancelConfirmInput.fill("not-the-right-username");
    check(
      "Delete button stays disabled for a wrong confirmation",
      await cancelDeleteButton.isDisabled(),
    );
    await page.screenshot({
      path: path.join(SHOT_DIR, "03-delete-dialog-wrong-confirmation.png"),
      fullPage: true,
    });
    await cancelDialog.getByRole("button", { name: "Cancel" }).click();
    await cancelDialog.waitFor({ state: "hidden", timeout: 5000 });

    const { data: cancelStillThere } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("user_id", cancelTarget.id)
      .maybeSingle();
    check("Cancel performed no mutation: account still exists in the database", !!cancelStillThere);
    check(
      "Cancel performed no mutation: row still present in the table",
      (await staffTable.locator("tbody tr", { hasText: cancelTarget.username }).count()) === 1,
    );

    // ---- Delete path: typed confirmation succeeds ----
    const deleteRow = staffTable.locator("tbody tr", { hasText: deleteTarget.username });
    await deleteRow.locator(`button[aria-label="Delete account ${deleteTarget.username}"]`).click();
    const deleteDialog = page.locator('[role="dialog"][aria-label="Delete account permanently"]');
    await deleteDialog.waitFor({ timeout: 5000 });
    const deleteConfirmInput = deleteDialog.locator("input");
    const deleteButton = deleteDialog.getByRole("button", { name: /Delete Permanently/i });
    await deleteConfirmInput.fill(deleteTarget.username);
    check("Delete button enabled once the username matches exactly", await deleteButton.isEnabled());
    await page.screenshot({
      path: path.join(SHOT_DIR, "04-delete-dialog-confirmed.png"),
      fullPage: true,
    });
    await deleteButton.click();

    await page
      .locator("text=/permanently deleted/i")
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    await staffTable
      .locator("tbody tr", { hasText: deleteTarget.username })
      .waitFor({ state: "detached", timeout: 10000 });
    check("Deleted account's row disappears from the Staff Access table", true);
    await page.screenshot({ path: path.join(SHOT_DIR, "05-staff-access-after.png"), fullPage: true });

    const { data: deletedLogin } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("user_id", deleteTarget.id)
      .maybeSingle();
    check("Deleted account's user_logins mapping is gone", !deletedLogin);
    const { data: deletedRole } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("user_id", deleteTarget.id)
      .maybeSingle();
    check("Deleted account's user_roles mapping is gone", !deletedRole);
    const { data: deletedAuthUser, error: deletedAuthErr } = await admin.auth.admin.getUserById(
      deleteTarget.id,
    );
    check("Deleted account's Supabase Auth user is gone", !deletedAuthUser?.user || !!deletedAuthErr);

    // Deleted account can no longer sign in.
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
    const { error: signInErr } = await anon.auth.signInWithPassword({
      email: `synth-${tag}victim@users.invalid`,
      password: deleteTarget.password,
    });
    check("Deleted account can no longer sign in", !!signInErr);

    // Already-removed createdUserIds entry shouldn't be double-cleaned, but
    // leaving it in the list is harmless (deleteUser on a missing id no-ops).
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
