-- P3-P6: audited corrections for mis-recorded fax attempts.
--
-- fax_attempts has no UPDATE or DELETE RLS policy today (0000_create_fax_tracker.sql),
-- so direct edits/deletes are already impossible for every role -- staff can only add
-- new attempts. This migration adds a single, audited, atomic correction path (never a
-- raw UPDATE policy) so an existing attempt can be fixed without creating another attempt
-- or changing attempt_number, and without exposing hard delete (no DELETE policy is added
-- anywhere in this migration; hard deletion of fax_attempts remains unavailable).
--
-- Pattern mirrors public.change_user_role (0007/0008): a SECURITY DEFINER function that
-- re-checks the caller's role from auth.uid() (never trusts the browser), takes an
-- advisory lock, updates the row and inserts audit records in the same transaction, and
-- is grant-restricted to authenticated (not anon) from the start -- folding in the 0008
-- lesson about Supabase's default per-role grants instead of needing a follow-up migration.

-- Optimistic-concurrency token: the correction dialog submits the updated_at it loaded,
-- and a concurrent correction in between makes the second submit fail with CONFLICT
-- instead of silently overwriting the first correction.
ALTER TABLE public.fax_attempts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE public.fax_attempt_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.fax_attempts(id) ON DELETE CASCADE,
  corrected_by uuid NOT NULL,
  -- Denormalized at write time: public.user_logins has no client SELECT
  -- grant at all (0005_lock_down_user_logins_grants.sql revokes it from
  -- both anon and authenticated), so the UI cannot join corrected_by to a
  -- username itself. correct_fax_attempt() below runs SECURITY DEFINER and
  -- can read user_logins, so it resolves and stores the name once here.
  corrected_by_username text,
  corrected_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX corrections_attempt_idx ON public.fax_attempt_corrections(attempt_id);

GRANT SELECT ON public.fax_attempt_corrections TO authenticated;
GRANT ALL ON public.fax_attempt_corrections TO service_role;
ALTER TABLE public.fax_attempt_corrections ENABLE ROW LEVEL SECURITY;
-- No INSERT/UPDATE/DELETE policy: rows are written only by
-- correct_fax_attempt() below, which (as the table owner) bypasses RLS the
-- same way public.change_user_role already does for audit_logs.
CREATE POLICY "Staff read correction history" ON public.fax_attempt_corrections
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.correct_fax_attempt(
  _attempt_id uuid,
  _expected_updated_at timestamptz,
  _attempted_at timestamptz,
  _status text,
  _failure_reason text,
  _confirmation_number text,
  _notes text,
  _reason text
)
RETURNS TABLE (
  id uuid, document_id uuid, attempt_number integer, attempted_at timestamptz,
  status text, failure_reason text, confirmation_number text, notes text, updated_at timestamptz
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

  -- Serialize concurrent corrections of the same attempt so two overlapping
  -- submits cannot both pass the stale-write check below.
  PERFORM pg_advisory_xact_lock(hashtext('public.correct_fax_attempt:' || _attempt_id::text));

  -- Table alias required throughout: this function's RETURNS TABLE declares
  -- an OUT parameter named "id" (and others) that would otherwise shadow
  -- fax_attempts.id and make every bare column reference ambiguous.
  --
  -- Plain SELECT, not SELECT ... FOR UPDATE: the advisory lock above already
  -- serializes concurrent corrections of this same attempt, so a row lock is
  -- unnecessary here.
  SELECT fa.* INTO _before FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: attempt does not exist' USING ERRCODE = 'P0002';
  END IF;

  -- ERRCODE 'P0001' (the default for a bare RAISE EXCEPTION), not '40001'
  -- (serialization_failure): pairing this SECURITY DEFINER function's
  -- pooled connection with the standard "retry me" SQLSTATE class 40 code
  -- was observed to make PostgREST/Supavisor hang for ~15s+ instead of
  -- returning the error, even though the identical call resolves in well
  -- under a second as a direct SQL statement or once a different SQLSTATE
  -- is raised. 'P0001' avoids whatever retry/special-case machinery keys
  -- off class-40 codes upstream of this function.
  IF _before.updated_at IS DISTINCT FROM _expected_updated_at THEN
    RAISE EXCEPTION 'CONFLICT: attempt was changed by someone else since it was loaded';
  END IF;

  -- attempt_number, document_id, created_by, created_at are never touched:
  -- this corrects the existing attempt in place, it does not create a new
  -- one and it preserves who originally recorded it and when.
  -- clock_timestamp() (real wall-clock time), not now() (frozen at
  -- transaction start): two corrections issued in unlucky-fast succession
  -- must still get strictly increasing concurrency tokens even if they
  -- somehow land in the same transaction's timeframe.
  UPDATE public.fax_attempts fa SET
    attempted_at = _attempted_at,
    status = _status,
    failure_reason = NULLIF(btrim(_failure_reason), ''),
    confirmation_number = NULLIF(btrim(_confirmation_number), ''),
    notes = NULLIF(btrim(_notes), ''),
    updated_at = clock_timestamp()
  WHERE fa.id = _attempt_id;

  SELECT username INTO _caller_username FROM public.user_logins WHERE user_id = _caller_id;

  -- Same transaction as the update above: if either insert fails, the
  -- exception aborts the whole function call and the attempt update rolls
  -- back with it (see public.change_user_role for the same pattern).
  INSERT INTO public.fax_attempt_corrections (attempt_id, corrected_by, corrected_by_username, reason, before, after)
  VALUES (_attempt_id, _caller_id, _caller_username, _reason, to_jsonb(_before), to_jsonb((SELECT fa FROM public.fax_attempts fa WHERE fa.id = _attempt_id)));

  INSERT INTO public.audit_logs (user_id, document_id, action, description)
  VALUES (
    _caller_id,
    _before.document_id,
    'fax_attempt_corrected',
    format('Corrected attempt #%s: status %s -> %s (%s)', _before.attempt_number, _before.status, _status, _reason)
  );

  RETURN QUERY SELECT fa.id, fa.document_id, fa.attempt_number, fa.attempted_at, fa.status, fa.failure_reason, fa.confirmation_number, fa.notes, fa.updated_at
    FROM public.fax_attempts fa WHERE fa.id = _attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.correct_fax_attempt(uuid, timestamptz, timestamptz, text, text, text, text, text) FROM anon;
