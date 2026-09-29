import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { changeUserRole, type ChangeRoleInput, type ChangeRoleResult } from "./change-role-core";

function isChangeRoleInput(data: unknown): data is ChangeRoleInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d["targetUserId"] === "string" && (d["newRole"] === "admin" || d["newRole"] === "staff")
  );
}

// The caller's identity comes from context.supabase, which auth-middleware
// scopes to the request's verified Bearer token (auth.uid() inside the
// database function), never from anything in `data`.
export const changeStaffRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): ChangeRoleInput => {
    if (!isChangeRoleInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<ChangeRoleResult> => {
    return changeUserRole(data, context.supabase);
  });
