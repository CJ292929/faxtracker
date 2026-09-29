-- Adds a distinct per-document "MD" field (the doctor associated with that
-- specific document), separate from the patient-level referring_physician.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS md_name text;
