#!/usr/bin/env node
// Static regression check for the P3-P2R incident: a real account
// (cjlonzaga29) was silently demoted via the Settings "Staff Access" role
// dropdown, and the change left no trace because changeRole() never wrote to
// audit_logs and rows were labeled only by an 8-char id prefix, not a
// username. This asserts the fix stays in place.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(path.join(root, "src/routes/settings.tsx"), "utf8");
const failures = [];

if (!/async function changeRole\(/.test(src)) {
  failures.push("changeRole() not found in settings.tsx.");
}

const changeRoleBody = src.slice(src.indexOf("async function changeRole("));
if (!/from\("audit_logs"\)\s*\.\s*insert\(/.test(changeRoleBody)) {
  failures.push("changeRole() no longer writes an audit_logs entry when a role is changed.");
}
if (!/role_changed/.test(changeRoleBody)) {
  failures.push('changeRole() audit entry no longer uses a distinct "role_changed" action.');
}

if (!/r\.username/.test(src)) {
  failures.push(
    "Staff Access rows no longer display r.username — regressing to an ambiguous id-prefix label makes it easy to change the wrong account.",
  );
}

if (failures.length) {
  console.error("role-change-audit verification FAILED:");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log(
  "role-change-audit verification passed: role changes are audited and rows are labeled by username.",
);
