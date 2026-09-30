#!/usr/bin/env node
// Isolated fixture test for admin-controlled password resets: role gate,
// validation, unknown target, and audit logging without the password. No
// network, no real credentials.
//   node --experimental-strip-types scripts/test-reset-password.mjs
import { resetPassword } from "../src/lib/reset-password-core.ts";

function fakeAdmin({ roles = {}, logins = {}, failUpdateFor = null } = {}) {
  const state = {
    roles: { ...roles },
    logins: { ...logins },
    updated: [],
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
                    // eq is always on "user_id" for this table in reset-password-core
                    const username = state.logins[value];
                    return { data: username ? { username } : null };
                  }
                  throw new Error(`unexpected table ${table}`);
                },
              };
            },
          };
        },
        async insert(row) {
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
        async updateUserById(id, attrs) {
          if (failUpdateFor === id) return { error: { message: "boom" } };
          state.updated.push({ id, password: attrs.password });
          return { error: null };
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
  // Non-admin (staff) caller is denied.
  {
    const admin = fakeAdmin({
      roles: { "staff-caller": "staff" },
      logins: { "target-1": "targetuser" },
    });
    await check(
      "staff caller is denied",
      await resetPassword(
        "staff-caller",
        { targetUserId: "target-1", password: "longenough1", confirmPassword: "longenough1" },
        admin,
      ),
      { ok: false, error: "Only administrators can reset passwords." },
    );
    await check("denied caller triggers no password update", admin.state.updated, []);
  }

  // Role-less / anonymous-shaped caller is denied (no row in user_roles).
  {
    const admin = fakeAdmin({ roles: {}, logins: { "target-1": "targetuser" } });
    await check(
      "role-less caller is denied",
      await resetPassword(
        "ghost-caller",
        { targetUserId: "target-1", password: "longenough1", confirmPassword: "longenough1" },
        admin,
      ),
      { ok: false, error: "Only administrators can reset passwords." },
    );
  }

  const validTargetId = "00000000-0000-0000-0000-000000000001";

  // Happy path: admin resets a staff login's password.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      logins: { [validTargetId]: "targetuser" },
    });
    const result = await resetPassword(
      "admin-caller",
      { targetUserId: validTargetId, password: "longenough1", confirmPassword: "longenough1" },
      admin,
    );
    await check("admin resets password", result, {
      ok: true,
      username: "targetuser",
      targetUserId: validTargetId,
    });
    await check("updateUserById called with new password", admin.state.updated, [
      { id: validTargetId, password: "longenough1" },
    ]);
    await check(
      "audit entry recorded with actor id, username, and no password",
      admin.state.auditLog,
      [
        {
          user_id: "admin-caller",
          action: "password_reset",
          description: "Reset password for login: targetuser",
        },
      ],
    );
    await check(
      "audit entry never contains the plaintext password",
      admin.state.auditLog.some((row) => JSON.stringify(row).includes("longenough1")),
      false,
    );
  }

  // Invalid / unknown target id is rejected.
  {
    const admin = fakeAdmin({ roles: { "admin-caller": "admin" } });
    await check(
      "non-uuid target rejected",
      await resetPassword(
        "admin-caller",
        { targetUserId: "not-a-uuid", password: "longenough1", confirmPassword: "longenough1" },
        admin,
      ),
      { ok: false, error: "Invalid account." },
    );
    await check(
      "unknown (but well-formed) target rejected",
      await resetPassword(
        "admin-caller",
        { targetUserId: validTargetId, password: "longenough1", confirmPassword: "longenough1" },
        admin,
      ),
      { ok: false, error: "That account no longer exists." },
    );
    await check("no password update attempted for invalid targets", admin.state.updated, []);
  }

  // Weak password / mismatched confirmation are rejected before touching auth.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      logins: { [validTargetId]: "targetuser" },
    });
    await check(
      "short password rejected",
      await resetPassword(
        "admin-caller",
        { targetUserId: validTargetId, password: "short1", confirmPassword: "short1" },
        admin,
      ),
      { ok: false, error: "Password must be at least 8 characters." },
    );
    await check(
      "mismatched confirmation rejected",
      await resetPassword(
        "admin-caller",
        { targetUserId: validTargetId, password: "longenough1", confirmPassword: "different1" },
        admin,
      ),
      { ok: false, error: "Passwords do not match." },
    );
    await check("no password update attempted for rejected input", admin.state.updated, []);
  }

  // Supabase Auth Admin API failure surfaces as a generic error.
  {
    const admin = fakeAdmin({
      roles: { "admin-caller": "admin" },
      logins: { [validTargetId]: "targetuser" },
      failUpdateFor: validTargetId,
    });
    await check(
      "auth update failure surfaces generically",
      await resetPassword(
        "admin-caller",
        { targetUserId: validTargetId, password: "longenough1", confirmPassword: "longenough1" },
        admin,
      ),
      { ok: false, error: "Unable to reset this password. Please try again." },
    );
    await check("no audit entry written when the update fails", admin.state.auditLog, []);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll reset-password checks passed.");
}

await run();
