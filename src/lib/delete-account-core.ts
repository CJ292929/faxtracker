export type AppRole = "admin" | "staff";

export type DeleteAccountInput = { targetUserId: string; confirmUsername: string };

export type DeleteAccountResult =
  | { ok: true; targetUserId: string; username: string; role: AppRole | null }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the caller-scoped Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface DeleteAccountRpcClient {
  rpc(
    fn: "delete_staff_account",
    args: { _target_user_id: string; _expected_username: string },
  ): PromiseLike<{
    data: { target_user_id: string; target_username: string; target_role: AppRole | null }[] | null;
    error: { message: string } | null;
  }>;
}

// The database function is the sole source of truth for these checks (it
// re-verifies the caller's role from auth.uid(), not anything the browser
// sent); these prefixes are its distinguishing error codes.
function friendlyError(message: string): string {
  if (message.startsWith("FORBIDDEN")) return "Only administrators can delete accounts.";
  if (message.startsWith("SELF_DELETE")) return "You cannot delete your own account.";
  if (message.startsWith("LAST_ADMIN")) return "Cannot delete the last remaining admin.";
  if (message.startsWith("NOT_FOUND")) return "That account no longer exists.";
  if (message.startsWith("CONFLICT")) return "Username does not match this account.";
  return "Unable to delete this account. Please try again.";
}

export async function deleteStaffAccount(
  data: DeleteAccountInput,
  client: DeleteAccountRpcClient,
): Promise<DeleteAccountResult> {
  if (!UUID_RE.test(data.targetUserId)) {
    return { ok: false, error: "Invalid account." };
  }
  const confirmUsername = data.confirmUsername.trim().toLowerCase();
  if (!confirmUsername) {
    return { ok: false, error: "Type the username to confirm deletion." };
  }

  const { data: rows, error } = await client.rpc("delete_staff_account", {
    _target_user_id: data.targetUserId,
    _expected_username: confirmUsername,
  });
  if (error) {
    return { ok: false, error: friendlyError(error.message) };
  }
  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: "Unable to delete this account. Please try again." };
  }
  return {
    ok: true,
    targetUserId: row.target_user_id,
    username: row.target_username,
    role: row.target_role,
  };
}
