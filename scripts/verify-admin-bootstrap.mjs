#!/usr/bin/env node
// Static checks for the "first signup becomes admin" invariant: no signUp() in
// the UI, and a forward migration that removes the bootstrap trigger/function.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(relPath) {
  return readFileSync(path.join(root, relPath), "utf8");
}

const authContext = read("src/lib/app-context.tsx");
if (authContext.includes("supabase.auth.signUp")) {
  failures.push(
    "src/lib/app-context.tsx still calls supabase.auth.signUp — public sign-up is not removed.",
  );
}

const removalMigration = read("drizzle/migrations/0003_remove_bootstrap_first_admin.sql");
if (!/DROP TRIGGER\s+bootstrap_first_admin\s+ON\s+auth\.users/i.test(removalMigration)) {
  failures.push(
    "0003_remove_bootstrap_first_admin.sql does not drop the bootstrap_first_admin trigger.",
  );
}
if (!/DROP FUNCTION\s+public\.bootstrap_first_admin/i.test(removalMigration)) {
  failures.push(
    "0003_remove_bootstrap_first_admin.sql does not drop the bootstrap_first_admin function.",
  );
}

const originalMigration = read("drizzle/migrations/0000_create_fax_tracker.sql");
if (!originalMigration.includes("CREATE TRIGGER bootstrap_first_admin")) {
  failures.push(
    "0000_create_fax_tracker.sql was expected to still define the original trigger (should not be edited); it is missing.",
  );
}

if (failures.length) {
  console.error("admin-bootstrap verification FAILED:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  "admin-bootstrap verification passed: no public signUp() call, and 0003 removes the trigger + function.",
);
