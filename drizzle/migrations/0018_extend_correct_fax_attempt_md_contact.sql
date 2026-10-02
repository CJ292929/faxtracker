-- P3-P16: correct_fax_attempt (0011, extended by 0013 for md_name and 0015
-- for recipient fields) must also accept/persist the new MD NPI / MD Office
-- Number / MD Fax fields (0017) so a correction can fix them the same
-- audited way it fixes status/notes/md_name/recipient_*. Postgres functions
-- are identified by name + argument types, so adding parameters requires
-- dropping the old 12-arg signature before recreating it with the new
-- 15-arg one (CREATE OR REPLACE alone would just add an overload).
DROP FUNCTION IF EXISTS public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.correct_fax_attempt(
  _attempt_id uuid,
  _expected_updated_at timestamptz,
  _attempted_at timestamptz,
  _status text,
  _failure_reason text,
  _confirmation_number text,
  _notes text,
  _reason text,
  _md_name text,
  _recipient_type text,
  _recipient_name text,
  _recipient_fax text,
  _md_npi text,
  _md_office_phone text,
  _md_fax text
)
RETURNS TABLE (
  id uuid, document_id uuid, attempt_number integer, attempted_at timestamptz,
  status text, failure_reason text, confirmation_number text, notes text, updated_at timestamptz, md_name text,
  recipient_type text, recipient_name text, recipient_fax text,
  md_npi text, md_office_phone text, md_fax text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _before public.fax_attempts%ROWTYPE;
  _caller_username text;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.is_staff(_caller_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can correct fax attempts' USING ERRCODE = '28000';
  END IF;

  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a correction reason is required' USING ERRCODE = '23514';
  END IF;

  IF _status = 'Failed' AND (_failure_reason IS NULL OR btrim(_failure_reason) = '') THEN
    RAISE EXCEPTION 'FAILURE_REASON_REQUIRED: a failure reason is required for Failed status' USING ERRCODE = '23514';
  END IF;

  IF _md_npi IS NOT NULL AND btrim(_md_npi) <> '' AND btrim(_md_npi) !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'MD_NPI_INVALID: MD NPI must be exactly 10 digits' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.correct_fax_attempt:' || _attempt_id::text));

  SELECT fa.* INTO _before FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: attempt does not exist' USING ERRCODE = 'P0002';
  END IF;

  IF _before.updated_at IS DISTINCT FROM _expected_updated_at THEN
    RAISE EXCEPTION 'CONFLICT: attempt was changed by someone else since it was loaded';
  END IF;

  -- attempt_number, document_id, created_by, created_at are never touched.
  UPDATE public.fax_attempts fa SET
    attempted_at = _attempted_at,
    status = _status,
    failure_reason = NULLIF(btrim(_failure_reason), ''),
    confirmation_number = NULLIF(btrim(_confirmation_number), ''),
    notes = NULLIF(btrim(_notes), ''),
    md_name = NULLIF(btrim(_md_name), ''),
    recipient_type = NULLIF(btrim(_recipient_type), ''),
    recipient_name = NULLIF(btrim(_recipient_name), ''),
    recipient_fax = NULLIF(btrim(_recipient_fax), ''),
    md_npi = NULLIF(btrim(_md_npi), ''),
    md_office_phone = NULLIF(btrim(_md_office_phone), ''),
    md_fax = NULLIF(btrim(_md_fax), ''),
    updated_at = clock_timestamp()
  WHERE fa.id = _attempt_id;

  SELECT username INTO _caller_username FROM public.user_logins WHERE user_id = _caller_id;

  INSERT INTO public.fax_attempt_corrections (attempt_id, corrected_by, corrected_by_username, reason, before, after)
  VALUES (_attempt_id, _caller_id, _caller_username, _reason, to_jsonb(_before), to_jsonb((SELECT fa FROM public.fax_attempts fa WHERE fa.id = _attempt_id)));

  INSERT INTO public.audit_logs (user_id, document_id, action, description)
  VALUES (
    _caller_id,
    _before.document_id,
    'fax_attempt_corrected',
    format('Corrected attempt #%s: status %s -> %s (%s)', _before.attempt_number, _before.status, _status, _reason)
  );

  RETURN QUERY SELECT fa.id, fa.document_id, fa.attempt_number, fa.attempted_at, fa.status, fa.failure_reason, fa.confirmation_number, fa.notes, fa.updated_at, fa.md_name,
    fa.recipient_type, fa.recipient_name, fa.recipient_fax,
    fa.md_npi, fa.md_office_phone, fa.md_fax
    FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text, text, text, text, text, text, text, text) FROM anon;
