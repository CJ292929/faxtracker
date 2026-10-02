-- P3-P15: add Referring MD NPI and Referring MD Office Number to patients.
-- Referring MD Fax Number already exists as referring_physician_fax (0000)
-- and is reused as-is -- only relabeled in the UI -- so this migration adds
-- exactly the two columns that were missing. Both are nullable text (NPI is
-- stored as text, not numeric, to preserve leading zeros/formatting per
-- spec) and never backfilled -- existing patients show "Not specified"
-- until staff/admin fill them in.
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS referring_physician_npi text;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS referring_physician_office_phone text;

-- Defense in depth alongside the client/import-time check: when provided,
-- an NPI must be exactly 10 digits. NULL and '' both pass (CHECK ignores
-- NULL; '' is explicitly allowed since the app normalizes blank inputs to
-- '' rather than NULL on write, matching the other nullable text columns).
ALTER TABLE public.patients
  ADD CONSTRAINT patients_referring_physician_npi_format
  CHECK (referring_physician_npi IS NULL OR referring_physician_npi = '' OR referring_physician_npi ~ '^[0-9]{10}$');
