#!/usr/bin/env node
// Isolated fixture test for the username/password + role-gate flow.
// Uses fake admin/anon Supabase clients — no network, no real credentials,
// no invented staff identity. Run with:
//   node --experimental-strip-types scripts/test-role-boundary.mjs
import { resolveUsernameLogin } from "../src/lib/username-login-core.ts";

const USERS = {
  "admin-user-id": { email: "admin@example.test", password: "correct-horse", role: "admin" },
  "staff-user-id": { email: "staff@example.test", password: "battery-staple", role: "staff" },
};
const LOGINS = { adminuser: "admin-user-id", staffuser: "staff-user-id" };

let signedOut = [];

function fakeAdmin() {
  return {
    from(table) {
      return {
        select() {
          return {
            eq(column, value) {
              return {
                async maybeSingle() {
                  if (table === "user_logins") {
                    const userId = LOGINS[value];
                    return { data: userId ? { user_id: userId } : null };
                  }
                  if (table === "user_roles") {
                    const user = USERS[value];
                    return { data: user ? { role: user.role } : null };
                  }
                  throw new Error(`unexpected table ${table}`);
                },
              };
            },
          };
        },
      };
    },
    auth: {
      admin: {
        async getUserById(id) {
          const user = USERS[id];
          return { data: { user: user ? { email: user.email } : null }, error: null };
        },
        async signOut(jwt) {
          signedOut.push(jwt);
          return {};
        },
      },
    },
  };
}

function fakeAnon() {
  return {
    auth: {
      async signInWithPassword({ email, password }) {
        const user = Object.values(USERS).find((u) => u.email === email);
        if (!user || user.password !== password) {
          return { data: { session: null }, error: { message: "invalid" } };
        }
        return {
          data: { session: { access_token: `at-${email}`, refresh_token: `rt-${email}` } },
          error: null,
        };
      },
    },
  };
}

let failures = 0;
async function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok" : "FAIL"} - ${name}`);
  if (!pass) {
    failures++;
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}

async function run() {
  const admin = fakeAdmin();
  const anon = fakeAnon();

  await check(
    "admin succeeds through Admin Login",
    await resolveUsernameLogin(
      { username: "adminuser", password: "correct-horse", portal: "admin" },
      admin,
      anon,
    ),
    { ok: true, access_token: "at-admin@example.test", refresh_token: "rt-admin@example.test" },
  );

  signedOut = [];
  await check(
    "admin rejected through Staff Login",
    await resolveUsernameLogin(
      { username: "adminuser", password: "correct-horse", portal: "staff" },
      admin,
      anon,
    ),
    { ok: false, error: "Invalid username or password for this login type." },
  );
  await check("failed role check revokes the issued session", signedOut.length, 1);

  await check(
    "staff fixture succeeds through Staff Login",
    await resolveUsernameLogin(
      { username: "staffuser", password: "battery-staple", portal: "staff" },
      admin,
      anon,
    ),
    { ok: true, access_token: "at-staff@example.test", refresh_token: "rt-staff@example.test" },
  );

  await check(
    "staff fixture rejected through Admin Login",
    await resolveUsernameLogin(
      { username: "staffuser", password: "battery-staple", portal: "admin" },
      admin,
      anon,
    ),
    { ok: false, error: "Invalid username or password for this login type." },
  );

  await check(
    "wrong password rejected",
    await resolveUsernameLogin(
      { username: "adminuser", password: "nope", portal: "admin" },
      admin,
      anon,
    ),
    { ok: false, error: "Invalid username or password for this login type." },
  );

  await check(
    "unknown username rejected",
    await resolveUsernameLogin(
      { username: "ghostuser", password: "whatever", portal: "admin" },
      admin,
      anon,
    ),
    { ok: false, error: "Invalid username or password for this login type." },
  );

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll role-boundary checks passed.");
}

await run();
