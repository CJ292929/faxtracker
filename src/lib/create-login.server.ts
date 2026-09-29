import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  createLogin,
  normalizeUsername,
  USERNAME_RE,
  type AppRole,
  type CreateLoginAdminClient,
  type CreateLoginInput,
  type CreateLoginResult,
} from "./create-login-core";

const FORBIDDEN = "Only administrators can perform this action.";

async function adminOnly(callerUserId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .maybeSingle();
  return data?.role === "admin";
}

function isCreateLoginInput(data: unknown): data is CreateLoginInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d["username"] === "string" &&
    typeof d["password"] === "string" &&
    typeof d["confirmPassword"] === "string" &&
    (d["role"] === "admin" || d["role"] === "staff")
  );
}

export const createStaffOrAdminLogin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): CreateLoginInput => {
    if (!isCreateLoginInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<CreateLoginResult> => {
    if (!(await adminOnly(context.userId))) {
      return { ok: false, error: FORBIDDEN };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return createLogin(context.userId, data, supabaseAdmin as unknown as CreateLoginAdminClient);
  });

export const checkUsernameAvailable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): { username: string } => {
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as Record<string, unknown>)["username"] !== "string"
    ) {
      throw new Error("Invalid request");
    }
    return data as { username: string };
  })
  .handler(async ({ data, context }): Promise<{ available: boolean }> => {
    if (!(await adminOnly(context.userId))) {
      return { available: false };
    }
    const username = normalizeUsername(data.username);
    if (!USERNAME_RE.test(username)) return { available: false };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing } = await supabaseAdmin
      .from("user_logins")
      .select("user_id")
      .eq("username", username)
      .maybeSingle();
    return { available: !existing };
  });

export type UsernameMapRow = { user_id: string; username: string };

// user_logins grants were revoked for anon/authenticated (see
// 0005_lock_down_user_logins_grants.sql), so the client can no longer read
// usernames directly; the Staff Access panel needs this to label existing
// roles by username instead of raw user ids.
export const listUsernames = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UsernameMapRow[]> => {
    if (!(await adminOnly(context.userId))) return [];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("user_logins").select("user_id, username");
    return (data ?? []) as UsernameMapRow[];
  });

export type AccountListRow = { username: string; role: AppRole; created_at: string };

export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountListRow[]> => {
    if (!(await adminOnly(context.userId))) return [];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: logins }, { data: roles }] = await Promise.all([
      supabaseAdmin
        .from("user_logins")
        .select("user_id, username, created_at")
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("user_roles").select("user_id, role"),
    ]);
    const roleByUser = new Map((roles ?? []).map((r) => [r.user_id as string, r.role as AppRole]));
    return (logins ?? [])
      .filter((l) => roleByUser.has(l.user_id as string))
      .map((l) => ({
        username: l.username as string,
        created_at: l.created_at as string,
        role: roleByUser.get(l.user_id as string) as AppRole,
      }));
  });
