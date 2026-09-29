ALTER TABLE public.patients ADD COLUMN deleted_at timestamptz;
DROP POLICY "Admins edit patients" ON public.patients;
CREATE POLICY "Staff edit patients" ON public.patients FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
DROP POLICY "Admins add patients" ON public.patients;
CREATE POLICY "Staff add patients" ON public.patients FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
