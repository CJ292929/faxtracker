<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep patient records, fax history, and uploads in Lovable Cloud with staff-gated row and private-file policies; medical data must never use browser-only persistence.
- Keep the patient-first interface in a shared authenticated shell with dedicated content routes; this preserves direct navigation and route-specific metadata.
- Demo records are database-seeded with `is_demo`, not recreated by page loads; this keeps preview data distinct from actual records.

- Patient profile creation, editing, and permanent delete are allowed for both admin and staff; anonymous and role-less accounts are denied server-side. Delete is permanent: `public.delete_patient_permanently` (SECURITY DEFINER, re-checks the caller's role from `auth.uid()`) atomically removes the patient, their documents, fax attempts, correction history, and file records, records a minimal audit event, and queues attachment storage paths in `patient_file_cleanup_queue` for durable removal (drained by `scripts/retry-patient-file-cleanup.mjs`). There is no restore.
- Reports export from the currently filtered client-side dataset to CSV, Excel, and PDF; this mirrors visible records without a separate reporting service.
