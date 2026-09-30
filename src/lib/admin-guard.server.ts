// Never trust a role/permission claim from the browser: re-check the
// caller's role against the database on every privileged server function.
export async function adminOnly(callerUserId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", callerUserId)
    .maybeSingle();
  return data?.role === "admin";
}
