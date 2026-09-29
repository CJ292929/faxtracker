#!/usr/bin/env node
// P3-P6 live workflow walkthrough for admin-controlled account creation:
// bootstraps a synthetic admin via the service role, logs into the real
// running app through the actual Admin Login portal, opens Settings,
// verifies the Create Login form is present and usable, creates a
// synthetic Staff account and a synthetic Admin account through the UI,
// verifies each can sign in through its own portal, verifies wrong-portal
// login is rejected, verifies a duplicate username is rejected with a clear
// error, and verifies a Staff account cannot reach account creation.
// Cleans up everything it created.
//
// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_PUBLISHABLE_KEY
// in .env and the app running (set E2E_BASE_URL, default http://localhost:8082).
//
// Run with: node scripts/p3p6-create-login-live.mjs
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
const tag = `p3p6cl${stamp}`.slice(0, 16);

let bootstrapAdminId = null;
const createdUserIds = [];
const createdUsernames = [];

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
  return { id, username, password };
}

async function cleanup(cleanupErrors) {
  for (const username of createdUsernames) {
    try {
      const { data: login } = await admin
        .from("user_logins")
        .select("user_id")
        .eq("username", username)
        .maybeSingle();
      if (login?.user_id) createdUserIds.push(login.user_id);
    } catch (e) {
      cleanupErrors.push(`lookup for ${username} failed: ${e.message}`);
    }
  }
  if (bootstrapAdminId) createdUserIds.push(bootstrapAdminId);
  for (const id of [...new Set(createdUserIds)]) {
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
    try {
      await admin.from("audit_logs").delete().eq("user_id", id);
    } catch {
      /* ignore */
    }
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

async function main() {
  const cleanupErrors = [];
  const { username: bootUsername, password: bootPassword } = await makeSyntheticAdmin();

  const staffUsername = `${tag}stf`.slice(0, 32);
  const adminUsername = `${tag}adm`.slice(0, 32);
  const newPassword = `Synth-${stamp}-new!`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const networkFailures = [];
  page.on("response", (r) => {
    if (r.status() >= 400) {
      console.log(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
      networkFailures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });

  try {
    // ---- login as the synthetic bootstrap admin ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.locator("#admin-username").fill(bootUsername);
    await page.locator("#admin-password").fill(bootPassword);
    await page.getByRole("button", { name: "Admin Login" }).click();
    await page.waitForSelector("text=Patients", { timeout: 15000 });
    check("bootstrap admin login reaches the app shell", true);

    // ---- navigate to Settings / Admin Management ----
    await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    let bodyText = await page.locator("body").innerText();
    check("Settings page loaded", bodyText.includes("Settings"));

    // ---- reproduce: is Create Login present, visible, reachable? ----
    const createLoginHeading = page.getByRole("heading", { name: "Create Login" });
    const headingCount = await createLoginHeading.count();
    check("Create Login section is present on the page", headingCount === 1);
    if (headingCount === 1) {
      check("Create Login heading is visible", await createLoginHeading.first().isVisible());
    }

    // ---- create a synthetic Staff account via the UI ----
    await page.locator('section:has(h2:text("Create Login")) input[type="text"]').fill(
      staffUsername,
    );
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(0)
      .fill(newPassword);
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(1)
      .fill(newPassword);
    const roleSelect = page.locator('section:has(h2:text("Create Login")) select');
    check("Role select defaults to Staff", (await roleSelect.inputValue()) === "staff");
    await page
      .getByRole("button", { name: "Create Login", exact: true })
      .click();
    await page.waitForTimeout(6000);
    bodyText = await page.locator("body").innerText();
    check(
      `synthetic Staff account "${staffUsername}" appears in Accounts list`,
      bodyText.includes(staffUsername),
    );
    createdUsernames.push(staffUsername);

    // ---- password fields cleared after success ----
    const pwAfter = await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(0)
      .inputValue();
    check("password field cleared after successful creation", pwAfter === "");

    // ---- create a synthetic Admin account via the UI ----
    await page.locator('section:has(h2:text("Create Login")) input[type="text"]').fill(
      adminUsername,
    );
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(0)
      .fill(newPassword);
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(1)
      .fill(newPassword);
    await roleSelect.selectOption("admin");
    await page
      .getByRole("button", { name: "Create Login", exact: true })
      .click();
    await page.waitForTimeout(6000);
    bodyText = await page.locator("body").innerText();
    check(
      `synthetic Admin account "${adminUsername}" appears in Accounts list`,
      bodyText.includes(adminUsername),
    );
    createdUsernames.push(adminUsername);

    // ---- duplicate username is rejected with a clear error ----
    await page.locator('section:has(h2:text("Create Login")) input[type="text"]').fill(
      staffUsername,
    );
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(0)
      .fill(newPassword);
    await page
      .locator('section:has(h2:text("Create Login")) input[type="password"]')
      .nth(1)
      .fill(newPassword);
    await page
      .getByRole("button", { name: "Create Login", exact: true })
      .click();
    await page.waitForTimeout(6000);
    bodyText = await page.locator("body").innerText();
    check("duplicate username gives a clear error", /already taken/i.test(bodyText));

    await page.close();

    // ---- new Staff account signs in through Staff Login ----
    {
      const staffPage = await browser.newPage();
      await staffPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      await staffPage.getByRole("button", { name: "Staff Login" }).click();
      await staffPage.locator("#staff-username").fill(staffUsername);
      await staffPage.locator("#staff-password").fill(newPassword);
      await staffPage.getByRole("button", { name: "Staff Login" }).click();
      await staffPage.waitForSelector("text=Patients", { timeout: 15000 });
      check("new Staff account signs in through Staff Login and loads workspace", true);

      // ---- wrong-portal login rejected: staff account via Admin Login ----
      await staffPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      // if already authed from prior step, force logout via reload not needed:
      // open a fresh context page instead for a clean unauthenticated state
      await staffPage.close();
    }
    {
      const wrongPortalPage = await browser.newPage();
      await wrongPortalPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      await wrongPortalPage.getByRole("button", { name: "Admin Login" }).click();
      await wrongPortalPage.locator("#admin-username").fill(staffUsername);
      await wrongPortalPage.locator("#admin-password").fill(newPassword);
      await wrongPortalPage.getByRole("button", { name: "Admin Login" }).click();
      await wrongPortalPage.waitForSelector("text=Invalid username or password", {
        timeout: 15000,
      });
      check("Staff account is rejected when logging into the Admin portal", true);

      // ---- staff cannot access account creation ----
      await wrongPortalPage.locator("#admin-username").fill(""); // no-op, stay logged out
      await wrongPortalPage.close();
    }
    {
      const staffSettingsPage = await browser.newPage();
      await staffSettingsPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      await staffSettingsPage.getByRole("button", { name: "Staff Login" }).click();
      await staffSettingsPage.locator("#staff-username").fill(staffUsername);
      await staffSettingsPage.locator("#staff-password").fill(newPassword);
      await staffSettingsPage.getByRole("button", { name: "Staff Login" }).click();
      await staffSettingsPage.waitForSelector("text=Patients", { timeout: 15000 });
      await staffSettingsPage.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
      const staffBody = await staffSettingsPage.locator("body").innerText();
      check(
        "Staff account cannot see the Create Login form",
        !staffBody.includes("Create Login"),
      );
      await staffSettingsPage.close();
    }

    // ---- new Admin account signs in through Admin Login and loads Admin Management ----
    {
      const adminPage = await browser.newPage();
      await adminPage.goto(`${BASE_URL}/patients`, { waitUntil: "networkidle" });
      await adminPage.getByRole("button", { name: "Admin Login" }).click();
      await adminPage.locator("#admin-username").fill(adminUsername);
      await adminPage.locator("#admin-password").fill(newPassword);
      await adminPage.getByRole("button", { name: "Admin Login" }).click();
      await adminPage.waitForSelector("text=Patients", { timeout: 15000 });
      await adminPage.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
      const adminBody = await adminPage.locator("body").innerText();
      check(
        "new Admin account signs in through Admin Login and loads Admin Management",
        adminBody.includes("Create Login"),
      );
      await adminPage.close();
    }

    check("no browser console errors during the flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors);
    check("no uncaught page errors during the flow", pageErrors.length === 0);
    if (pageErrors.length) console.log("page errors:", pageErrors);
    check("no unexpected 4xx/5xx network responses", networkFailures.length === 0);

    // ---- verify against the database directly ----
    const { data: staffLoginRow } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("username", staffUsername)
      .maybeSingle();
    const { data: staffRoleRow } = staffLoginRow
      ? await admin.from("user_roles").select("role").eq("user_id", staffLoginRow.user_id).maybeSingle()
      : { data: null };
    check("staff account has a user_logins row", !!staffLoginRow);
    check("staff account has role=staff in user_roles", staffRoleRow?.role === "staff");

    const { data: adminLoginRow } = await admin
      .from("user_logins")
      .select("user_id")
      .eq("username", adminUsername)
      .maybeSingle();
    const { data: adminRoleRow } = adminLoginRow
      ? await admin.from("user_roles").select("role").eq("user_id", adminLoginRow.user_id).maybeSingle()
      : { data: null };
    check("admin account has a user_logins row", !!adminLoginRow);
    check("admin account has role=admin in user_roles", adminRoleRow?.role === "admin");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("*")
      .eq("action", "account_created")
      .eq("user_id", bootstrapAdminId);
    check(
      "audit_logs recorded exactly two account_created entries by the bootstrap admin",
      (auditRows ?? []).length === 2,
    );
    for (const row of auditRows ?? []) {
      check(
        `audit description for row does not contain a password ("${row.description}")`,
        !row.description?.includes(newPassword),
      );
    }
  } catch (e) {
    await page.screenshot({ path: "p3p6-create-login-error.png", fullPage: true }).catch(() => {});
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
  note("Real accounts and patient records were not touched; only synthetic records were used.");
  console.log(`\nAll P3-P6 create-login live checks passed. Synthetic data cleaned up.`);
}

await main();
