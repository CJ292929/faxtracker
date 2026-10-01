import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deleteStaffAccount,
  type DeleteAccountInput,
  type DeleteAccountResult,
} from "./delete-account-core";

function isDeleteAccountInput(data: unknown): data is DeleteAccountInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d["targetUserId"] === "string" && typeof d["confirmUsername"] === "string";
}

// The caller's identity comes from context.supabase, which auth-middleware
// scopes to the request's verified Bearer token (auth.uid() inside the
// database function), never from anything in `data`. The database function
// itself performs the atomic admin re-check, self/last-admin guards,
// mapping cleanup, Supabase Auth user delete, and audit insert.
export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): DeleteAccountInput => {
    if (!isDeleteAccountInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<DeleteAccountResult> => {
    return deleteStaffAccount(data, context.supabase);
  });
