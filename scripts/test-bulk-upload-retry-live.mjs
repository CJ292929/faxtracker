#!/usr/bin/env node
// Live retry-safety check for P3-P3R: proves the bulk-upload retry
// invariant against the real database -- a stable Patient ID assigned once
// and reused on every retry, with ambiguous responses resolved by querying
// that ID rather than blindly retrying or overwriting.
//
// This exercises the exact decision logic in
// src/components/bulk-upload.tsx (insertRow / resolveAmbiguousInsert)
// re-implemented here against a real Supabase client so it can be driven
// through simulated network failure, ID collision, and genuine failure
// without a browser. Synthetic rows only; all cleaned up at the end.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
// Run with: node scripts/test-bulk-upload-retry-live.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const stamp = Date.now();
const marker = `RETRY${stamp}`;

// Mirrors resolveAmbiguousInsert() in src/components/bulk-upload.tsx.
async function resolveAmbiguousInsert(row, reason) {
  const { data, error } = await admin
    .from("patients")
    .select("first_name, last_name, date_of_birth")
    .eq("patient_id", row.patientId)
    .maybeSingle();
  if (error)
    return { outcome: "failed", detail: `${reason}; verification failed: ${error.message}` };
  if (!data)
    return {
      outcome: "failed",
      detail: `${reason} Not yet created — retry will reuse ${row.patientId}.`,
    };
  const matches =
    data.first_name === row.first_name &&
    data.last_name === row.last_name &&
    data.date_of_birth === row.date_of_birth;
  if (matches) return { outcome: "created", detail: "Verified as already created" };
  return {
    outcome: "conflict",
    detail: `Patient ID ${row.patientId} belongs to a different patient.`,
  };
}

// Mirrors insertRow(), but takes a `simulateLostResponse` flag to model the
// "DB commit succeeded, response lost" case: the row is inserted directly
// (standing in for a commit that happened) while the return path is treated
// as if the client never saw the response.
async function insertRow(row, { simulateLostResponse = false } = {}) {
  if (simulateLostResponse) {
    await admin.from("patients").insert({
      first_name: row.first_name,
      last_name: row.last_name,
      patient_id: row.patientId,
      date_of_birth: row.date_of_birth,
    });
    // Client's fetch is treated as having failed even though the insert
    // committed -- this is the exact ambiguity insertRow() detects via
    // status === 0 && !error.code.
    return resolveAmbiguousInsert(row, "Network error during insert.");
  }
  const { error } = await admin.from("patients").insert({
    first_name: row.first_name,
    last_name: row.last_name,
    patient_id: row.patientId,
    date_of_birth: row.date_of_birth,
  });
  if (!error) return { outcome: "created", detail: "Imported" };
  if (error.code === "23505") return resolveAmbiguousInsert(row, "Patient ID already exists.");
  return { outcome: "failed", detail: error.message };
}

async function cleanup() {
  await admin.from("patients").delete().ilike("first_name", `${marker}%`);
}

async function main() {
  try {
    // --- Scenario 1: lost response after a real commit. Retry must find
    // the already-created row and report "created", not insert a duplicate.
    const lostRow = {
      first_name: marker,
      last_name: "LostResponse",
      patientId: `BULK-${marker}A`,
      date_of_birth: "1985-05-05",
    };
    const firstAttempt = await insertRow(lostRow, { simulateLostResponse: true });
    check(
      "lost-response row is verified as created on first pass",
      firstAttempt.outcome === "created",
    );
    const retryAttempt = await insertRow(lostRow); // real retry, same stable ID
    check(
      "retry of a lost-response row is verified as created, not duplicated",
      retryAttempt.outcome === "created",
    );
    const { data: lostRows } = await admin
      .from("patients")
      .select("id")
      .eq("patient_id", lostRow.patientId);
    check("exactly one patient exists for the lost-response ID", (lostRows ?? []).length === 1);

    // --- Scenario 2: ID collision with a different patient's data. Must
    // stop as a conflict, never overwrite, never silently retry.
    const occupantRow = {
      first_name: marker,
      last_name: "Occupant",
      patientId: `BULK-${marker}B`,
      date_of_birth: "1970-01-01",
    };
    const { error: occupantErr } = await admin.from("patients").insert({
      first_name: occupantRow.first_name,
      last_name: occupantRow.last_name,
      patient_id: occupantRow.patientId,
      date_of_birth: occupantRow.date_of_birth,
    });
    check("occupant row was seeded for the collision scenario", !occupantErr);
    const collidingRow = {
      first_name: marker,
      last_name: "Newcomer",
      patientId: occupantRow.patientId, // same ID, different patient
      date_of_birth: "1999-09-09",
    };
    const collisionResult = await insertRow(collidingRow);
    check(
      "ID collision with different patient stops as a conflict",
      collisionResult.outcome === "conflict",
    );
    const { data: occupantAfter } = await admin
      .from("patients")
      .select("last_name")
      .eq("patient_id", occupantRow.patientId)
      .maybeSingle();
    check("original occupant row was not overwritten", occupantAfter?.last_name === "Occupant");

    // --- Scenario 3: genuine failed insert (no row ever committed). Must
    // fail cleanly and the same stable ID must remain free for retry.
    const failRow = {
      first_name: marker,
      last_name: "GenuineFail",
      patientId: `BULK-${marker}C`,
      date_of_birth: "not-a-real-date", // invalid date -> insert rejected
    };
    const failResult = await insertRow(failRow);
    check(
      "genuine invalid insert reports failed, not created/conflict",
      failResult.outcome === "failed",
    );
    const { data: noRow } = await admin
      .from("patients")
      .select("id")
      .eq("patient_id", failRow.patientId)
      .maybeSingle();
    check("no row was created for the genuinely failed insert", !noRow);
    const retryWithGoodData = await insertRow({ ...failRow, date_of_birth: "1960-06-06" });
    check(
      "retry with the same ID after a genuine failure succeeds",
      retryWithGoodData.outcome === "created",
    );
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll bulk-upload retry-safety checks passed. Synthetic data cleaned up.");
}

await main();
