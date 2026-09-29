import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { loginWithUsername } from "./username-login.server";
import type { Patient, Document, Attempt, FileRecord } from "./fax";
type AppContext = {
  user: User;
  role: string;
  patients: Patient[];
  documents: Document[];
  attempts: Attempt[];
  files: FileRecord[];
  loading: boolean;
  refresh: () => Promise<void>;
  search: string;
  setSearch: (s: string) => void;
};
const Context = createContext<AppContext | null>(null);
export const useApp = () => {
  const c = useContext(Context);
  if (!c) throw new Error("App context unavailable");
  return c;
};
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [role, setRole] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setChecking(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setChecking(false);
    });
    return () => subscription.unsubscribe();
  }, []);
  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [p, d, a, f, r] = await Promise.all([
      supabase.from("patients").select("*").order("last_name"),
      supabase.from("documents").select("*").order("created_at", { ascending: false }),
      supabase.from("fax_attempts").select("*").order("attempted_at", { ascending: false }),
      supabase.from("document_files").select("*").order("uploaded_at", { ascending: false }),
      supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
    ]);
    setPatients(p.data ?? []);
    setDocuments(d.data ?? []);
    setAttempts(a.data ?? []);
    setFiles(f.data ?? []);
    setRole(r.data?.role ?? "");
    setLoading(false);
  }, [user]);
  useEffect(() => {
    if (user) void refresh();
    else {
      setPatients([]);
      setDocuments([]);
      setAttempts([]);
      setFiles([]);
      setRole("");
    }
  }, [user, refresh]);
  if (checking)
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading workspace…
      </div>
    );
  if (!user) return <AuthScreen />;
  if (!loading && !role)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="page-title text-2xl">Access pending</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your account needs a staff role before you can view patient records. Give this account ID
          to an administrator.
        </p>
        <code className="break-all rounded bg-muted px-3 py-2 text-xs">{user.id}</code>
        <Button variant="outline" onClick={() => void refresh()}>
          Check access
        </Button>
        <Button variant="link" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </div>
    );
  return (
    <Context.Provider
      value={{
        user,
        role,
        patients,
        documents,
        attempts,
        files,
        loading,
        refresh,
        search,
        setSearch,
      }}
    >
      {children}
    </Context.Provider>
  );
}
const GENERIC_LOGIN_ERROR = "Invalid username or password for this login type.";

function AuthScreen() {
  const [portal, setPortal] = useState<"admin" | "staff" | null>(null);

  if (!portal) return <PortalPicker onPick={setPortal} />;
  return <LoginForm portal={portal} onBack={() => setPortal(null)} />;
}

function PortalPicker({ onPick }: { onPick: (p: "admin" | "staff") => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm rounded-md border bg-card p-8 shadow-sm">
        <div className="mb-8 flex items-center gap-3">
          <img
            src="/logo.png"
            alt="NYC Home Rehab"
            className="size-10 shrink-0 rounded object-contain"
          />
          <div className="font-display text-sm font-extrabold leading-5 text-primary">
            NYC HOME REHAB
            <br />
            <span className="font-medium text-muted-foreground">FAX TRACKER</span>
          </div>
        </div>
        <h1 className="page-title text-2xl">Welcome back</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Choose how you sign in to continue.
        </p>
        <div className="space-y-3">
          <Button className="w-full" onClick={() => onPick("staff")}>
            Staff Login
          </Button>
          <Button variant="outline" className="w-full" onClick={() => onPick("admin")}>
            Admin Login
          </Button>
        </div>
        <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
          For authorized staff only. Accounts are provisioned by an administrator; there is no
          public sign-up. Do not enter real patient data until your organization has completed its
          security and HIPAA review.
        </p>
      </div>
    </div>
  );
}

function LoginForm({ portal, onBack }: { portal: "admin" | "staff"; onBack: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await loginWithUsername({ data: { username, password, portal } });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      const { error } = await supabase.auth.setSession({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      });
      if (error) setMessage(GENERIC_LOGIN_ERROR);
    } catch {
      setMessage(GENERIC_LOGIN_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const label = portal === "admin" ? "Admin Login" : "Staff Login";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-sm rounded-md border bg-card p-8 shadow-sm">
        <div className="mb-8 flex items-center gap-3">
          <img
            src="/logo.png"
            alt="NYC Home Rehab"
            className="size-10 shrink-0 rounded object-contain"
          />
          <div className="font-display text-sm font-extrabold leading-5 text-primary">
            NYC HOME REHAB
            <br />
            <span className="font-medium text-muted-foreground">FAX TRACKER</span>
          </div>
        </div>
        <h1 className="page-title text-2xl">{label}</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Secure {portal} access to patient fax records.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="field-label">Username</span>
            <input
              className="field"
              type="text"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="field-label">Password</span>
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {message && (
            <p role="status" className="text-xs text-primary">
              {message}
            </p>
          )}
          <Button disabled={busy} className="w-full">
            {busy ? "Please wait…" : label}
          </Button>
        </form>
        <Button variant="link" onClick={onBack} disabled={busy} className="mt-1 w-full">
          Back
        </Button>
        <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
          For authorized staff only. Accounts are provisioned by an administrator; there is no
          public sign-up.
        </p>
      </div>
    </div>
  );
}
