# Project destinations

- GitHub: https://github.com/CJ292929/faxtracker
- Supabase project ID: `iobrhrefxeirrmbnaiob` (set in `supabase/config.toml`)
- Vercel account: https://vercel.com/cj178

Do not point local `.env` or `supabase/config.toml` at any other Supabase project ID.

## Required environment variables

Create a local `.env` (never committed) with these names, values from the
`iobrhrefxeirrmbnaiob` Supabase project settings:

- `SUPABASE_PROJECT_ID`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only (used by `src/integrations/supabase/client.server.ts`); never expose via a `VITE_`-prefixed name or client code.
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`
- `LOVABLE_CRON_SECRET` — validates scheduled/cron request auth.
- `LOVABLE_CRON_SECRET_PREVIOUS` — optional, allows in-flight rotation of the cron secret.

Migrations under `drizzle/migrations` additionally read `LOVABLE_DB_MIGRATION_URL`
when run via `drizzle-kit` (see `drizzle.config.ts`). This project has not applied
migrations to the `iobrhrefxeirrmbnaiob` project yet — see the initial-admin
provisioning note below before doing so.

Set all of the above (except `LOVABLE_DB_MIGRATION_URL`, which is a local/CI-only
migration credential) as Vercel Project → Settings → Environment Variables. Do not
put `SUPABASE_SERVICE_ROLE_KEY` in a `VITE_`-prefixed variable or in any value that
reaches the client bundle.

## Vercel build

This app builds through Nitro's native `vercel` preset (Vercel Build Output API
v3), configured in `vite.config.ts` (`nitro: { preset: "vercel" }`), overriding
the shared `@lovable.dev/vite-tanstack-config` default of `cloudflare-module`.

- **Build command:** `bun run build` (equivalently `vite build`; the Nitro/Vercel
  step runs automatically as part of this, no separate command needed).
- **Output directory:** none to configure manually — Vercel's framework
  auto-detection reads the build output directly from `.vercel/output`
  (`config.json` version 3, a `static/` asset directory, and the
  `functions/__server.func` Node serverless function). Do not set a Vercel
  "Output Directory" override; leave it on the default so Vercel picks up
  `.vercel/output` as-is.
- **Install command:** `bun install` (project is pinned to bun via `bun.lock`).
- **Framework preset in Vercel dashboard:** "Other" — do not select the Next.js
  preset; Vercel will use the pre-built `.vercel/output` directory as-is once it
  detects the Build Output API structure.

## Package manager

This project is pinned to **bun** (`bun.lock`). Use bun for install and scripts,
not npm/pnpm/yarn, to avoid lockfile drift.

## Validation commands

```sh
bun install
bunx tsc --noEmit               # typecheck
bun run lint                    # eslint (repo-wide baseline still has pre-existing findings outside touched files)
bun run build                   # vite + nitro build, emits .vercel/output
bun run verify:admin-bootstrap  # static checks for this invariant, see below
```

`verify:admin-bootstrap` is a static source/migration-file check only. It cannot
confirm migration `0003_remove_bootstrap_first_admin.sql` was actually applied to
any database — run the SQL verification query in the "Initial admin provisioning"
section below against the target database to confirm that.

## Resolved: first-signup-becomes-admin

`drizzle/migrations/0000_create_fax_tracker.sql` defined a trigger
(`bootstrap_first_admin`) that fired `AFTER INSERT ON auth.users` and granted the
`admin` role to whichever user row was inserted first, if `user_roles` was empty.
The UI (`src/lib/app-context.tsx`) exposed a public sign-up form
(`supabase.auth.signUp`) with no invite gate, so on a fresh deployment the first
person to submit the sign-up form — authenticated or not — became admin, before
any confirmation step completed.

Both parts are now removed:

- `src/lib/app-context.tsx` no longer offers a sign-up form or calls
  `supabase.auth.signUp`. The auth screen only supports sign-in (password or the
  pre-existing Google OAuth button) for accounts that already exist.
- `drizzle/migrations/0003_remove_bootstrap_first_admin.sql` is a new forward
  migration that drops the `bootstrap_first_admin` trigger and function. It does
  not add a replacement automatic admin grant. Existing migrations 0000-0002 are
  unmodified so any environment that already applied them can apply 0003 on top.

Residual note: the "Continue with Google" button is an existing, unmodified
login path. Supabase auto-provisions an `auth.users` row for a first-time Google
sign-in, so a visitor can still cause an (unprivileged) account to exist. With
the bootstrap trigger removed, that account gets no role and lands on the
"Access pending" screen with no data access — it is not a privilege-escalation
path, but if your organization wants to fully close public account creation,
that button should also be removed or gated separately.

## Initial admin provisioning (manual, owner-controlled)

There is no automatic admin grant. Do this once per environment, after applying
`0003_remove_bootstrap_first_admin.sql`, to grant the first administrator. Safe
to run whether the database is fresh or already has users/roles, because it
targets one specific person and upserts by their unique `user_id`.

1. **Create the person's sign-in credential out-of-band** (you, the owner —
   not the applicant): Supabase Dashboard → Authentication → Users → "Add
   user", or invite them via the dashboard's invite/magic-link flow. Do not
   handle or store their chosen password yourself; let Supabase's flow collect
   it directly from them.
2. **Find their auth UUID.** Either copy it from the Users list in the
   dashboard, or run in the SQL editor:
   ```sql
   select id, email from auth.users where email = 'person@example.com';
   ```
3. **Grant the `admin` role** by upserting into `public.user_roles` from the
   Supabase SQL editor (or any connection using the service-role key — this
   table's RLS otherwise requires an existing admin, which is exactly the
   bootstrap problem being avoided here):
   ```sql
   insert into public.user_roles (user_id, role)
   values ('<their-auth-uuid>', 'admin')
   on conflict (user_id) do update set role = excluded.role;
   ```
4. **Verify** exactly one admin row exists for that person and that no
   bootstrap trigger remains:
   ```sql
   select u.id, u.email, r.role
   from auth.users u
   join public.user_roles r on r.user_id = u.id
   where u.email = 'person@example.com';
   -- expect one row, role = 'admin'

   select tgname from pg_trigger where tgname = 'bootstrap_first_admin';
   -- expect zero rows once migration 0003 has been applied
   ```

Once at least one admin exists, subsequent staff accounts can be created the
same way (step 1-2) and then granted a role from the app's Settings page by an
existing admin, or via the same SQL upsert with `role = 'staff'`.
