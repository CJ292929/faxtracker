#!/usr/bin/env node
// Isolated fixture test for the permanent-delete-patient RPC wrapper: input
// validation and error-message mapping. No network, no real credentials —
// the authoritative checks (staff/admin recheck, atomic delete, audit,
// cleanup-queue insert) live in the database function and are covered by
// scripts/p3p11-patient-delete-live.mjs against an isolated, always-rolled-
// back transaction.
//   node --experimental-strip-types scripts/test-delete-patient.mjs
import { deletePatientPermanently } from "../src/lib/delete-patient-core.ts";

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

const PATIENT = "11111111-1111-1111-1111-111111111111";
const baseInput = { patientId: PATIENT, confirmPatientCode: "PT-001" };

async function run() {
  // Happy path: the database function returns the delete counts + paths.
  {
    const calls = [];
    const client = fakeRpc(async (fn, args) => {
      calls.push([fn, args]);
      return {
        data: [
          {
            patient_id: PATIENT,
            documents_deleted: 2,
            attempts_deleted: 3,
            files_deleted: 1,
            storage_paths: [`${PATIENT}/doc1/file.pdf`],
          },
        ],
        error: null,
      };
    });
    const result = await deletePatientPermanently(baseInput, client);
    await check("success maps db row to result", result, {
      ok: true,
      patientId: PATIENT,
      documentsDeleted: 2,
      attemptsDeleted: 3,
      filesDeleted: 1,
      storagePaths: [`${PATIENT}/doc1/file.pdf`],
    });
    await check("calls delete_patient_permanently with snake_case args", calls, [
      [
        "delete_patient_permanently",
        { _patient_id: PATIENT, _expected_patient_code: baseInput.confirmPatientCode },
      ],
    ]);
  }

  // Null storage_paths from the db maps to an empty array, not null.
  {
    const client = fakeRpc(async () => ({
      data: [
        {
          patient_id: PATIENT,
          documents_deleted: 0,
          attempts_deleted: 0,
          files_deleted: 0,
          storage_paths: null,
        },
      ],
      error: null,
    }));
    const result = await deletePatientPermanently(baseInput, client);
    await check("null storage_paths normalized to []", result.storagePaths, []);
  }

  // FORBIDDEN from the database (role-less/anonymous direct RPC calls that
  // bypass the UI entirely) maps to a friendly error.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "FORBIDDEN: only staff or admin accounts can permanently delete patients" },
    }));
    await check("forbidden caller denied", await deletePatientPermanently(baseInput, client), {
      ok: false,
      error: "Only admin or staff accounts can permanently delete patients.",
    });
  }

  // Unknown patient (e.g. a duplicate submit after the first already deleted it).
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "NOT_FOUND: patient does not exist" },
    }));
    await check("missing patient denied", await deletePatientPermanently(baseInput, client), {
      ok: false,
      error: "That patient no longer exists.",
    });
  }

  // Mismatched confirmation code.
  {
    const client = fakeRpc(async () => ({
      data: null,
      error: { message: "CONFLICT: patient record does not match the confirmation code" },
    }));
    await check(
      "mismatched confirmation code denied",
      await deletePatientPermanently(baseInput, client),
      { ok: false, error: "Confirmation did not match this patient. Reload and try again." },
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
      await deletePatientPermanently({ ...baseInput, patientId: "not-a-uuid" }, client),
      { ok: false, error: "Invalid patient." },
    );
    await check(
      "blank confirmation code rejected without a call",
      await deletePatientPermanently({ ...baseInput, confirmPatientCode: "   " }, client),
      { ok: false, error: "Type the patient ID to confirm deletion." },
    );
    await check("no rpc call made for invalid input", called, false);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll delete-patient checks passed.");
}

await run();
