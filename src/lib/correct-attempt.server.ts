import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  correctFaxAttempt,
  type CorrectAttemptInput,
  type CorrectAttemptResult,
} from "./correct-attempt-core";

function isCorrectAttemptInput(data: unknown): data is CorrectAttemptInput {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d["attemptId"] === "string" &&
    typeof d["expectedUpdatedAt"] === "string" &&
    typeof d["attemptedAt"] === "string" &&
    typeof d["status"] === "string" &&
    typeof d["failureReason"] === "string" &&
    typeof d["confirmationNumber"] === "string" &&
    typeof d["notes"] === "string" &&
    typeof d["reason"] === "string"
  );
}

// The caller's identity comes from context.supabase, which auth-middleware
// scopes to the request's verified Bearer token (auth.uid() inside the
// database function), never from anything in `data`.
export const correctAttempt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown): CorrectAttemptInput => {
    if (!isCorrectAttemptInput(data)) throw new Error("Invalid request");
    return data;
  })
  .handler(async ({ data, context }): Promise<CorrectAttemptResult> => {
    return correctFaxAttempt(data, context.supabase);
  });
