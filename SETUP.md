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
- `VITE_SUPABASE_PROJECT_ID`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`

Migrations under `drizzle/migrations` additionally read `LOVABLE_DB_MIGRATION_URL`
when run via `drizzle-kit` (see `drizzle.config.ts`). This project has not applied
migrations to the `iobrhrefxeirrmbnaiob` project yet — see the admin-bootstrap note
below before doing so.

## Package manager

This project is pinned to **bun** (`bun.lock`). Use bun for install and scripts,
not npm/pnpm/yarn, to avoid lockfile drift.

## Validation commands

```sh
bun install
bunx tsc --noEmit   # typecheck
bun run lint        # eslint (currently fails on pre-existing prettier/quote-style findings, not logic errors)
bun run build        # vite + nitro build
```

## Known pre-deployment risk: first-signup-becomes-admin

`drizzle/migrations/0000_create_fax_tracker.sql` defines a trigger
(`bootstrap_first_admin`) that fires `AFTER INSERT ON auth.users` and grants the
`admin` role to whichever user row is inserted first, if `user_roles` is empty.
The UI (`src/lib/app-context.tsx`) exposes a public sign-up form
(`supabase.auth.signUp`) with no invite gate. The trigger fires at signup time,
not at email confirmation, so on a fresh deployment the first person to submit
the sign-up form — authenticated or not — becomes admin, before any confirmation
step completes. `SECURITY.md` already flags "restrict account
registration/invitations to authorized staff" as a pre-production requirement;
this has not yet been implemented. Do not deploy publicly until this is
addressed (e.g., disable public sign-up, or gate the bootstrap trigger behind an
allowlist/invite check).
