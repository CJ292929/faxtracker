#!/usr/bin/env node
// One-time, reviewed provisioning step: links a normalized username to an
// existing auth.users row via public.user_logins. Never creates users,
// never changes passwords/roles/emails. Run manually against
// LOVABLE_DB_MIGRATION_URL after migration 0004 has been applied.
//
// Usage:
//   node scripts/provision-usernames.mjs --map=./local-only-map.json
//
// The map file (NOT committed) must contain:
//   [{ "email": "person@example.com", "username": "person" }, ...]
import { readFileSync } from "node:fs";
import postgres from "postgres";

const mapArg = process.argv.find((a) => a.startsWith("--map="));
if (!mapArg) {
  console.error("Usage: node scripts/provision-usernames.mjs --map=<path-to-json>");
  process.exit(1);
}
const mapPath = mapArg.slice("--map=".length);
const entries = JSON.parse(readFileSync(mapPath, "utf8"));

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;
for (const e of entries) {
  if (typeof e.email !== "string" || typeof e.username !== "string") {
    console.error("Invalid entry:", e);
    process.exit(1);
  }
  e.username = e.username.trim().toLowerCase();
  if (!USERNAME_RE.test(e.username)) {
    console.error(`Username "${e.username}" fails format check.`);
    process.exit(1);
  }
}

const url = process.env.LOVABLE_DB_MIGRATION_URL;
if (!url) {
  console.error("LOVABLE_DB_MIGRATION_URL is not set.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const usernames = entries.map((e) => e.username);
  const dupes = usernames.filter((u, i) => usernames.indexOf(u) !== i);
  if (dupes.length) {
    console.error("Duplicate usernames in map:", [...new Set(dupes)]);
    process.exit(1);
  }

  const results = [];
  for (const { email, username } of entries) {
    const [user] = await sql`select id, email from auth.users where lower(email) = lower(${email})`;
    if (!user) {
      console.error(`No auth.users row for email ${email}`);
      process.exit(1);
    }

    const [existingByUsername] =
      await sql`select user_id from public.user_logins where username = ${username}`;
    if (existingByUsername && existingByUsername.user_id !== user.id) {
      console.error(`Username "${username}" is already assigned to a different user_id.`);
      process.exit(1);
    }

    const [existingByUser] =
      await sql`select username from public.user_logins where user_id = ${user.id}`;
    if (existingByUser && existingByUser.username !== username) {
      console.error(`User ${email} already has a different username: ${existingByUser.username}`);
      process.exit(1);
    }

    const [role] = await sql`select role from public.user_roles where user_id = ${user.id}`;
    if (!role) {
      console.error(
        `No public.user_roles row for ${email}; refusing to provision a username for an unroled account.`,
      );
      process.exit(1);
    }

    await sql`
      insert into public.user_logins (user_id, username)
      values (${user.id}, ${username})
      on conflict (user_id) do update set username = excluded.username
    `;
    results.push({ email, username, role: role.role });
  }

  console.log("Provisioned:");
  for (const r of results) console.log(`  ${r.username} -> role=${r.role}`);
} finally {
  await sql.end({ timeout: 5 });
}
