-- P3-P2R2: role changes must update user_roles and record an audit_logs
-- entry atomically, re-check the caller is currently admin inside the
-- database (never trust a browser-supplied actor), reject self-demotion,
-- and never leave zero admins even under concurrent requests.
CREATE OR REPLACE FUNCTION public.change_user_role(_target_user_id uuid, _new_role public.app_role)
RETURNS TABLE (target_user_id uuid, target_username text, old_role public.app_role, new_role public.app_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _caller_role public.app_role;
  _current_role public.app_role;
  _target_username text;
  _admin_count integer;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Serialize all role changes so two concurrent admin demotions cannot
  -- both observe "more than one admin" and both proceed.
  PERFORM pg_advisory_xact_lock(hashtext('public.change_user_role'));

  SELECT role INTO _caller_role FROM public.user_roles WHERE user_id = _caller_id;
  IF _caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'FORBIDDEN: only administrators can change roles' USING ERRCODE = '28000';
  END IF;

  IF _target_user_id = _caller_id THEN
    RAISE EXCEPTION 'SELF_DEMOTION: you cannot change your own role' USING ERRCODE = '28000';
  END IF;

  SELECT role INTO _current_role FROM public.user_roles WHERE user_id = _target_user_id;
  IF _current_role IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: target has no assigned role' USING ERRCODE = 'P0002';
  END IF;

  IF _current_role = 'admin' AND _new_role <> 'admin' THEN
    SELECT count(*) INTO _admin_count FROM public.user_roles WHERE role = 'admin';
    IF _admin_count <= 1 THEN
      RAISE EXCEPTION 'LAST_ADMIN: cannot remove the last remaining admin' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT username INTO _target_username FROM public.user_logins WHERE user_id = _target_user_id;

  UPDATE public.user_roles SET role = _new_role WHERE user_id = _target_user_id;

  -- Same transaction as the update above: if this insert fails, the
  -- exception aborts the whole function call and the role update rolls
  -- back with it.
  INSERT INTO public.audit_logs (user_id, action, description)
  VALUES (
    _caller_id,
    'role_changed',
    format(
      'Changed %s from %s to %s',
      coalesce(_target_username, _target_user_id::text),
      _current_role,
      _new_role
    )
  );

  RETURN QUERY SELECT _target_user_id, _target_username, _current_role, _new_role;
END;
$$;

REVOKE ALL ON FUNCTION public.change_user_role(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_user_role(uuid, public.app_role) TO authenticated;
