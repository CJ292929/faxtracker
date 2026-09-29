import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  resolveUsernameLogin,
  type AdminClient,
  type AnonClient,
  type LoginInput,
  type LoginResult,
} from "./username-login-core";

function serverEnv() {
  const url = process.env["SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  const publishableKey = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !serviceKey || !publishableKey) {
    throw new Error("Server auth is not configured.");
  }
  return { url, serviceKey, publishableKey };
}

// Service-role client: bypasses RLS, never exposed to the browser. Only used
// server-side to resolve username -> user_id/email and to check the role.
function adminClient(url: string, serviceKey: string) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Anon/publishable client: used only to exercise real Supabase password
// verification via signInWithPassword; never persists a session on the server.
function anonClient(url: string, publishableKey: string) {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const loginWithUsername = createServerFn({ method: "POST" })
  .validator((data: unknown): LoginInput => {
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as Record<string, unknown>)["username"] !== "string" ||
      typeof (data as Record<string, unknown>)["password"] !== "string" ||
      ((data as Record<string, unknown>)["portal"] !== "admin" &&
        (data as Record<string, unknown>)["portal"] !== "staff")
    ) {
      throw new Error("Invalid request");
    }
    return data as LoginInput;
  })
  .handler(async ({ data }): Promise<LoginResult> => {
    const { url, serviceKey, publishableKey } = serverEnv();
    const admin = adminClient(url, serviceKey) as unknown as AdminClient;
    const anon = anonClient(url, publishableKey) as unknown as AnonClient;
    return resolveUsernameLogin(data, admin, anon);
  });
