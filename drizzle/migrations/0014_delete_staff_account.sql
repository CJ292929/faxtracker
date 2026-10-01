-- P3-P13: permanently delete a staff/admin account (the Supabase Auth user
-- plus its public.user_logins/public.user_roles mappings) from Staff
-- Access, as a single atomic, admin-gated operation.
--
-- Mirrors the two closest precedents in this schema:
--   - change_user_role (0007/0008): SECURITY DEFINER, re-checks the
--     caller's role from auth.uid() (never trusts the browser), rejects
--     self-mutation, and serializes against the "never zero admins"
--     invariant with an advisory lock so concurrent requests can't both
--     observe "more than one admin" and both proceed.
--   - delete_patient_permanently (0012): a confirmation token the client
--     must echo back (here, the account's username) so a stale/mismatched
--     UI state can't delete the wrong account, plus a minimal audit_logs
--     event recorded in the same transaction as the delete.
--
-- auth.users is an ordinary table in this same Postgres database (the
-- bootstrap_first_admin trigger already installed by 0000 is proof
-- migrations run with privileges over the auth schema), and Supabase's own
-- auth tables (identities, sessions, refresh_tokens, etc.) all cascade from
-- auth.users via FKs Supabase itself defines. Deleting the auth.users row
-- here, in the same transaction as the mapping cleanup, both performs the
-- "Supabase Auth account" deletion and makes the whole operation
-- all-or-nothing: if any step fails, the entire transaction (including any
-- role/login rows already deleted) rolls back, so a failed attempt always
-- leaves a clean, unmodified state that is safe to retry.
--
-- public.user_logins.user_id already has `REFERENCES auth.users(id) ON
-- DELETE CASCADE` (0004), so it would be removed automatically once
-- auth.users is deleted; it is still deleted explicitly here so the
-- function behaves identically even if that FK is ever changed, and so a
-- user_logins row can never outlive its account. public.user_roles.user_id
-- has no FK to auth.users (by design, see 0000), so it is always deleted
-- explicitly -- this is also what cleans up an orphaned role row for an
-- account whose login mapping was already lost some other way. None of
-- documents.uploaded_by/assigned_staff, fax_attempts.created_by,
-- document_files.uploaded_by, or audit_logs.user_id reference auth.users,
-- so historical attribution on patient/document/fax/audit records is
-- always left untouched by this function.
CREATE OR REPLACE FUNCTION public.delete_staff_account(
  _target_user_id uuid,
  _expected_username text
)
RETURNS TABLE (target_user_id uuid, target_username text, target_role public.app_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _caller_role public.app_role;
  _target_role public.app_role;
  _target_username text;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Same advisory lock key as change_user_role: account deletion and role
  -- changes both mutate the "at least one admin" invariant, so the two
  -- operations must serialize against each other too, not just against
  -- themselves.
  PERFORM pg_advisory_xact_lock(hashtext('public.change_user_role'));

  SELECT role INTO _caller_role FROM public.user_roles WHERE user_id = _caller_id;
  IF _caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'FORBIDDEN: only administrators can delete accounts' USING ERRCODE = '28000';
  END IF;

  IF _target_user_id = _caller_id THEN
    RAISE EXCEPTION 'SELF_DELETE: you cannot delete your own account' USING ERRCODE = '28000';
  END IF;

  SELECT username INTO _target_username FROM public.user_logins WHERE user_id = _target_user_id;
  IF _target_username IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: account does not exist' USING ERRCODE = 'P0002';
  END IF;

  -- Confirmation token: the client must echo back the exact username shown
  -- in the confirmation dialog, so a stale/mismatched UI state cannot
  -- delete the wrong account.
  IF _expected_username IS DISTINCT FROM _target_username THEN
    RAISE EXCEPTION 'CONFLICT: username does not match this account';
  END IF;

  SELECT role INTO _target_role FROM public.user_roles WHERE user_id = _target_user_id;

  IF _target_role = 'admin' THEN
    IF (SELECT count(*) FROM public.user_roles WHERE role = 'admin') <= 1 THEN
      RAISE EXCEPTION 'LAST_ADMIN: cannot delete the last remaining admin' USING ERRCODE = '23514';
    END IF;
  END IF;

  DELETE FROM public.user_roles WHERE user_id = _target_user_id;
  DELETE FROM public.user_logins WHERE user_id = _target_user_id;
  DELETE FROM auth.users WHERE id = _target_user_id;

  -- Minimal audit event: actor, time (created_at default), the deleted
  -- account's username and prior role -- never a password.
  INSERT INTO public.audit_logs (user_id, action, description)
  VALUES (
    _caller_id,
    'account_deleted',
    format('Deleted %s account: %s', coalesce(_target_role::text, 'unassigned'), _target_username)
  );

  RETURN QUERY SELECT _target_user_id, _target_username, _target_role;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_staff_account(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_staff_account(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_staff_account(uuid, text) FROM anon;
