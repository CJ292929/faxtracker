import { USERNAME_RE } from "./username-login-core.ts";

export { USERNAME_RE };

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

// Private, non-routable internal email convention for username-only accounts.
// Never shown to the admin after creation; RFC 2606 reserves .invalid for this.
export function internalEmailFor(username: string): string {
  return `${username}@users.invalid`;
}

export type AppRole = "admin" | "staff";

export type CreateLoginInput = {
  username: string;
  password: string;
  confirmPassword: string;
  role: AppRole;
};

export type CreateLoginResult =
  { ok: true; username: string; role: AppRole } | { ok: false; error: string };

// Minimal shape of the service-role Supabase client this flow needs, so tests
// can supply fakes without touching the network or real credentials.
export interface CreateLoginAdminClient {
  from(table: "user_logins" | "user_roles" | "audit_logs"): {
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
      createUser(attrs: {
        email: string;
        password: string;
        email_confirm: boolean;
      }): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
      deleteUser(id: string): Promise<unknown>;
    };
  };
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

const GENERIC_ERROR = "Unable to create this login. Please try again.";

export async function createLogin(
  callerUserId: string,
  data: CreateLoginInput,
  admin: CreateLoginAdminClient,
): Promise<CreateLoginResult> {
  // Never trust a role/permission claim from the browser: re-check the
  // caller's role against the database on every call.
  const { data: callerRoleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .maybeSingle();
  if (!callerRoleRow || callerRoleRow["role"] !== "admin") {
    return { ok: false, error: "Only administrators can create logins." };
  }

  const username = normalizeUsername(data.username);
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "Username must be 3-32 characters: lowercase letters, numbers, . or _.",
    };
  }
  if (data.password.length < MIN_PASSWORD_LENGTH || data.password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (data.password !== data.confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }
  if (data.role !== "admin" && data.role !== "staff") {
    return { ok: false, error: "Choose a role of Staff or Admin." };
  }

  const { data: existing } = await admin
    .from("user_logins")
    .select("user_id")
    .eq("username", username)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: "That username is already taken." };
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: internalEmailFor(username),
    password: data.password,
    email_confirm: true,
  });
  const newUserId = created?.user?.id;
  if (createErr || !newUserId) {
    // Most likely a concurrent create just took this username's derived email.
    return { ok: false, error: "That username is already taken." };
  }

  const { error: loginErr } = await admin
    .from("user_logins")
    .insert({ user_id: newUserId, username });
  if (loginErr) {
    await admin.auth.admin.deleteUser(newUserId).catch(() => {});
    return { ok: false, error: "That username is already taken." };
  }

  const { error: roleErr } = await admin
    .from("user_roles")
    .insert({ user_id: newUserId, role: data.role });
  if (roleErr) {
    await admin.auth.admin.deleteUser(newUserId).catch(() => {});
    return { ok: false, error: GENERIC_ERROR };
  }

  try {
    await admin.from("audit_logs").insert({
      user_id: callerUserId,
      action: "account_created",
      description: `Created ${data.role} login: ${username}`,
    });
  } catch {
    // Audit logging is best-effort; do not fail the account-creation response over it.
  }

  return { ok: true, username, role: data.role };
}
