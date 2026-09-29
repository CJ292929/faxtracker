import { TEMPLATE_HEADERS, MAX_FILE_BYTES, parseRows, type ParseResult } from "./bulk-upload";

export const TEMPLATE_FILENAME = "patient-bulk-upload-template.xlsx";

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
    ["4. Member ID, Phone, Insurance, and Referring MD are optional."],
    ["5. Do not put real patient data in this blank template — only in your completed copy."],
    ['6. Save as .xlsx and upload it on the Patients tab using "Bulk Upload Patients".'],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(instructions), "Instructions");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS]]),
    "Patients",
  );
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
