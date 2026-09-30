export type DeletePatientInput = { patientId: string; confirmPatientCode: string };

export type DeletePatientResult =
  | {
      ok: true;
      patientId: string;
      documentsDeleted: number;
      attemptsDeleted: number;
      filesDeleted: number;
      storagePaths: string[];
    }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the caller-scoped Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface DeletePatientRpcClient {
  rpc(
    fn: "delete_patient_permanently",
    args: { _patient_id: string; _expected_patient_code: string },
  ): PromiseLike<{
    data:
      | {
          patient_id: string;
          documents_deleted: number;
          attempts_deleted: number;
          files_deleted: number;
          storage_paths: string[] | null;
        }[]
      | null;
    error: { message: string } | null;
  }>;
}

// The database function is the sole source of truth for these checks (it
// re-verifies the caller's role from auth.uid(), not anything the browser
// sent); these prefixes are its distinguishing error codes.
function friendlyError(message: string): string {
  if (message.startsWith("FORBIDDEN"))
    return "Only admin or staff accounts can permanently delete patients.";
  if (message.startsWith("NOT_FOUND")) return "That patient no longer exists.";
  if (message.startsWith("CONFLICT"))
    return "Confirmation did not match this patient. Reload and try again.";
  return "Unable to delete this patient. Please try again.";
}

export async function deletePatientPermanently(
  data: DeletePatientInput,
  client: DeletePatientRpcClient,
): Promise<DeletePatientResult> {
  if (!UUID_RE.test(data.patientId)) {
    return { ok: false, error: "Invalid patient." };
  }
  if (!data.confirmPatientCode.trim()) {
    return { ok: false, error: "Type the patient ID to confirm deletion." };
  }

  const { data: rows, error } = await client.rpc("delete_patient_permanently", {
    _patient_id: data.patientId,
    _expected_patient_code: data.confirmPatientCode.trim(),
  });
  if (error) {
    return { ok: false, error: friendlyError(error.message) };
  }
  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: "Unable to delete this patient. Please try again." };
  }
  return {
    ok: true,
    patientId: row.patient_id,
    documentsDeleted: row.documents_deleted,
    attemptsDeleted: row.attempts_deleted,
    filesDeleted: row.files_deleted,
    storagePaths: row.storage_paths ?? [],
  };
}
