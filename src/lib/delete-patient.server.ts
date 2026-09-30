import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  deletePatientPermanently,
  type DeletePatientInput,
  type DeletePatientResult,
} from "./delete-patient-core";

function isDeletePatientInput(data: unknown): data is DeletePatientInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d["patientId"] === "string" && typeof d["confirmPatientCode"] === "string";
}

export type DeletePatientServerResult = DeletePatientResult & {
  filesPendingCleanup?: number;
};

// The caller's identity comes from context.supabase, which auth-middleware
// scopes to the request's verified Bearer token (auth.uid() inside the
// database function), never from anything in `data`. The database function
// itself performs the atomic delete + audit insert; this wrapper only
// handles the private-storage side effect that cannot live inside a SQL
// transaction (the Storage API is a separate HTTP service).
export const deletePatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): DeletePatientInput => {
    if (!isDeletePatientInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<DeletePatientServerResult> => {
    const result = await deletePatientPermanently(data, context.supabase);
    if (!result.ok || result.storagePaths.length === 0) {
      return result;
    }

    // Service-role client, loaded only inside this server handler: the DB
    // rows are already gone and durably queued in
    // patient_file_cleanup_queue (inserted in the same transaction as the
    // delete), so a failure here never produces a false "nothing was
    // deleted" -- it only means the attachment bytes remain queued for
    // scripts/retry-patient-file-cleanup.mjs to remove on the next run.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const removal = await supabaseAdmin.storage
      .from("patient-documents")
      .remove(result.storagePaths);

    if (removal.error) {
      await supabaseAdmin
        .from("patient_file_cleanup_queue")
        .update({
          attempts: 1,
          last_error: removal.error.message,
          last_attempted_at: new Date().toISOString(),
        })
        .eq("patient_ref", result.patientId)
        .is("done_at", null);
      return { ...result, filesPendingCleanup: result.storagePaths.length };
    }

    await supabaseAdmin
      .from("patient_file_cleanup_queue")
      .delete()
      .eq("patient_ref", result.patientId);

    return { ...result, filesPendingCleanup: 0 };
  });
