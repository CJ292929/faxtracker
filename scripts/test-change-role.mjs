#!/usr/bin/env node
// Isolated fixture test for the change-role RPC wrapper: input validation
// and error-message mapping. No network, no real credentials — the
// authoritative checks (admin recheck, self-demotion, last-admin, atomic
// audit) live in the database function and are covered by
// scripts/test-role-change-live.mjs against isolated synthetic accounts.
//   node --experimental-strip-types scripts/test-change-role.mjs
import { changeUserRole } from "../src/lib/change-role-core.ts";

function fakeRpc(handler) {
  return { rpc: handler };
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

const TARGET = "11111111-1111-1111-1111-111111111111";

async function run() {
  // Happy path: the database function returns the changed row.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [
          {
            target_user_id: TARGET,
            target_username: "someuser",
            old_role: "staff",
            new_role: "admin",
          },
        ],
        error: null,
      };
    });
    const result = await changeUserRole({ targetUserId: TARGET, newRole: "admin" }, client);
    await check("admin success maps db row to result", result, {
      ok: true,
      targetUserId: TARGET,
      targetUsername: "someuser",
      oldRole: "staff",
      newRole: "admin",
    });
    await check("calls change_user_role with snake_case args", calls, [
      ["change_user_role", { _target_user_id: TARGET, _new_role: "admin" }],
    ]);
  }

  // FORBIDDEN from the database (non-admin caller, incl. staff/anon/role-less
  // direct RPC calls that bypass the UI entirely) maps to a friendly error.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FORBIDDEN: only administrators can change roles" },
    }));
    await check(
      "forbidden caller denied",
      await changeUserRole({ targetUserId: TARGET, newRole: "admin" }, client),
      { ok: false, error: "Only administrators can change roles." },
    );
  }

  // Self-demotion denial.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "SELF_DEMOTION: you cannot change your own role" },
    }));
    await check(
      "self-demotion denied",
      await changeUserRole({ targetUserId: TARGET, newRole: "staff" }, client),
      { ok: false, error: "You cannot change your own role." },
    );
  }

  // Last-admin denial.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "LAST_ADMIN: cannot remove the last remaining admin" },
    }));
    await check(
      "last-admin denied",
      await changeUserRole({ targetUserId: TARGET, newRole: "staff" }, client),
      { ok: false, error: "Cannot remove the last remaining admin." },
    );
  }

  // Unknown target.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "NOT_FOUND: target has no assigned role" },
    }));
    await check(
      "missing target denied",
      await changeUserRole({ targetUserId: TARGET, newRole: "staff" }, client),
      { ok: false, error: "That account no longer exists." },
    );
  }

  // Input validation happens before any network call.
  {
    let called = false;
    const client = fakeRpc(async () => {
      called = true;
      return { data: null, error: null };
    });
    await check(
      "invalid uuid rejected without a call",
      await changeUserRole({ targetUserId: "not-a-uuid", newRole: "admin" }, client),
      { ok: false, error: "Invalid account." },
    );
    await check(
      "invalid role rejected without a call",
      await changeUserRole({ targetUserId: TARGET, newRole: "owner" }, client),
      { ok: false, error: "Choose a role of Staff or Admin." },
    );
    await check("no rpc call made for invalid input", called, false);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll change-role checks passed.");
}

await run();
