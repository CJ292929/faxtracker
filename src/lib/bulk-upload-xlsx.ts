import { TEMPLATE_HEADERS, MAX_FILE_BYTES, parseRows, type ParseResult } from "./bulk-upload";

export const TEMPLATE_FILENAME = "patient-bulk-upload-template.xlsx";

// Columns that must round-trip as text (preserve leading zeros, "+1 ext."
// formatting, etc.) rather than being auto-coerced to a number by Excel.
const TEXT_FORMAT_COLUMNS = new Set([
  TEMPLATE_HEADERS.indexOf("Referring MD NPI"),
  TEMPLATE_HEADERS.indexOf("Referring MD Office Number"),
  TEMPLATE_HEADERS.indexOf("Referring MD Fax Number"),
]);

export async function downloadPatientTemplate(): Promise<void> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const instructions = [
    ["NYC Home Rehab Fax Tracker — Patient Bulk Upload Template"],
    [""],
    ['1. Fill in the "Patients" sheet only. Do not rename, reorder, add, or remove columns.'],
    [
      '2. Name (required): full name in one cell, e.g. "John Smith". Include a first and last name.',
    ],
    ["3. DOB: date of birth in MM/DD/YYYY format. Optional, but recommended."],
    [
      "4. Member ID, Patient Phone, Insurance, Referring MD, Referring MD NPI, Referring MD Office Number, and Referring MD Fax Number are all optional.",
    ],
    [
      "5. Referring MD NPI, if provided, must be exactly 10 digits. Leave it blank if unknown — do not guess.",
    ],
    [
      '6. Referring MD NPI, Referring MD Office Number, and Referring MD Fax Number are formatted as text in this template to preserve leading zeros and formatting (e.g. extensions) — keep that "Text" cell format when filling them in.',
    ],
    [
      "7. A previously downloaded six-column template (Name, Member ID, DOB, Phone, Insurance, Referring MD) is also accepted on upload; its Phone column is treated as Patient Phone.",
    ],
    ["8. Do not put real patient data in this blank template — only in your completed copy."],
    ['9. Save as .xlsx and upload it on the Patients tab using "Bulk Upload Patients".'],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(instructions), "Instructions");
  const patientsSheet = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS]]);
  // Pre-format the new text-only columns down several hundred rows so Excel
  // keeps treating pasted/typed values (leading zeros, "+1 ext. 2", etc.) as
  // text instead of silently coercing them to a number.
  const TEMPLATE_ROWS = 500;
  for (let r = 0; r <= TEMPLATE_ROWS; r++) {
    for (const c of TEXT_FORMAT_COLUMNS) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const existing = patientsSheet[ref];
      patientsSheet[ref] = { t: "s", v: existing?.v ?? "", z: "@" };
    }
  }
  const lastCol = TEMPLATE_HEADERS.length - 1;
  patientsSheet["!ref"] = XLSX.utils.encode_range(
    { r: 0, c: 0 },
    { r: TEMPLATE_ROWS, c: lastCol },
  );
  XLSX.utils.book_append_sheet(workbook, patientsSheet, "Patients");
  XLSX.writeFile(workbook, TEMPLATE_FILENAME);
}

export async function parseUploadedFile(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase();
  if (!name.endsWith(".xlsx")) {
    return {
      fileErrors: [`Unsupported file type. Upload the .xlsx template (got "${file.name}").`],
      rows: [],
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      fileErrors: [
        `File is too large (${Math.round(file.size / 1024)} KB). Maximum is ${Math.round(MAX_FILE_BYTES / 1024)} KB.`,
      ],
      rows: [],
    };
  }
  if (file.size === 0) {
    return { fileErrors: ["File is empty."], rows: [] };
  }
  const XLSX = await import("xlsx");
  let workbook: ReturnType<typeof XLSX.read>;
  try {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    return {
      fileErrors: [
        "Could not read this file. Make sure it is a valid, uncorrupted .xlsx workbook.",
      ],
      rows: [],
    };
  }
  const sheetName = workbook.SheetNames.includes("Patients") ? "Patients" : workbook.SheetNames[0];
  if (!sheetName) return { fileErrors: ["Workbook has no sheets."], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { fileErrors: ["Workbook has no readable sheet."], rows: [] };
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  return parseRows(aoa);
}
