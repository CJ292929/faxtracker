import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { adminOnly } from "./admin-guard.server";
import {
  resetPassword,
  type ResetPasswordAdminClient,
  type ResetPasswordInput,
  type ResetPasswordResult,
} from "./reset-password-core";

const FORBIDDEN = "Only administrators can perform this action.";

function isResetPasswordInput(data: unknown): data is ResetPasswordInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d["targetUserId"] === "string" &&
    typeof d["password"] === "string" &&
    typeof d["confirmPassword"] === "string"
  );
}

export const resetStaffPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): ResetPasswordInput => {
    if (!isResetPasswordInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<ResetPasswordResult> => {
    if (!(await adminOnly(context.userId))) {
      return { ok: false, error: FORBIDDEN };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return resetPassword(
      context.userId,
      data,
      supabaseAdmin as unknown as ResetPasswordAdminClient,
    );
  });
