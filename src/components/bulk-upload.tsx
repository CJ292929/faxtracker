import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Upload, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/forms";
import { supabase } from "@/integrations/supabase/client";
import { useApp } from "@/lib/app-context";
import { canManagePatients } from "@/lib/fax";
import {
  TEMPLATE_HEADERS,
  LEGACY_TEMPLATE_HEADERS,
  assignPatientIds,
  markDuplicatesAgainstExisting,
  normField,
  type BulkRow,
} from "@/lib/bulk-upload";
import { parseUploadedFile } from "@/lib/bulk-upload-xlsx";

type Outcome = "created" | "skipped" | "failed" | "conflict";
type RowResult = { row: BulkRow; outcome: Outcome; detail: string; patientId?: string };
type Step = "select" | "review" | "importing" | "results";

export function BulkUploadModal({ onClose }: { onClose: () => void }) {
  const { patients, refresh, role } = useApp();
  const [step, setStep] = useState<Step>("select");
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<RowResult[]>([]);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setBusy(true);
    try {
      const parsed = await parseUploadedFile(file);
      if (parsed.fileErrors.length) {
        setFileErrors(parsed.fileErrors);
        setRows([]);
        return;
      }
      markDuplicatesAgainstExisting(parsed.rows, patients);
      assignPatientIds(
        parsed.rows,
        patients.map((p) => p.patient_id),
      );
      setFileErrors([]);
      setRows(parsed.rows);
      setSelected(
        new Set(
          parsed.rows
            .filter((r) => r.errors.length === 0 && !r.duplicateInFile && !r.duplicateExisting)
            .map((r) => r.row),
        ),
      );
      setStep("review");
    } catch (e) {
      setFileErrors([e instanceof Error ? e.message : "Could not read this file."]);
      setRows([]);
    } finally {
      setBusy(false);
    }
  }

  const totals = useMemo(
    () => ({
      total: rows.length,
      valid: rows.filter((r) => r.errors.length === 0).length,
      invalid: rows.filter((r) => r.errors.length > 0).length,
      dupFile: rows.filter((r) => r.duplicateInFile).length,
      dupExisting: rows.filter((r) => r.duplicateExisting).length,
      selected: selected.size,
    }),
    [rows, selected],
  );

  function toggle(row: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });
  }

  // Queries by the row's stable Patient ID to resolve an ambiguous insert
  // response (lost network response, or a UNIQUE-constraint collision).
  // Never overwrites: a mismatched occupant stops the row as a conflict
  // instead of retrying or reporting success.
  async function resolveAmbiguousInsert(row: BulkRow, reason: string): Promise<RowResult> {
    const patientId = row.patientId;
    const { data, error } = await supabase
      .from("patients")
      .select(
        "first_name, last_name, date_of_birth, phone, insurance, insurance_member_id, referring_physician, referring_physician_npi, referring_physician_office_phone, referring_physician_fax",
      )
      .eq("patient_id", patientId)
      .maybeSingle();
    if (error) {
      return { row, outcome: "failed", detail: `${reason}; verification failed: ${error.message}` };
    }
    if (!data) {
      return {
        row,
        outcome: "failed",
        detail: `${reason} Not yet created — retry will reuse Patient ID ${patientId}.`,
      };
    }
    // Every mapped imported field must match the existing row (consistent
    // trim+lowercase normalization) before treating it as the same import --
    // a differing field is a conflict, never an overwrite.
    const fieldsMatch =
      normField(data.first_name) === normField(row.first_name) &&
      normField(data.last_name) === normField(row.last_name) &&
      (data.date_of_birth ?? "") === (row.date_of_birth ?? "") &&
      normField(data.phone) === normField(row.phone) &&
      normField(data.insurance) === normField(row.insurance) &&
      normField(data.insurance_member_id) === normField(row.member_id) &&
      normField(data.referring_physician) === normField(row.referring_physician) &&
      normField(data.referring_physician_npi) === normField(row.referring_physician_npi) &&
      normField(data.referring_physician_office_phone) ===
        normField(row.referring_physician_office_phone) &&
      normField(data.referring_physician_fax) === normField(row.referring_physician_fax);
    if (fieldsMatch) {
      return { row, outcome: "created", detail: "Verified as already created", patientId };
    }
    return {
      row,
      outcome: "conflict",
      detail: `Patient ID ${patientId} already belongs to a different patient — stopped to avoid overwriting.`,
    };
  }

  async function insertRow(row: BulkRow): Promise<RowResult> {
    const patientId = row.patientId;
    const { error, status } = await supabase.from("patients").insert({
      first_name: row.first_name,
      last_name: row.last_name,
      patient_id: patientId,
      date_of_birth: row.date_of_birth,
      phone: row.phone || null,
      insurance: row.insurance || null,
      insurance_member_id: row.member_id || null,
      referring_physician: row.referring_physician || null,
      referring_physician_npi: row.referring_physician_npi || null,
      referring_physician_office_phone: row.referring_physician_office_phone || null,
      referring_physician_fax: row.referring_physician_fax || null,
    });
    if (!error) return { row, outcome: "created", detail: "Imported", patientId };
    // status 0 / empty code means the client never got a real server
    // response (network drop, timeout) -- the insert may have committed.
    if (status === 0 && !error.code) {
      return resolveAmbiguousInsert(row, "Network error during insert.");
    }
    // A UNIQUE violation on patient_id means a row with this ID already
    // exists -- either our own earlier attempt committed (retry-safe) or a
    // genuine collision with a different patient.
    if (error.code === "23505") {
      return resolveAmbiguousInsert(row, "Patient ID already exists.");
    }
    return { row, outcome: "failed", detail: error.message };
  }

  async function runImport(rowsToImport: BulkRow[]) {
    if (!canManagePatients(role)) {
      toast.error("Only admin or staff accounts can import patients.");
      return;
    }
    setStep("importing");
    setBusy(true);
    const outcomes: RowResult[] = [];
    for (const row of rows) {
      if (!rowsToImport.includes(row)) {
        outcomes.push({
          row,
          outcome: "skipped",
          detail: row.errors.length ? "Validation error" : "Not selected",
        });
        continue;
      }
      outcomes.push(await insertRow(row));
    }
    setResults(outcomes);
    setBusy(false);
    setStep("results");
    await refresh();
  }

  function confirmImport() {
    const toImport = rows.filter((r) => selected.has(r.row) && r.errors.length === 0);
    void runImport(toImport);
  }

  function retryFailed() {
    const failedRows = results.filter((r) => r.outcome === "failed").map((r) => r.row);
    void runImport(failedRows);
  }

  const created = results.filter((r) => r.outcome === "created").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  const conflicted = results.filter((r) => r.outcome === "conflict").length;

  return (
    <Modal title="Bulk Upload Patients" onClose={onClose}>
      {step === "select" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a completed copy of the patient bulk-upload template (.xlsx). Expected columns,
            in order: <strong>{TEMPLATE_HEADERS.join(" | ")}</strong>. A previously downloaded
            six-column template (<strong>{LEGACY_TEMPLATE_HEADERS.join(" | ")}</strong>) is also
            accepted — its Phone column is treated as Patient Phone.
          </p>
          {fileErrors.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <ul className="list-inside list-disc space-y-1">
                {fileErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground hover:border-primary hover:text-primary">
            <Upload />
            {busy ? "Reading file…" : "Click to choose your completed .xlsx template"}
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <div className="flex justify-end gap-2 border-t pt-5">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <ReviewStat label="Rows" value={totals.total} />
            <ReviewStat label="Valid" value={totals.valid} />
            <ReviewStat label="Errors" value={totals.invalid} tone="text-destructive" />
            <ReviewStat label="Dup in file" value={totals.dupFile} tone="text-amber-600" />
            <ReviewStat
              label="Possible existing match"
              value={totals.dupExisting}
              tone="text-amber-600"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Rows with validation errors cannot be imported. Duplicates are flagged but not selected
            by default — review and check them only if you are sure they are new patients.
          </p>
          <div className="table-wrap max-h-96 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Member ID</th>
                  <th>DOB</th>
                  <th>Patient Phone</th>
                  <th>Insurance</th>
                  <th>Referring MD</th>
                  <th>Referring MD NPI</th>
                  <th>Referring MD Office Number</th>
                  <th>Referring MD Fax Number</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? "bg-destructive/5" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.row)}
                        disabled={r.errors.length > 0}
                        onChange={() => toggle(r.row)}
                      />
                    </td>
                    <td>{r.row}</td>
                    <td>{r.rawName || "—"}</td>
                    <td>{r.member_id || "—"}</td>
                    <td>{r.date_of_birth ?? (r.dobRaw || "—")}</td>
                    <td>{r.phone || "—"}</td>
                    <td>{r.insurance || "—"}</td>
                    <td>{r.referring_physician || "—"}</td>
                    <td>{r.referring_physician_npi || "—"}</td>
                    <td>{r.referring_physician_office_phone || "—"}</td>
                    <td>{r.referring_physician_fax || "—"}</td>
                    <td className="text-xs">
                      {r.errors.map((e) => (
                        <div key={e} className="flex items-center gap-1 text-destructive">
                          <AlertTriangle size={12} /> {e}
                        </div>
                      ))}
                      {r.duplicateInFile && (
                        <div className="flex items-center gap-1 text-amber-600">
                          <AlertTriangle size={12} /> Duplicate in file
                        </div>
                      )}
                      {r.duplicateExisting && (
                        <div className="flex items-center gap-1 text-amber-600">
                          <AlertTriangle size={12} /> Possible match: {r.duplicateExisting.name} (
                          {r.duplicateExisting.patient_id})
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 border-t pt-5">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={totals.selected === 0} onClick={confirmImport}>
              Import {totals.selected} Patient{totals.selected === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <p className="py-10 text-center text-sm text-muted-foreground">Importing patients…</p>
      )}

      {step === "results" && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <ReviewStat label="Created" value={created} tone="text-green-600" />
            <ReviewStat label="Skipped" value={skipped} />
            <ReviewStat label="Failed" value={failed} tone="text-destructive" />
            <ReviewStat label="Conflict" value={conflicted} tone="text-amber-600" />
          </div>
          <div className="table-wrap max-h-96 overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.row.row}>
                    <td>{r.row.row}</td>
                    <td>{r.row.rawName || "—"}</td>
                    <td className="flex items-center gap-1">
                      {r.outcome === "created" && (
                        <CheckCircle2 size={14} className="text-green-600" />
                      )}
                      {(r.outcome === "failed" || r.outcome === "conflict") && (
                        <XCircle size={14} className="text-destructive" />
                      )}
                      {r.outcome}
                    </td>
                    <td className="text-xs text-muted-foreground">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 border-t pt-5">
            {failed > 0 && (
              <Button type="button" variant="outline" disabled={busy} onClick={retryFailed}>
                Retry {failed} Failed Row{failed === 1 ? "" : "s"}
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ReviewStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}
