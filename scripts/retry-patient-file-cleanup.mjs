#!/usr/bin/env node
// P3-P11: durable retry for private-storage attachment cleanup left behind by
// public.delete_patient_permanently. Every storage_path for a permanently
// deleted patient is queued into patient_file_cleanup_queue in the same
// transaction as the row deletes (see drizzle/migrations/0012), so a row
// existing here always means "this patient's DB records are already gone
// and this file still needs to be removed from the patient-documents bucket"
// -- never a false success and never a silently-forgotten file.
//
// Safe to run repeatedly (e.g. on a schedule or after a failed delete):
// already-removed paths are treated as success (storage.remove is
// idempotent), and each row is retried independently so one bad path never
// blocks the rest.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
// Run with: node scripts/retry-patient-file-cleanup.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")];
    }),
);

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: pending, error: selectError } = await admin
    .from("patient_file_cleanup_queue")
    .select("id, storage_path, attempts")
    .is("done_at", null)
    .order("queued_at", { ascending: true })
    .limit(500);

  if (selectError) {
    console.error("Failed to read patient_file_cleanup_queue:", selectError.message);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log("No pending attachment cleanup.");
    return;
  }

  console.log(`${pending.length} pending attachment(s) queued for cleanup.`);

  const paths = pending.map((row) => row.storage_path);
  const removal = await admin.storage.from("patient-documents").remove(paths);

  if (removal.error) {
    const message = removal.error.message;
    console.error(`Storage removal failed, will retry next run: ${message}`);
    await admin
      .from("patient_file_cleanup_queue")
      .update({ last_error: message, last_attempted_at: new Date().toISOString() })
      .in(
        "id",
        pending.map((row) => row.id),
      );
    for (const row of pending) {
      await admin
        .from("patient_file_cleanup_queue")
        .update({ attempts: row.attempts ? row.attempts + 1 : 1 })
        .eq("id", row.id);
    }
    process.exit(1);
  }

  const { error: deleteError } = await admin
    .from("patient_file_cleanup_queue")
    .delete()
    .in(
      "id",
      pending.map((row) => row.id),
    );
  if (deleteError) {
    console.error("Storage removal succeeded but clearing the queue failed:", deleteError.message);
    process.exit(1);
  }

  console.log(`Cleaned up ${pending.length} attachment(s).`);
}

await run();
