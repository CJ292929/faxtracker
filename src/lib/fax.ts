import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
export type Patient = Database['public']['Tables']['patients']['Row'];
export type Document = Database['public']['Tables']['documents']['Row'];
export type Attempt = Database['public']['Tables']['fax_attempts']['Row'];
export type FileRecord = Database['public']['Tables']['document_files']['Row'];
export type Correction = Database['public']['Tables']['fax_attempt_corrections']['Row'];
export const documentTypes = ['Initial Evaluation','Progress Note','Re-evaluation','Re-certification Progress Note','Discharge Note','Authorization Packet','Medical Necessity Packet','Appeal Packet'];
export const receivedTypes = ['Signed Initial Evaluation','Signed Progress Note','Signed Re-evaluation','Signed Re-certification','Signed Discharge Note','Approved Authorization','Medical Necessity Documentation','Appeal Response','Other'];
export const faxStatuses = ['Pending','Sent Successfully','Failed','No Answer','Busy','Wrong Number','Cancelled'];
export const nameOf = (p: Patient) => `${p.first_name} ${p.last_name}`;
export const canManagePatients = (role: string) => role === 'admin' || role === 'staff';
export async function restorePatient(patient: Patient, role: string, refresh: () => Promise<void>) {
  if (!canManagePatients(role)) { toast.error('Only admin or staff accounts can restore patients.'); return; }
  const { error } = await supabase.from('patients').update({ deleted_at: null }).eq('id', patient.id);
  if (error) { toast.error(error.message); return; }
  toast.success('Patient restored.');
  await refresh();
}
export const titleOf = (d: Document) => `${d.document_type}${d.document_number ? ` #${d.document_number}` : ''}`;
export const dateOf = (date?: string | null) => date ? new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
export const dateTimeOf = (date?: string | null) => date ? new Date(date).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
export const statusOf = (d: Document, attempts: Attempt[]) => {
  if (d.uploaded) return 'Uploaded';
  if (d.received) return 'Awaiting Upload';
  const own = attempts.filter(a => a.document_id === d.id).sort((a,b)=>b.attempt_number-a.attempt_number);
  if (own.some(a => a.status === 'Sent Successfully')) return 'Awaiting Response';
  if (own.length && own[0]?.status !== 'Pending') return 'Failed';
  return d.status;
};
