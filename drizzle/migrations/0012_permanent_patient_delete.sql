-- P3-P11: replace recoverable (soft) patient deletion with permanent deletion
-- for admin and staff.
--
-- documents.patient_id, fax_attempts.document_id, and document_files.document_id
-- all reference their parent with no ON DELETE clause (default NO ACTION), so a
-- plain `DELETE FROM patients` would fail with a foreign-key violation. Rather
-- than adding ON DELETE CASCADE (which would let a stray client-side DELETE on
-- documents silently take fax_attempts/document_files with it), this migration
-- adds a single SECURITY DEFINER function that re-checks the caller's role from
-- auth.uid() (never trusts the browser), takes an advisory lock, deletes the
-- patient's documents/attempts/files/patient row atomically, records a minimal
-- audit event, and queues any attachment storage paths for durable cleanup --
-- mirroring the pattern already established by public.change_user_role
-- (0007/0008) and public.correct_fax_attempt (0011).
--
-- No new DELETE RLS policy is added anywhere: the function runs as its owner
-- (the migration role), which already has full privileges on these tables, so
-- client-side DELETE access to patients/documents/fax_attempts/document_files
-- remains exactly as narrow as it was before this migration (in practice,
-- none -- there has never been a DELETE policy on any of these tables).

-- Durable outbox for private-storage attachment cleanup: populated in the same
-- transaction as the row deletes below, so a queued path is guaranteed to
-- exist for every deleted document_files row even if the app crashes or the
-- storage API call that follows fails. A worker (service role only, see
-- scripts/retry-patient-file-cleanup.mjs) drains this table and retries failed
-- removals; it is never exposed to anon/authenticated.
CREATE TABLE public.patient_file_cleanup_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_path text NOT NULL,
  -- Deliberately not a foreign key: by the time this row is inserted, the
  -- patient it references has already been deleted (same as audit_logs.patient_id).
  patient_ref uuid NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  last_attempted_at timestamptz,
  done_at timestamptz
);
CREATE INDEX patient_file_cleanup_queue_pending_idx
  ON public.patient_file_cleanup_queue (queued_at) WHERE done_at IS NULL;
ALTER TABLE public.patient_file_cleanup_queue ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.patient_file_cleanup_queue TO service_role;
-- No policy, no grant to authenticated/anon: only delete_patient_permanently
-- (as the table owner, below) and the service-role cleanup worker ever touch it.

CREATE OR REPLACE FUNCTION public.delete_patient_permanently(
  _patient_id uuid,
  _expected_patient_code text
)
RETURNS TABLE (
  patient_id uuid,
  documents_deleted integer,
  attempts_deleted integer,
  files_deleted integer,
  storage_paths text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller_id uuid := auth.uid();
  _actual_code text;
  _paths text[];
  _doc_count integer;
  _attempt_count integer;
  _file_count integer;
BEGIN
  IF _caller_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT public.is_staff(_caller_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: only staff or admin accounts can permanently delete patients' USING ERRCODE = '28000';
  END IF;

  -- Serialize deletes of the same patient so a duplicate/racing submit (e.g. a
  -- fast double-click) cannot both pass the existence check below; the second
  -- caller instead gets NOT_FOUND once the first has committed.
  PERFORM pg_advisory_xact_lock(hashtext('public.delete_patient_permanently:' || _patient_id::text));

  SELECT p.patient_id INTO _actual_code FROM public.patients p WHERE p.id = _patient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: patient does not exist' USING ERRCODE = 'P0002';
  END IF;

  -- Confirmation token: the client must echo back the patient_id code shown in
  -- the confirmation dialog, so a stale/mismatched UI state cannot delete the
  -- wrong record.
  IF _actual_code IS DISTINCT FROM _expected_patient_code THEN
    RAISE EXCEPTION 'CONFLICT: patient record does not match the confirmation code';
  END IF;

  SELECT coalesce(array_agg(df.storage_path), '{}')
  INTO _paths
  FROM public.document_files df
  JOIN public.documents d ON d.id = df.document_id
  WHERE d.patient_id = _patient_id;

  SELECT count(*) INTO _file_count
  FROM public.document_files df
  JOIN public.documents d ON d.id = df.document_id
  WHERE d.patient_id = _patient_id;

  DELETE FROM public.fax_attempts fa
    USING public.documents d
    WHERE fa.document_id = d.id AND d.patient_id = _patient_id;
  GET DIAGNOSTICS _attempt_count = ROW_COUNT;

  DELETE FROM public.document_files df
    USING public.documents d
    WHERE df.document_id = d.id AND d.patient_id = _patient_id;

  DELETE FROM public.documents d WHERE d.patient_id = _patient_id;
  GET DIAGNOSTICS _doc_count = ROW_COUNT;

  DELETE FROM public.patients WHERE id = _patient_id;

  IF array_length(_paths, 1) > 0 THEN
    INSERT INTO public.patient_file_cleanup_queue (storage_path, patient_ref)
    SELECT path, _patient_id FROM unnest(_paths) AS path;
  END IF;

  -- Minimal audit event: actor, time (created_at default), and a
  -- non-identifying reference (the patient's uuid, already the convention for
  -- audit_logs.patient_id -- no name/DOB/etc is ever written here).
  INSERT INTO public.audit_logs (user_id, patient_id, action, description)
  VALUES (
    _caller_id,
    _patient_id,
    'patient_deleted_permanently',
    format('Permanently deleted patient (documents=%s, attempts=%s, files=%s)', _doc_count, _attempt_count, _file_count)
  );

  RETURN QUERY SELECT _patient_id, _doc_count, _attempt_count, _file_count, _paths;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_patient_permanently(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_patient_permanently(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_patient_permanently(uuid, text) FROM anon;