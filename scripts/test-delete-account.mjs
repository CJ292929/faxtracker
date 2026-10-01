#!/usr/bin/env node
// Isolated fixture test for the delete-account RPC wrapper: input
// validation and error-message mapping. No network, no real credentials —
// the authoritative checks (admin recheck, self-delete, last-admin,
// username confirmation, atomic mapping/auth cleanup, audit) live in the
// database function and are covered by scripts/p3p13-delete-account-live.mjs
// against isolated synthetic accounts.
//   node --experimental-strip-types scripts/test-delete-account.mjs
import { deleteStaffAccount } from "../src/lib/delete-account-core.ts";

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
const baseInput = { targetUserId: TARGET, confirmUsername: "someuser" };

async function run() {
  // Happy path: the database function returns the deleted account's row.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [{ target_user_id: TARGET, target_username: "someuser", target_role: "staff" }],
        error: null,
      };
    });
    const result = await deleteStaffAccount(baseInput, client);
    await check("success maps db row to result", result, {
      ok: true,
      targetUserId: TARGET,
      username: "someuser",
      role: "staff",
    });
    await check("calls delete_staff_account with snake_case args", calls, [
      ["delete_staff_account", { _target_user_id: TARGET, _expected_username: "someuser" }],
    ]);
  }

  // Confirmation username is normalized (trim + lowercase) before the call.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [{ target_user_id: TARGET, target_username: "someuser", target_role: "staff" }],
        error: null,
      };
    });
    await deleteStaffAccount({ ...baseInput, confirmUsername: "  SomeUser  " }, client);
    await check("confirm username normalized to trim+lowercase", calls, [
      ["delete_staff_account", { _target_user_id: TARGET, _expected_username: "someuser" }],
    ]);
  }

  // FORBIDDEN from the database (non-admin caller, incl. staff/anon/role-less
  // direct RPC calls that bypass the UI entirely) maps to a friendly error.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FORBIDDEN: only administrators can delete accounts" },
    }));
    await check("forbidden caller denied", await deleteStaffAccount(baseInput, client), {
      ok: false,
      error: "Only administrators can delete accounts.",
    });
  }

  // Self-deletion denial.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "SELF_DELETE: you cannot delete your own account" },
    }));
    await check("self-delete denied", await deleteStaffAccount(baseInput, client), {
      ok: false,
      error: "You cannot delete your own account.",
    });
  }

  // Last-admin denial.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "LAST_ADMIN: cannot delete the last remaining admin" },
    }));
    await check("last-admin denied", await deleteStaffAccount(baseInput, client), {
      ok: false,
      error: "Cannot delete the last remaining admin.",
    });
  }

  // Unknown / already-deleted target (e.g. a duplicate submit).
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "NOT_FOUND: account does not exist" },
    }));
    await check("missing account denied", await deleteStaffAccount(baseInput, client), {
      ok: false,
      error: "That account no longer exists.",
    });
  }

  // Mismatched confirmation username.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "CONFLICT: username does not match this account" },
    }));
    await check(
      "mismatched confirmation username denied",
      await deleteStaffAccount(baseInput, client),
      { ok: false, error: "Username does not match this account." },
    );
  }

  // Client-side validation happens before any network call.
  {
    let called = false;
    const client = fakeRpc(async () => {
      called = true;
      return { data: null, error: null };
    });
    await check(
      "invalid uuid rejected without a call",
      await deleteStaffAccount({ ...baseInput, targetUserId: "not-a-uuid" }, client),
      { ok: false, error: "Invalid account." },
    );
    await check(
      "blank confirmation username rejected without a call",
      await deleteStaffAccount({ ...baseInput, confirmUsername: "   " }, client),
      { ok: false, error: "Type the username to confirm deletion." },
    );
    await check("no rpc call made for invalid input", called, false);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll delete-account checks passed.");
}

await run();
