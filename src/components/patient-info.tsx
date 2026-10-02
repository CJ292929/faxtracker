import { dateOf, nameOf, type Patient } from '@/lib/fax';
// Single shared rendering of the required patient identity fields plus
// Referring MD contact details, used on both the patient detail page and the
// document detail page's Patient Information card, so the two views can
// never drift out of sync with each other. Unlike other field grids in this
// app (which fall back to "—"), these labels stay visible and show "Not
// specified" when empty per spec. "Patient Phone" is deliberately labeled to
// avoid confusion with the Referring MD Office Number, which is a separate
// phone number for a different party.
export function PatientInfoCard({patient}:{patient:Patient|null|undefined}){
  if(!patient)return <p className="text-sm text-muted-foreground">Patient information unavailable.</p>;
  const fields:[string,string|null|undefined,('tel'|undefined)?][]=[
    ['Name',nameOf(patient)],
    ['Member ID',patient.insurance_member_id],
    ['DOB',patient.date_of_birth?dateOf(patient.date_of_birth):null],
    ['Patient Phone',patient.phone,'tel'],
    ['Insurance',patient.insurance],
    ['Referring MD',patient.referring_physician],
    ['Referring MD NPI',patient.referring_physician_npi],
    ['Referring MD Office Number',patient.referring_physician_office_phone,'tel'],
    ['Referring MD Fax Number',patient.referring_physician_fax],
  ];
  return <div className="grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label,value,kind])=><div key={label}><div className="field-label">{label}</div><div className="font-semibold">{value?kind==='tel'?<a href={`tel:${value.replace(/[^\d+]/g,'')}`} className="hover:underline">{value}</a>:value:'Not specified'}</div></div>)}</div>;
}
