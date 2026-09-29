-- Supabase's default privileges on the public schema grant EXECUTE on new
-- functions to anon as well as authenticated, so 0007's "REVOKE ALL FROM
-- PUBLIC" did not remove anon's grant (default privileges target the role
-- directly, not the PUBLIC pseudo-role). The function already rejects an
-- unauthenticated caller (auth.uid() IS NULL), but close it at the grant
-- layer too: only signed-in users should ever be able to call this.
REVOKE EXECUTE ON FUNCTION public.change_user_role(uuid, public.app_role) FROM anon;
