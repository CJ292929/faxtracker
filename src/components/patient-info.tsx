import { dateOf, nameOf, type Patient } from '@/lib/fax';
// Single shared rendering of the six required patient identity fields, used
// on both the patient detail page and the document detail page's Patient
// Information card, so the two views can never drift out of sync with each
// other. Unlike other field grids in this app (which fall back to "—"),
// these labels stay visible and show "Not specified" when empty per spec.
export function PatientInfoCard({patient}:{patient:Patient|null|undefined}){
  if(!patient)return <p className="text-sm text-muted-foreground">Patient information unavailable.</p>;
  const fields:[string,string|null|undefined][]=[
    ['Name',nameOf(patient)],
    ['Member ID',patient.insurance_member_id],
    ['DOB',patient.date_of_birth?dateOf(patient.date_of_birth):null],
    ['Phone',patient.phone],
    ['Insurance',patient.insurance],
    ['Referring MD',patient.referring_physician],
  ];
  return <div className="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label,value])=><div key={label}><div className="field-label">{label}</div><div className="font-semibold">{value||'Not specified'}</div></div>)}</div>;
}
