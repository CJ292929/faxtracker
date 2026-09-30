import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "./create-login-core.ts";

export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };

export type ResetPasswordInput = {
  targetUserId: string;
  password: string;
  confirmPassword: string;
};

export type ResetPasswordResult =
  { ok: true; username: string; targetUserId: string } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimal shape of the service-role Supabase client this flow needs, so
// tests can supply fakes without touching the network or real credentials.
export interface ResetPasswordAdminClient {
  from(table: "user_roles" | "user_logins" | "audit_logs"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): { maybeSingle(): Promise<{ data: Record<string, unknown> | null }> };
    };
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
  auth: {
    admin: {
      updateUserById(
        id: string,
        attrs: { password: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
}

const GENERIC_ERROR = "Unable to reset this password. Please try again.";

export async function resetPassword(
  callerUserId: string,
  data: ResetPasswordInput,
  admin: ResetPasswordAdminClient,
): Promise<ResetPasswordResult> {
  // Never trust a role/permission claim from the browser: re-check the
  // caller's role against the database on every call.
  const { data: callerRoleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .maybeSingle();
  if (!callerRoleRow || callerRoleRow["role"] !== "admin") {
    return { ok: false, error: "Only administrators can reset passwords." };
  }

  if (!UUID_RE.test(data.targetUserId)) {
    return { ok: false, error: "Invalid account." };
  }
  if (data.password.length < MIN_PASSWORD_LENGTH || data.password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (data.password !== data.confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const { data: targetLogin } = await admin
    .from("user_logins")
    .select("username")
    .eq("user_id", data.targetUserId)
    .maybeSingle();
  if (!targetLogin) {
    return { ok: false, error: "That account no longer exists." };
  }
  const username = targetLogin["username"] as string;

  const { error: updateErr } = await admin.auth.admin.updateUserById(data.targetUserId, {
    password: data.password,
  });
  if (updateErr) {
    return { ok: false, error: GENERIC_ERROR };
  }

  try {
    await admin.from("audit_logs").insert({
      user_id: callerUserId,
      action: "password_reset",
      description: `Reset password for login: ${username}`,
    });
  } catch {
    // Audit logging is best-effort; do not fail the password-reset response over it.
  }

  return { ok: true, username, targetUserId: data.targetUserId };
}
