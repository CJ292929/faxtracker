#!/usr/bin/env node
// Isolated fixture test for admin-controlled login creation: role gate,
// validation, uniqueness, and partial-failure rollback. No network, no real
// credentials.
//   node --experimental-strip-types scripts/test-create-login.mjs
import { createLogin } from "../src/lib/create-login-core.ts";

function fakeAdmin({
  roles = {},
  logins = {},
  failRoleInsertFor = null,
  failLoginInsertFor = null,
} = {}) {
  const state = {
    roles: { ...roles },
    logins: { ...logins },
    nextId: 1,
    deleted: [],
    auditLog: [],
  };

  return {
    state,
    from(table) {
      return {
        select() {
          return {
            eq(_column, value) {
              return {
                async maybeSingle() {
                  if (table === "user_roles") {
                    const role = state.roles[value];
                    return { data: role ? { role } : null };
                  }
                  if (table === "user_logins") {
                    // eq is always on "username" for this table in create-login-core
                    const found = state.logins[value];
                    return { data: found ? { user_id: found } : null };
                  }
                  throw new Error(`unexpected table ${table}`);
                },
              };
            },
          };
        },
        async insert(row) {
          if (table === "user_logins") {
            if (failLoginInsertFor === row.username) return { error: { message: "conflict" } };
            state.logins[row.username] = row.user_id;
            return { error: null };
          }
          if (table === "user_roles") {
            if (failRoleInsertFor === row.user_id) return { error: { message: "conflict" } };
            state.roles[row.user_id] = row.role;
            return { error: null };
          }
          if (table === "audit_logs") {
            state.auditLog.push(row);
            return { error: null };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
    },
    auth: {
      admin: {
        async createUser() {
          const id = `new-user-${state.nextId++}`;
          return { data: { user: { id } }, error: null };
        },
        async deleteUser(id) {
          state.deleted.push(id);
          return {};
        },
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
  // Non-admin caller is denied.
  {
    const admin = fakeAdmin({ roles: { "staff-caller": "staff" } });
    await check(
      "staff caller is denied",
      await createLogin(
        "staff-caller",
        {
          username: "newstaff",
          password: "longenough1",
          confirmPassword: "longenough1",
          role: "staff",
        },
        admin,
      ),
      { ok: false, error: "Only administrators can create logins." },
    );
    await check("denied caller creates no auth user", admin.state.nextId, 1);
  }

  // Role-less / anonymous-shaped caller is denied (no row in user_roles).
  {
    const admin = fakeAdmin({ roles: {} });
    await check(
      "role-less caller is denied",
      await createLogin(
        "ghost-caller",
        {
          username: "newstaff",
          password: "longenough1",
          confirmPassword: "longenough1",
          role: "staff",
        },
        admin,
      ),
      { ok: false, error: "Only administrators can create logins." },
    );
  }

  // Happy path: admin creates a staff login.
  {
    const admin = fakeAdmin({ roles: { "admin-caller": "admin" } });
    const result = await createLogin(
      "admin-caller",
      {
        username: "NewStaff01",
        password: "longenough1",
        confirmPassword: "longenough1",
        role: "staff",
      },
      admin,
    );
    await check("admin creates staff login", result, {
      ok: true,
      username: "newstaff01",
      role: "staff",
    });
    await check(
      "username normalized to lowercase in store",
      admin.state.logins["newstaff01"],
      "new-user-1",
    );
    await check("role row created", admin.state.roles["new-user-1"], "staff");
    await check("audit entry recorded with creator id and no password", admin.state.auditLog, [
      {
        user_id: "admin-caller",
        action: "account_created",
        description: "Created staff login: newstaff01",
      },
    ]);
  }

  // Happy path: admin creates an admin login.
  {
    const admin = fakeAdmin({ roles: { "admin-caller": "admin" } });
    const result = await createLogin(
      "admin-caller",
      {
        username: "newadmin01",
        password: "longenough1",
        confirmPassword: "longenough1",
        role: "admin",
      },
      admin,
    );
    await check("admin creates admin login", result, {
      ok: true,
      username: "newadmin01",
      role: "admin",
    });
  }

  // Duplicate username is rejected before any auth user is created.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      logins: { taken: "existing-user" },
    });
    const result = await createLogin(
      "admin-caller",
      { username: "taken", password: "longenough1", confirmPassword: "longenough1", role: "staff" },
      admin,
    );
    await check("duplicate username rejected", result, {
      ok: false,
      error: "That username is already taken.",
    });
    await check("no auth user created for duplicate username", admin.state.nextId, 1);
  }

  // Bad format / weak password / mismatched confirmation are rejected client-independent.
  {
    const admin = fakeAdmin({ roles: { "admin-caller": "admin" } });
    await check(
      "bad username format rejected",
      await createLogin(
        "admin-caller",
        { username: "ab", password: "longenough1", confirmPassword: "longenough1", role: "staff" },
        admin,
      ),
      { ok: false, error: "Username must be 3-32 characters: lowercase letters, numbers, . or _." },
    );
    await check(
      "short password rejected",
      await createLogin(
        "admin-caller",
        { username: "gooduser", password: "short1", confirmPassword: "short1", role: "staff" },
        admin,
      ),
      { ok: false, error: "Password must be at least 8 characters." },
    );
    await check(
      "mismatched confirmation rejected",
      await createLogin(
        "admin-caller",
        {
          username: "gooduser",
          password: "longenough1",
          confirmPassword: "different1",
          role: "staff",
        },
        admin,
      ),
      { ok: false, error: "Passwords do not match." },
    );
    await check("no auth user created for any rejected input", admin.state.nextId, 1);
  }

  // Partial failure: user_logins insert fails after the auth user was created -> rollback.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      failLoginInsertFor: "raceduser",
    });
    const result = await createLogin(
      "admin-caller",
      {
        username: "raceduser",
        password: "longenough1",
        confirmPassword: "longenough1",
        role: "staff",
      },
      admin,
    );
    await check("login-insert failure surfaces as taken-username", result, {
      ok: false,
      error: "That username is already taken.",
    });
    await check("auth user rolled back after login-insert failure", admin.state.deleted, [
      "new-user-1",
    ]);
    await check("no role row left behind", admin.state.roles["new-user-1"], undefined);
  }

  // Partial failure: user_roles insert fails after user_logins succeeded -> rollback the auth user.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      failRoleInsertFor: "new-user-1",
    });
    const result = await createLogin(
      "admin-caller",
      {
        username: "raceduser2",
        password: "longenough1",
        confirmPassword: "longenough1",
        role: "staff",
      },
      admin,
    );
    await check("role-insert failure surfaces generically", result, {
      ok: false,
      error: "Unable to create this login. Please try again.",
    });
    await check("auth user rolled back after role-insert failure", admin.state.deleted, [
      "new-user-1",
    ]);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll create-login checks passed.");
}

await run();
