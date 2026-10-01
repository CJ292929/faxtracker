#!/usr/bin/env node
// Read-only baseline inspection for P3-P5. Confirms the live schema matches
// migrations 0000-0009 and records real/demo row counts before any change.
// Requires SUPABASE_DB_MIGRATION_URL in .env. Run with:
//   node scripts/p3p5-inspect-baseline.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const sql = postgres(env.SUPABASE_DB_MIGRATION_URL);

try {
  console.log("== columns: documents, fax_attempts, document_files ==");
  const cols = await sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('documents','fax_attempts','document_files','patients')
    ORDER BY table_name, ordinal_position`;
  for (const c of cols) {
    console.log(
      `${c.table_name}.${c.column_name} ${c.data_type} null=${c.is_nullable} default=${c.column_default ?? ""}`,
    );
  }

  console.log("\n== RLS policies: documents, fax_attempts, document_files, patients ==");
  const pols = await sql`
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('documents','fax_attempts','document_files','patients')
    ORDER BY tablename, cmd`;
  for (const p of pols) {
    console.log(`${p.tablename} [${p.cmd}] "${p.policyname}" roles=${p.roles}`);
  }

  console.log("\n== grants: documents, fax_attempts, document_files, patients ==");
  const grants = await sql`
    SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('documents','fax_attempts','document_files','patients')
      AND grantee IN ('authenticated','anon','public')
    GROUP BY table_name, grantee
    ORDER BY table_name, grantee`;
  for (const g of grants) {
    console.log(`${g.table_name} -> ${g.grantee}: ${g.privs}`);
  }

  console.log("\n== row counts (real vs demo) ==");
  for (const t of ["patients", "documents", "fax_attempts", "document_files"]) {
    const hasIsDemo = t !== "document_files";
    if (hasIsDemo) {
      const [row] =
        await sql`SELECT count(*) FILTER (WHERE is_demo) AS demo, count(*) FILTER (WHERE NOT is_demo) AS real FROM ${sql(t)}`;
      console.log(`${t}: real=${row.real} demo=${row.demo}`);
    } else {
      const [row] = await sql`SELECT count(*) AS total FROM ${sql(t)}`;
      console.log(`${t}: total=${row.total}`);
    }
  }

  if ((await sql`SELECT to_regclass('public.patients') AS x`)[0].x) {
    const [row] =
      await sql`SELECT count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted, count(*) FILTER (WHERE deleted_at IS NULL) AS active FROM patients`;
    console.log(`patients soft-delete: active=${row.active} deleted=${row.deleted}`);
  }

  console.log("\n== applied drizzle migrations (if tracked in DB) ==");
  const hasJournal = await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS x`;
  if (hasJournal[0].x) {
    const rows = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at`;
    for (const r of rows) console.log(JSON.stringify(r));
  } else {
    console.log("(no drizzle.__drizzle_migrations table found in live DB)");
  }
} finally {
  await sql.end();
}
