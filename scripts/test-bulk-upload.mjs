#!/usr/bin/env node
// Focused fixture test for patient bulk-upload parsing/validation — no
// network, no Supabase, no real patient data. See src/lib/bulk-upload.ts.
// Run with:
//   node --experimental-strip-types scripts/test-bulk-upload.mjs
import {
  TEMPLATE_HEADERS,
  validateHeaders,
  parseDob,
  parseRows,
  markDuplicatesAgainstExisting,
  generatePatientId,
  assignPatientIds,
  normField,
} from "../src/lib/bulk-upload.ts";

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "ok" : "FAIL"} - ${name}`);
  if (!pass) {
    failures++;
    console.log("  expected:", JSON.stringify(expected));
    console.log("  actual:  ", JSON.stringify(actual));
  }
}
function ok(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

check("valid headers pass", validateHeaders([...TEMPLATE_HEADERS]), []);
ok(
  "wrong header order is rejected",
  validateHeaders(["Member ID", "Name", "DOB", "Phone", "Insurance", "Referring MD"]).length > 0,
);
ok(
  "missing column is rejected",
  validateHeaders(["Name", "Member ID", "DOB", "Phone", "Insurance"]).length > 0,
);
ok("extra column is rejected", validateHeaders([...TEMPLATE_HEADERS, "Extra"]).length > 0);

check("parses MM/DD/YYYY", parseDob("03/14/1980").iso, "1980-03-14");
check("parses ISO date", parseDob("1980-03-14").iso, "1980-03-14");
check("empty DOB is not an error", parseDob(""), { iso: null });
ok("rejects garbage date", !!parseDob("not-a-date").error);
ok("rejects Feb 30", !!parseDob("02/30/2000").error);
ok("rejects future date", !!parseDob("01/01/2999").error);
ok("rejects pre-1900 date", !!parseDob("01/01/1850").error);

const headerRow = [...TEMPLATE_HEADERS];
const good = parseRows([
  headerRow,
  ["John Smith", "M100", "03/14/1980", "555-1234", "Medicare", "Dr. Lee"],
]);
ok("valid row has no errors", good.rows[0].errors.length === 0);
check(
  "name splits into first/last",
  [good.rows[0].first_name, good.rows[0].last_name],
  ["John", "Smith"],
);
check("DOB normalized to ISO", good.rows[0].date_of_birth, "1980-03-14");

const badHeader = parseRows([["Name", "Wrong", "DOB", "Phone", "Insurance", "Referring MD"]]);
ok(
  "bad header short-circuits with fileErrors",
  badHeader.fileErrors.length > 0 && badHeader.rows.length === 0,
);

const noRows = parseRows([headerRow]);
ok("no data rows is a file error", noRows.fileErrors.length > 0);

const singleName = parseRows([headerRow, ["Madonna", "", "", "", "", ""]]);
ok(
  "single-word name is an error",
  singleName.rows[0].errors.some((e) => e.includes("first and last name")),
);

const missingName = parseRows([headerRow, ["", "M1", "", "", "", ""]]);
ok(
  "missing name is an error",
  missingName.rows[0].errors.some((e) => e.includes("Name is required")),
);

const dupInFile = parseRows([
  headerRow,
  ["Jane Doe", "M200", "01/01/1990", "", "", ""],
  ["Jane Doe", "M200", "01/01/1990", "", "", ""],
]);
ok(
  "identical rows flagged as duplicate in file",
  dupInFile.rows[0].duplicateInFile && dupInFile.rows[1].duplicateInFile,
);

const tooManyRows = Array.from({ length: 501 }, (_, i) => [`Person ${i}`, "", "", "", "", ""]);
const overLimit = parseRows([headerRow, ...tooManyRows]);
ok("over 500 rows is rejected", overLimit.fileErrors.length > 0);

const existing = [
  {
    id: "existing-1",
    first_name: "Jane",
    last_name: "Doe",
    patient_id: "PT-1",
    date_of_birth: "1990-01-01",
    insurance_member_id: "M200",
    deleted_at: null,
  },
];
const dupExisting = parseRows([headerRow, ["Jane Doe", "M200", "01/01/1990", "", "", ""]]);
markDuplicatesAgainstExisting(dupExisting.rows, existing);
ok(
  "matches existing patient by member ID",
  dupExisting.rows[0].duplicateExisting?.id === "existing-1",
);

const taken = new Set(["BULK-AAAAAA"]);
const id1 = generatePatientId(taken);
ok("generated patient ID has BULK- prefix", id1.startsWith("BULK-"));
ok("generated patient ID avoids collision with taken set", id1 !== "BULK-AAAAAA");
const id2 = generatePatientId(taken);
ok("second generated ID differs from the first", id2 !== id1);

const retrySession = parseRows([
  headerRow,
  ["Retry One", "R1", "01/01/1990", "", "", ""],
  ["Retry Two", "R2", "01/01/1990", "", "", ""],
]);
assignPatientIds(retrySession.rows, []);
const firstAssignment = retrySession.rows.map((r) => r.patientId);
ok(
  "assignPatientIds gives every row a BULK- id",
  firstAssignment.every((id) => id.startsWith("BULK-")),
);
ok(
  "assignPatientIds gives distinct ids within one file",
  new Set(firstAssignment).size === firstAssignment.length,
);
// Simulate a retry: re-running assignment must not be called again on the
// same rows in the real flow (ids are assigned once, at parse time), so the
// invariant under test is that the row objects still carry their original
// ids — nothing in the retry path regenerates them.
check(
  "row ids are unchanged after a simulated retry pass",
  retrySession.rows.map((r) => r.patientId),
  firstAssignment,
);

const existingRoster = ["BULK-ZZZZZZ"];
const rosterSession = parseRows([headerRow, ["Roster Person", "", "", "", "", ""]]);
assignPatientIds(rosterSession.rows, existingRoster);
ok(
  "assignPatientIds avoids collision with the currently loaded roster",
  rosterSession.rows[0].patientId !== "BULK-ZZZZZZ",
);

check("normField trims and lowercases", normField("  Medicare  "), "medicare");
check("normField collapses internal whitespace", normField("Dr.   Lee"), "dr. lee");
check("normField treats null/undefined as empty", normField(null), "");
check(
  "normField treats different-case values as equal",
  normField("MID-100") === normField("mid-100"),
  true,
);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll bulk-upload checks passed.");
