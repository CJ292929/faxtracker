-- Migration 0001 created RLS policies on storage.objects for bucket_id =
-- 'patient-documents' but never created the bucket itself, so every
-- attachment upload in the Document Upload workflow fails with
-- "Bucket not found". Create the bucket now; keep it private (public =
-- false) since all read/write access is already gated by the policies
-- from 0001 via signed URLs, per AGENTS.md's private-file-policy
-- requirement for patient documents.
INSERT INTO storage.buckets (id, name, public)
SELECT 'patient-documents', 'patient-documents', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'patient-documents');
