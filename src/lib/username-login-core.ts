export const GENERIC_ERROR = "Invalid username or password for this login type.";
export const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

export type LoginInput = { username: string; password: string; portal: "admin" | "staff" };

export type LoginResult =
  { ok: true; access_token: string; refresh_token: string } | { ok: false; error: string };

// Minimal shape of the two Supabase clients this flow needs, so tests can
// supply fakes without touching the network or real credentials.
export interface AdminClient {
  from(table: "user_logins" | "user_roles"): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): { maybeSingle(): Promise<{ data: Record<string, unknown> | null }> };
    };
  };
  auth: {
    admin: {
      getUserById(
        id: string,
      ): Promise<{ data: { user: { email?: string | null } | null } | null; error: unknown }>;
      signOut(jwt: string, scope: "global"): Promise<unknown>;
    };
  };
}

export interface AnonClient {
  auth: {
    signInWithPassword(creds: { email: string; password: string }): Promise<{
      data: { session: { access_token: string; refresh_token: string } | null };
      error: unknown;
    }>;
  };
}

export async function resolveUsernameLogin(
  data: LoginInput,
  admin: AdminClient,
  anon: AnonClient,
): Promise<LoginResult> {
  const username = data.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username) || data.password.length < 1) {
    return { ok: false, error: GENERIC_ERROR };
  }

  const { data: login } = await admin
    .from("user_logins")
    .select("user_id")
    .eq("username", username)
    .maybeSingle();
  if (!login) return { ok: false, error: GENERIC_ERROR };
  const userId = login["user_id"] as string;

  const { data: userResult, error: userErr } = await admin.auth.admin.getUserById(userId);
  const email = userResult?.user?.email;
  if (userErr || !email) return { ok: false, error: GENERIC_ERROR };

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password: data.password,
  });
  if (signInErr || !signIn.session) return { ok: false, error: GENERIC_ERROR };

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (!roleRow || roleRow["role"] !== data.portal) {
    await admin.auth.admin.signOut(signIn.session.access_token, "global").catch(() => {});
    return { ok: false, error: GENERIC_ERROR };
  }

  return {
    ok: true,
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
  };
}
