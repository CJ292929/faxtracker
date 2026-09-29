DROP POLICY "Staff edit patients" ON public.patients;
CREATE POLICY "Admins edit patients" ON public.patients FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY "Staff add patients" ON public.patients;
CREATE POLICY "Admins add patients" ON public.patients FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','staff')) $$;