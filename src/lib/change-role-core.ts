export type AppRole = "admin" | "staff";

export type ChangeRoleInput = { targetUserId: string; newRole: AppRole };

export type ChangeRoleResult =
  | {
      ok: true;
      targetUserId: string;
      targetUsername: string | null;
      oldRole: AppRole;
      newRole: AppRole;
    }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the caller-scoped Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface ChangeRoleRpcClient {
  rpc(
    fn: "change_user_role",
    args: { _target_user_id: string; _new_role: AppRole },
  ): PromiseLike<{
    data:
      | {
          target_user_id: string;
          target_username: string | null;
          old_role: AppRole;
          new_role: AppRole;
        }[]
      | null;
    error: { message: string } | null;
  }>;
}

// The database function is the sole source of truth for these checks (it
// re-verifies the caller's role from auth.uid(), not anything the browser
// sent); these prefixes are its distinguishing error codes.
function friendlyError(message: string): string {
  if (message.startsWith("FORBIDDEN")) return "Only administrators can change roles.";
  if (message.startsWith("SELF_DEMOTION")) return "You cannot change your own role.";
  if (message.startsWith("LAST_ADMIN")) return "Cannot remove the last remaining admin.";
  if (message.startsWith("NOT_FOUND")) return "That account no longer exists.";
  return "Unable to change this role. Please try again.";
}

export async function changeUserRole(
  data: ChangeRoleInput,
  client: ChangeRoleRpcClient,
): Promise<ChangeRoleResult> {
  if (!UUID_RE.test(data.targetUserId)) {
    return { ok: false, error: "Invalid account." };
  }
  if (data.newRole !== "admin" && data.newRole !== "staff") {
    return { ok: false, error: "Choose a role of Staff or Admin." };
  }

  const { data: rows, error } = await client.rpc("change_user_role", {
    _target_user_id: data.targetUserId,
    _new_role: data.newRole,
  });
  if (error) {
    return { ok: false, error: friendlyError(error.message) };
  }
  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: "Unable to change this role. Please try again." };
  }
  return {
    ok: true,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    oldRole: row.old_role,
    newRole: row.new_role,
  };
}
