#!/usr/bin/env node
// Static regression check for P3-P6: fax-attempt corrections must go
// through the audited correct_fax_attempt database function, never a
// direct client-side update() of fax_attempts, and the server function must
// forward the caller-scoped Supabase client (never a service-role client),
// mirroring the same discipline already enforced for role changes (see
// scripts/verify-role-change-audit.mjs and
// drizzle/migrations/0011_correct_fax_attempts.sql).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const formsSrc = readFileSync(path.join(root, "src/components/forms.tsx"), "utf8");
if (!/export function CorrectAttemptForm\(/.test(formsSrc)) {
  failures.push("forms.tsx no longer exports CorrectAttemptForm.");
}
const correctFormBody = formsSrc.slice(formsSrc.indexOf("export function CorrectAttemptForm("));
const correctFormBodyEnd = correctFormBody.indexOf(
  "\nexport function",
  "export function CorrectAttemptForm(".length,
);
const correctFormOnly =
  correctFormBodyEnd === -1 ? correctFormBody : correctFormBody.slice(0, correctFormBodyEnd);
if (!/correctAttempt\(\{/.test(correctFormOnly)) {
  failures.push(
    "CorrectAttemptForm no longer calls the correctAttempt server function — corrections must go through the audited RPC, not a direct client write.",
  );
}
if (/\.from\(["']fax_attempts["']\)\s*\.\s*update\(/.test(correctFormOnly)) {
  failures.push(
    "CorrectAttemptForm writes to fax_attempts directly — this bypasses the server-side role recheck, stale-write guard, and atomic audit insert.",
  );
}
if (!/name="reason"[^]*?required/.test(correctFormOnly)) {
  failures.push("CorrectAttemptForm no longer requires a correction reason field.");
}

const documentPageSrc = readFileSync(
  path.join(root, "src/routes/documents.$documentId.tsx"),
  "utf8",
);
if (!/CorrectAttemptForm/.test(documentPageSrc)) {
  failures.push("documents.$documentId.tsx no longer renders CorrectAttemptForm.");
}
if (!/canManagePatients\(role\)/.test(documentPageSrc)) {
  failures.push(
    "documents.$documentId.tsx no longer gates the Correct control on canManagePatients(role).",
  );
}

const serverSrc = readFileSync(path.join(root, "src/lib/correct-attempt.server.ts"), "utf8");
if (!/context\.supabase/.test(serverSrc)) {
  failures.push(
    "correct-attempt.server.ts no longer forwards the caller-scoped context.supabase client — the database function relies on auth.uid() from the caller's own verified token.",
  );
}
if (/supabaseAdmin/.test(serverSrc)) {
  failures.push(
    "correct-attempt.server.ts uses the service-role client for the correction RPC — that would make auth.uid() resolve to nothing inside the database function, defeating the server-side staff/admin recheck.",
  );
}

const coreSrc = readFileSync(path.join(root, "src/lib/correct-attempt-core.ts"), "utf8");
if (!/correct_fax_attempt/.test(coreSrc)) {
  failures.push(
    "correct-attempt-core.ts no longer calls the correct_fax_attempt database function.",
  );
}
if (!/expectedUpdatedAt/.test(coreSrc)) {
  failures.push(
    "correct-attempt-core.ts dropped the expectedUpdatedAt field — without it, a stale form could silently overwrite a concurrent correction.",
  );
}

const migrationSrc = readFileSync(
  path.join(root, "drizzle/migrations/0011_correct_fax_attempts.sql"),
  "utf8",
);
if (/DROP\s+POLICY.*DELETE|FOR\s+DELETE/i.test(migrationSrc)) {
  failures.push(
    "0011_correct_fax_attempts.sql adds a DELETE policy on fax_attempts — hard deletion must remain unavailable.",
  );
}
if (!/SECURITY DEFINER/.test(migrationSrc)) {
  failures.push("correct_fax_attempt is no longer SECURITY DEFINER.");
}
if (!/REVOKE EXECUTE ON FUNCTION public\.correct_fax_attempt.*FROM anon/.test(migrationSrc)) {
  failures.push(
    "0011_correct_fax_attempts.sql no longer revokes EXECUTE on correct_fax_attempt from anon (see the 0008 lesson about Supabase's default per-role grants).",
  );
}

if (failures.length) {
  console.error("correct-attempt-audit verification FAILED:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  "correct-attempt-audit verification passed: corrections require a reason and go through the audited, permission-checked, stale-write-guarded correct_fax_attempt RPC.",
);
