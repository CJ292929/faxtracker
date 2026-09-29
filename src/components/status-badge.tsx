export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'Uploaded' || status === 'Sent Successfully' || status === 'Active' ? 'bg-success/10 text-success' : status === 'Failed' || status === 'Inactive' || status === 'Discharged' ? 'bg-destructive/10 text-destructive' : status === 'Awaiting Upload' || status === 'Pending' ? 'bg-warning/10 text-warning' : 'bg-info/10 text-info';
  return <span className={`inline-flex items-center rounded px-2 py-1 text-[11px] font-bold ${tone}`}>{status}</span>;
}
