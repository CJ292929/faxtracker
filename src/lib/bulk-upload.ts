import type { Patient } from "./fax";
export const TEMPLATE_HEADERS = [
  "Name",
  "Member ID",
  "DOB",
  "Phone",
  "Insurance",
  "Referring MD",
] as const;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 500;
const MAX_LEN = { name: 200, member_id: 100, phone: 50, insurance: 200, referring: 200 } as const;

export type BulkRow = {
  row: number;
  rawName: string;
  first_name: string;
  last_name: string;
  member_id: string;
  dobRaw: string;
  date_of_birth: string | null;
  phone: string;
  insurance: string;
  referring_physician: string;
  errors: string[];
  duplicateInFile: boolean;
  duplicateExisting: { id: string; patient_id: string; name: string } | null;
  patientId: string;
};

export type ParseResult = { fileErrors: string[]; rows: BulkRow[] };

const cell = (row: unknown[], i: number): string => {
  const v = row[i];
  if (v === undefined || v === null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

export function validateHeaders(headerRow: unknown[]): string[] {
  const found = TEMPLATE_HEADERS.map((_, i) => cell(headerRow, i));
  const errors: string[] = [];
  if (headerRow.filter((c) => String(c ?? "").trim() !== "").length !== TEMPLATE_HEADERS.length) {
    errors.push(
      `Expected exactly ${TEMPLATE_HEADERS.length} columns (${TEMPLATE_HEADERS.join(" | ")}), found ${
        headerRow.filter((c) => String(c ?? "").trim() !== "").length
      }.`,
    );
    return errors;
  }
  TEMPLATE_HEADERS.forEach((expected, i) => {
    if ((found[i] ?? "").toLowerCase() !== expected.toLowerCase()) {
      errors.push(`Column ${i + 1} must be "${expected}" (found "${found[i] ?? ""}").`);
    }
  });
  return errors;
}

const MONTHS_31 = new Set([1, 3, 5, 7, 8, 10, 12]);
function daysInMonth(month: number, year: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return MONTHS_31.has(month) ? 31 : 30;
}

export function parseDob(raw: string): { iso: string | null; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { iso: null };
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (mdy) {
    month = Number(mdy[1]);
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  } else {
    return { iso: null, error: `Invalid DOB "${raw}" — use MM/DD/YYYY.` };
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) {
    return { iso: null, error: `Invalid DOB "${raw}" — not a real calendar date.` };
  }
  const isoValue = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (year < 1900)
    return { iso: null, error: `Invalid DOB "${raw}" — year must be 1900 or later.` };
  if (isoValue > todayIso)
    return { iso: null, error: `Invalid DOB "${raw}" — date is in the future.` };
  return { iso: isoValue };
}

function splitName(raw: string): { first: string; last: string; error?: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2)
    return { first: parts[0] ?? "", last: "", error: "Name must include a first and last name." };
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

export function parseRows(aoa: unknown[][]): ParseResult {
  const header = aoa[0] ?? [];
  const headerErrors = validateHeaders(header);
  if (headerErrors.length) return { fileErrors: headerErrors, rows: [] };
  const dataRows = aoa
    .slice(1)
    .map((r, i) => ({ r, sheetRow: i + 2 }))
    .filter(({ r }) => r.some((c) => String(c ?? "").trim() !== ""));
  if (dataRows.length === 0)
    return { fileErrors: ["No data rows found below the header."], rows: [] };
  if (dataRows.length > MAX_ROWS) {
    return {
      fileErrors: [`Too many rows (${dataRows.length}). Maximum is ${MAX_ROWS} per upload.`],
      rows: [],
    };
  }
  const rows: BulkRow[] = dataRows.map(({ r, sheetRow }) => {
    const errors: string[] = [];
    const rawName = cell(r, 0);
    const memberId = cell(r, 1);
    const dobRaw = cell(r, 2);
    const phone = cell(r, 3);
    const insurance = cell(r, 4);
    const referring = cell(r, 5);
    if (!rawName) errors.push("Name is required.");
    const { first, last, error: nameError } = splitName(rawName);
    if (nameError) errors.push(nameError);
    if (rawName.length > MAX_LEN.name) errors.push(`Name exceeds ${MAX_LEN.name} characters.`);
    if (memberId.length > MAX_LEN.member_id)
      errors.push(`Member ID exceeds ${MAX_LEN.member_id} characters.`);
    if (phone.length > MAX_LEN.phone) errors.push(`Phone exceeds ${MAX_LEN.phone} characters.`);
    if (insurance.length > MAX_LEN.insurance)
      errors.push(`Insurance exceeds ${MAX_LEN.insurance} characters.`);
    if (referring.length > MAX_LEN.referring)
      errors.push(`Referring MD exceeds ${MAX_LEN.referring} characters.`);
    const { iso: dob, error: dobError } = parseDob(dobRaw);
    if (dobError) errors.push(dobError);
    return {
      row: sheetRow,
      rawName,
      first_name: first,
      last_name: last,
      member_id: memberId,
      dobRaw,
      date_of_birth: dob,
      phone,
      insurance,
      referring_physician: referring,
      errors,
      duplicateInFile: false,
      duplicateExisting: null,
      patientId: "",
    };
  });
  markDuplicatesInFile(rows);
  return { fileErrors: [], rows };
}

function normName(first: string, last: string): string {
  return `${first} ${last}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function markDuplicatesInFile(rows: BulkRow[]): void {
  const byMember = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (row.member_id) {
      const key = row.member_id.toLowerCase();
      byMember.set(key, [...(byMember.get(key) ?? []), i]);
    }
    const key = normName(row.first_name, row.last_name) + "|" + (row.date_of_birth ?? "");
    byName.set(key, [...(byName.get(key) ?? []), i]);
  });
  for (const idxs of byMember.values()) {
    if (idxs.length > 1)
      idxs.forEach((i) => {
        const r = rows[i];
        if (r) r.duplicateInFile = true;
      });
  }
  for (const idxs of byName.values()) {
    if (idxs.length > 1)
      idxs.forEach((i) => {
        const r = rows[i];
        if (r) r.duplicateInFile = true;
      });
  }
}

export function markDuplicatesAgainstExisting(rows: BulkRow[], existing: Patient[]): void {
  const active = existing.filter((p) => !p.deleted_at);
  for (const row of rows) {
    const match = active.find((p) => {
      if (
        row.member_id &&
        p.insurance_member_id &&
        p.insurance_member_id.toLowerCase() === row.member_id.toLowerCase()
      )
        return true;
      if (row.date_of_birth && p.date_of_birth === row.date_of_birth) {
        return normName(p.first_name, p.last_name) === normName(row.first_name, row.last_name);
      }
      return false;
    });
    if (match)
      row.duplicateExisting = {
        id: match.id,
        patient_id: match.patient_id,
        name: `${match.first_name} ${match.last_name}`,
      };
  }
}

export function generatePatientId(taken: Set<string>): string {
  let id = "";
  do {
    id = `BULK-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

/**
 * Assigns each row a Patient ID once, up front, so the same ID survives
 * every retry in this upload session — retries must reuse it rather than
 * minting a fresh one, or a lost insert response can create the same
 * patient twice under different IDs.
 */
export function assignPatientIds(rows: BulkRow[], existingIds: Iterable<string>): void {
  const taken = new Set(existingIds);
  for (const row of rows) {
    row.patientId = generatePatientId(taken);
  }
}
