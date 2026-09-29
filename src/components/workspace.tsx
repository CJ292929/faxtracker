import { AppShell } from './app-shell';
import { useApp } from '@/lib/app-context';
export function Workspace({children}:{children:React.ReactNode}){const {user,search,setSearch,loading}=useApp();return <AppShell email={user.email??'Staff'} search={search} onSearch={setSearch}>{loading?<div className="p-10 text-center text-muted-foreground">Loading records…</div>:children}</AppShell>}
