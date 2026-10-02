-- P3-P16: give documents and fax_attempts the same MD contact parity patients
-- already have (referring_physician_npi/office_phone/fax, added by 0016) --
-- MD NPI, MD Office Number, and a dedicated MD Fax Number, independent of
-- the existing recipient_type/recipient_name/recipient_fax trio (the fax
-- destination, which may be an insurer or other party, not the MD). Named
-- md_* to match the existing per-row md_name column (0009, 0013) rather than
-- the patients table's more verbose referring_physician_* naming. Both
-- nullable text, never backfilled -- existing documents/attempts show "Not
-- specified" until staff/admin fill them in.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS md_npi text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS md_office_phone text;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS md_fax text;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_md_npi_format
  CHECK (md_npi IS NULL OR md_npi = '' OR md_npi ~ '^[0-9]{10}$');

ALTER TABLE public.fax_attempts ADD COLUMN IF NOT EXISTS md_npi text;
ALTER TABLE public.fax_attempts ADD COLUMN IF NOT EXISTS md_office_phone text;
ALTER TABLE public.fax_attempts ADD COLUMN IF NOT EXISTS md_fax text;

ALTER TABLE public.fax_attempts
  ADD CONSTRAINT fax_attempts_md_npi_format
  CHECK (md_npi IS NULL OR md_npi = '' OR md_npi ~ '^[0-9]{10}$');
