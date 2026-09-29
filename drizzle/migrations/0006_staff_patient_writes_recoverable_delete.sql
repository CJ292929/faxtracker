ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
DROP POLICY IF EXISTS "Admins edit patients" ON public.patients;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'patients' AND policyname = 'Staff edit patients'
  ) THEN
    CREATE POLICY "Staff edit patients" ON public.patients FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
  END IF;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS "Admins add patients" ON public.patients;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'patients' AND policyname = 'Staff add patients'
  ) THEN
    CREATE POLICY "Staff add patients" ON public.patients FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
  END IF;
END $$;
