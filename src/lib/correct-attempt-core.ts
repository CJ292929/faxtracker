export type CorrectAttemptInput = {
  attemptId: string;
  expectedUpdatedAt: string;
  attemptedAt: string;
  status: string;
  failureReason: string;
  confirmationNumber: string;
  notes: string;
  reason: string;
};

export type CorrectAttemptResult =
  | {
      ok: true;
      id: string;
      documentId: string;
      attemptNumber: number;
      attemptedAt: string;
      status: string;
      failureReason: string | null;
      confirmationNumber: string | null;
      notes: string | null;
      updatedAt: string;
    }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the caller-scoped Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface CorrectAttemptRpcClient {
  rpc(
    fn: "correct_fax_attempt",
    args: {
      _attempt_id: string;
      _expected_updated_at: string;
      _attempted_at: string;
      _status: string;
      _failure_reason: string | null;
      _confirmation_number: string | null;
      _notes: string | null;
      _reason: string;
    },
  ): PromiseLike<{
    data:
      | {
          id: string;
          document_id: string;
          attempt_number: number;
          attempted_at: string;
          status: string;
          failure_reason: string | null;
          confirmation_number: string | null;
          notes: string | null;
          updated_at: string;
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
    return "Only admin or staff accounts can correct fax attempts.";
  if (message.startsWith("REASON_REQUIRED")) return "A correction reason is required.";
  if (message.startsWith("FAILURE_REASON_REQUIRED"))
    return "A failure reason is required for Failed status.";
  if (message.startsWith("NOT_FOUND")) return "That fax attempt no longer exists.";
  if (message.startsWith("CONFLICT"))
    return "This attempt was updated by someone else. Reload and try again.";
  return "Unable to correct this attempt. Please try again.";
}

export async function correctFaxAttempt(
  data: CorrectAttemptInput,
  client: CorrectAttemptRpcClient,
): Promise<CorrectAttemptResult> {
  if (!UUID_RE.test(data.attemptId)) {
    return { ok: false, error: "Invalid fax attempt." };
  }
  if (!data.reason.trim()) {
    return { ok: false, error: "A correction reason is required." };
  }
  if (!data.status.trim()) {
    return { ok: false, error: "Choose a status." };
  }
  if (data.status === "Failed" && !data.failureReason.trim()) {
    return { ok: false, error: "A failure reason is required for Failed status." };
  }

  const { data: rows, error } = await client.rpc("correct_fax_attempt", {
    _attempt_id: data.attemptId,
    _expected_updated_at: data.expectedUpdatedAt,
    _attempted_at: data.attemptedAt,
    _status: data.status,
    _failure_reason: data.failureReason.trim() || null,
    _confirmation_number: data.confirmationNumber.trim() || null,
    _notes: data.notes.trim() || null,
    _reason: data.reason,
  });
  if (error) {
    return { ok: false, error: friendlyError(error.message) };
  }
  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: "Unable to correct this attempt. Please try again." };
  }
  return {
    ok: true,
    id: row.id,
    documentId: row.document_id,
    attemptNumber: row.attempt_number,
    attemptedAt: row.attempted_at,
    status: row.status,
    failureReason: row.failure_reason,
    confirmationNumber: row.confirmation_number,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}
