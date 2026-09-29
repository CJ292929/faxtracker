CREATE TABLE public.user_logins (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_.]{3,32}$'), created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.user_logins ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.user_logins TO service_role;
