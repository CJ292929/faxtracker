#!/usr/bin/env node
// Isolated fixture test for the correct-attempt RPC wrapper: input
// validation and error-message mapping. No network, no real credentials —
// the authoritative checks (staff/admin recheck, reason required, failure
// reason required, stale-write conflict, atomic audit) live in the database
// function and are covered by scripts/test-correct-attempt-live.mjs against
// an isolated, always-rolled-back transaction.
//   node --experimental-strip-types scripts/test-correct-attempt.mjs
import { correctFaxAttempt } from "../src/lib/correct-attempt-core.ts";

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

const ATTEMPT = "11111111-1111-1111-1111-111111111111";
const baseInput = {
  attemptId: ATTEMPT,
  expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  attemptedAt: "2026-01-02T00:00:00.000Z",
  status: "Sent Successfully",
  failureReason: "",
  confirmationNumber: "REF-1",
  notes: "corrected notes",
  reason: "Wrong status recorded originally",
};

async function run() {
  // Happy path: the database function returns the corrected row.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [
          {
            id: ATTEMPT,
            document_id: "22222222-2222-2222-2222-222222222222",
            attempt_number: 2,
            attempted_at: baseInput.attemptedAt,
            status: baseInput.status,
            failure_reason: null,
            confirmation_number: "REF-1",
            notes: "corrected notes",
            updated_at: "2026-01-03T00:00:00.000Z",
          },
        ],
        error: null,
      };
    });
    const result = await correctFaxAttempt(baseInput, client);
    await check("success maps db row to result", result, {
      ok: true,
      id: ATTEMPT,
      documentId: "22222222-2222-2222-2222-222222222222",
      attemptNumber: 2,
      attemptedAt: baseInput.attemptedAt,
      status: baseInput.status,
      failureReason: null,
      confirmationNumber: "REF-1",
      notes: "corrected notes",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    await check("calls correct_fax_attempt with snake_case args", calls, [
      [
        "correct_fax_attempt",
        {
          _attempt_id: ATTEMPT,
          _expected_updated_at: baseInput.expectedUpdatedAt,
          _attempted_at: baseInput.attemptedAt,
          _status: baseInput.status,
          _failure_reason: null,
          _confirmation_number: "REF-1",
          _notes: "corrected notes",
          _reason: baseInput.reason,
        },
      ],
    ]);
  }

  // FORBIDDEN from the database (role-less/anonymous direct RPC calls that
  // bypass the UI entirely) maps to a friendly error.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FORBIDDEN: only staff or admin accounts can correct fax attempts" },
    }));
    await check("forbidden caller denied", await correctFaxAttempt(baseInput, client), {
      ok: false,
      error: "Only admin or staff accounts can correct fax attempts.",
    });
  }

  // Missing reason.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "REASON_REQUIRED: a correction reason is required" },
    }));
    await check("server-side reason-required denied", await correctFaxAttempt(baseInput, client), {
      ok: false,
      error: "A correction reason is required.",
    });
  }

  // Failed status without a failure reason (server-side backstop).
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FAILURE_REASON_REQUIRED: a failure reason is required for Failed status" },
    }));
    await check(
      "server-side failure-reason-required denied",
      await correctFaxAttempt(baseInput, client),
      { ok: false, error: "A failure reason is required for Failed status." },
    );
  }

  // Unknown attempt.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "NOT_FOUND: attempt does not exist" },
    }));
    await check("missing attempt denied", await correctFaxAttempt(baseInput, client), {
      ok: false,
      error: "That fax attempt no longer exists.",
    });
  }

  // Stale-write conflict.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "CONFLICT: attempt was changed by someone else since it was loaded" },
    }));
    await check("stale conflict denied", await correctFaxAttempt(baseInput, client), {
      ok: false,
      error: "This attempt was updated by someone else. Reload and try again.",
    });
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
      await correctFaxAttempt({ ...baseInput, attemptId: "not-a-uuid" }, client),
      { ok: false, error: "Invalid fax attempt." },
    );
    await check(
      "blank reason rejected without a call",
      await correctFaxAttempt({ ...baseInput, reason: "   " }, client),
      { ok: false, error: "A correction reason is required." },
    );
    await check(
      "blank status rejected without a call",
      await correctFaxAttempt({ ...baseInput, status: "" }, client),
      { ok: false, error: "Choose a status." },
    );
    await check(
      "Failed without failure reason rejected without a call",
      await correctFaxAttempt({ ...baseInput, status: "Failed", failureReason: "" }, client),
      { ok: false, error: "A failure reason is required for Failed status." },
    );
    await check("no rpc call made for invalid input", called, false);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll correct-attempt checks passed.");
}

await run();
