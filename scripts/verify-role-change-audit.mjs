#!/usr/bin/env node
// Static regression check covering two incidents:
//  - P3-P2R: a real account (cjlonzaga29) was silently demoted via the
//    Settings "Staff Access" role dropdown, with no audit trail and rows
//    labeled only by an 8-char id prefix, not a username.
//  - P3-P2R2: the dropdown still mutated the role immediately, with no
//    confirmation, and the audit_logs write was best-effort (a failed
//    insert did not roll back the role change).
// This asserts both fixes stay in place: role changes require an explicit
// confirmation, and the role update + audit entry happen atomically through
// the change_user_role database function (see
// drizzle/migrations/0007_confirm_and_audit_role_changes.sql and
// scripts/test-role-change-live.mjs for the transactional proof).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "src/routes/settings.tsx"), "utf8");
const failures = [];

if (/async function changeRole\(/.test(src)) {
  failures.push(
    "changeRole() still mutates the role directly from the dropdown's onChange — role changes must go through a confirmation step.",
  );
}

if (!/setPendingChange\(/.test(src)) {
  failures.push("Settings no longer stages a pending role change for confirmation.");
}

if (!/<AlertDialog[\s>]/.test(src)) {
  failures.push("Settings no longer renders a confirmation dialog before changing a role.");
}

if (!/async function confirmChangeRole\(/.test(src)) {
  failures.push("confirmChangeRole() not found in settings.tsx.");
}
const confirmBody = src.slice(src.indexOf("async function confirmChangeRole("));
if (!/changeStaffRole\(/.test(confirmBody)) {
  failures.push(
    "confirmChangeRole() no longer calls the changeStaffRole server function — role update and audit insert must happen atomically server-side, not as two best-effort client writes.",
  );
}
if (/\.from\("user_roles"\)\s*\.\s*update\(/.test(confirmBody)) {
  failures.push(
    "confirmChangeRole() writes to user_roles directly from the client — this bypasses the server-side admin recheck and atomic audit insert.",
  );
}

if (!/from ["']@\/lib\/change-role\.server["']/.test(src)) {
  failures.push("settings.tsx no longer imports changeStaffRole from the server function module.");
}

if (!/r\.username/.test(src)) {
  failures.push(
    "Staff Access rows no longer display r.username — regressing to an ambiguous id-prefix label makes it easy to change the wrong account.",
  );
}

// The server function must forward the caller-scoped client (whose
// auth.uid() the database re-verifies), never a service-role client that
// would erase who the caller actually is.
const serverSrc = readFileSync(path.join(root, "src/lib/change-role.server.ts"), "utf8");
if (!/context\.supabase/.test(serverSrc)) {
  failures.push(
    "change-role.server.ts no longer forwards the caller-scoped context.supabase client — the database function relies on auth.uid() from the caller's own verified token.",
  );
}
if (/supabaseAdmin/.test(serverSrc)) {
  failures.push(
    "change-role.server.ts uses the service-role client for the role-change RPC — that would make auth.uid() resolve to nothing inside the database function, defeating the server-side admin recheck.",
  );
}

const coreSrc = readFileSync(path.join(root, "src/lib/change-role-core.ts"), "utf8");
if (!/change_user_role/.test(coreSrc)) {
  failures.push("change-role-core.ts no longer calls the change_user_role database function.");
}

if (failures.length) {
  console.error("role-change-audit verification FAILED:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  "role-change-audit verification passed: role changes require confirmation and are updated + audited atomically server-side.",
);
