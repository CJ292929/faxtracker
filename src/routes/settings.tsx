import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Workspace } from "@/components/workspace";
import { Heading, Empty } from "@/components/common";
import { useApp } from "@/lib/app-context";
import { supabase } from "@/integrations/supabase/client";
import { dateTimeOf } from "@/lib/fax";
import {
  createStaffOrAdminLogin,
  checkUsernameAvailable,
  listAccounts,
  type AccountListRow,
} from "@/lib/create-login.server";
import { changeStaffRole } from "@/lib/change-role.server";
import { USERNAME_RE } from "@/lib/username-login-core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings | NYC Home Rehab Fax Tracker" },
      { name: "description", content: "Staff access and audit activity for the fax tracker." },
      { property: "og:title", content: "Settings | NYC Home Rehab Fax Tracker" },
      { property: "og:description", content: "Staff settings and audit activity." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Settings,
});
type RoleRow = { id: string; user_id: string; role: string; username: string | undefined };
type AuditRow = {
  id: string;
  user_id: string | null;
  action: string;
  description: string | null;
  created_at: string;
};

function CreateLoginPanel({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accountRole, setAccountRole] = useState<"staff" | "admin">("staff");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [availability, setAvailability] = useState<"idle" | "checking" | "available" | "taken">(
    "idle",
  );

  useEffect(() => {
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      setAvailability("idle");
      return;
    }
    setAvailability("checking");
    const handle = setTimeout(() => {
      void checkUsernameAvailable({ data: { username: normalized } })
        .then((r) => setAvailability(r.available ? "available" : "taken"))
        .catch(() => setAvailability("idle"));
    }, 350);
    return () => clearTimeout(handle);
  }, [username]);

  function reset() {
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setAccountRole("staff");
    setShowPassword(false);
    setShowConfirm(false);
    setAvailability("idle");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMessage("");
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      setMessage("Username must be 3-32 characters: lowercase letters, numbers, . or _.");
      return;
    }
    if (password.length < 8) {
      setMessage("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await createStaffOrAdminLogin({
        data: { username: normalized, password, confirmPassword, role: accountRole },
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      toast.success(
        `${result.role === "admin" ? "Admin" : "Staff"} login "${result.username}" created.`,
      );
      reset();
      onCreated();
    } catch {
      setMessage("Unable to create this login. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border bg-card p-6">
      <h2 className="page-title mb-5 text-lg">Create Login</h2>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="field-label">Username</span>
          <input
            className="field"
            type="text"
            autoComplete="off"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {availability === "checking" && (
            <p className="mt-1 text-xs text-muted-foreground">Checking availability…</p>
          )}
          {availability === "taken" && (
            <p className="mt-1 text-xs text-destructive">Username is already taken.</p>
          )}
          {availability === "available" && (
            <p className="mt-1 text-xs text-primary">Username is available.</p>
          )}
        </label>
        <label className="block">
          <span className="field-label">Password</span>
          <div className="relative">
            <input
              className="field"
              style={{ paddingRight: "2.25rem" }}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="field-label">Confirm Password</span>
          <div className="relative">
            <input
              className="field"
              style={{ paddingRight: "2.25rem" }}
              type={showConfirm ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              aria-label={showConfirm ? "Hide password" : "Show password"}
              aria-pressed={showConfirm}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {showConfirm ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="field-label">Role</span>
          <select
            className="field"
            value={accountRole}
            onChange={(e) => setAccountRole(e.target.value as "staff" | "admin")}
          >
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {message && (
          <p role="status" className="text-xs text-destructive">
            {message}
          </p>
        )}
        <Button disabled={busy} className="w-full">
          {busy ? "Creating…" : "Create Login"}
        </Button>
      </form>
    </section>
  );
}

function AccountsPanel({ accounts }: { accounts: AccountListRow[] }) {
  return (
    <section className="rounded-md border bg-card p-6">
      <h2 className="page-title mb-5 text-lg">Accounts</h2>
      <div className="table-wrap">
        {accounts.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.username}>
                  <td>{a.username}</td>
                  <td className="capitalize">{a.role}</td>
                  <td>{dateTimeOf(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty text="No logins yet." />
        )}
      </div>
    </section>
  );
}

function Settings() {
  const { user, role, patients } = useApp();
  const [roles, setRoles] = useState<RoleRow[]>([]),
    [logs, setLogs] = useState<AuditRow[]>([]),
    [saving, setSaving] = useState("");
  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [pendingChange, setPendingChange] = useState<{
    target: RoleRow;
    next: "admin" | "staff";
  } | null>(null);
  const refreshAccounts = () => {
    void listAccounts()
      .then(setAccounts)
      .catch(() => {});
  };
  useEffect(() => {
    if (role === "admin") {
      void Promise.all([
        supabase.from("user_roles").select("*"),
        supabase.from("user_logins").select("user_id, username"),
      ]).then(([{ data: roleRows }, { data: loginRows }]) => {
        const usernameByUser = new Map(
          (loginRows ?? []).map((l) => [l.user_id as string, l.username as string]),
        );
        setRoles((roleRows ?? []).map((r) => ({ ...r, username: usernameByUser.get(r.user_id) })));
      });
      void supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data }) => setLogs(data ?? []));
      refreshAccounts();
    }
  }, [role]);
  async function confirmChangeRole() {
    if (!pendingChange) return;
    const { target, next } = pendingChange;
    setSaving(target.id);
    const result = await changeStaffRole({ data: { targetUserId: target.user_id, newRole: next } });
    setSaving("");
    setPendingChange(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setRoles(roles.map((r) => (r.id === target.id ? { ...r, role: result.newRole } : r)));
    void supabase
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => setLogs(data ?? []));
    toast.success("Staff role updated.");
  }
  return (
    <Workspace>
      <Heading title="Settings" subtitle="Staff access and record activity" />
      <div className="grid gap-8 xl:grid-cols-2">
        <section className="rounded-md border bg-card p-6">
          <h2 className="page-title mb-5 text-lg">Your Account</h2>
          <div className="space-y-4 text-sm">
            <div>
              <div className="field-label">Email</div>
              <strong>{user.email}</strong>
            </div>
            <div>
              <div className="field-label">Role</div>
              <strong className="capitalize">{role}</strong>
            </div>
            <div>
              <div className="field-label">Account ID</div>
              <span className="break-all text-xs text-muted-foreground">{user.id}</span>
            </div>
          </div>
          <p className="mt-7 border-t pt-5 text-xs leading-5 text-muted-foreground">
            New accounts require an administrator to assign a staff role before patient records
            become visible. An administrator must grant access to new accounts.
          </p>
        </section>
        <section className="rounded-md border bg-card p-6">
          <h2 className="page-title mb-5 text-lg">Staff Access</h2>
          {role === "admin" ? (
            <div className="space-y-2">
              {roles.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-3 text-xs"
                >
                  <div>
                    <div className="font-bold">
                      {r.user_id === user.id
                        ? "You"
                        : (r.username ?? `Unassigned login (${r.user_id.slice(0, 8)})`)}
                    </div>
                    <div className="mt-1 text-muted-foreground">{r.user_id}</div>
                  </div>
                  <select
                    aria-label="Staff role"
                    className="field w-auto"
                    value={r.role}
                    disabled={saving === r.id || r.user_id === user.id}
                    onChange={(e) =>
                      setPendingChange({ target: r, next: e.target.value as "admin" | "staff" })
                    }
                  >
                    <option value="admin">Admin</option>
                    <option value="staff">Staff</option>
                  </select>
                </div>
              ))}
              <p className="pt-4 text-xs leading-5 text-muted-foreground">
                Users must create their own account before an administrator can assign access.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only administrators can manage staff roles.
            </p>
          )}
        </section>
      </div>
      {role === "admin" && (
        <div className="mt-8 grid gap-8 xl:grid-cols-2">
          <CreateLoginPanel onCreated={refreshAccounts} />
          <AccountsPanel accounts={accounts} />
        </div>
      )}
      {role === "admin" && (
        <section className="mt-8">
          <h2 className="page-title mb-4 text-lg">Audit Activity</h2>
          <div className="table-wrap">
            {logs.length ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date & time</th>
                    <th>User ID</th>
                    <th>Action</th>
                    <th>Patient</th>
                    <th>Document</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td>{dateTimeOf(l.created_at)}</td>
                      <td>{l.user_id?.slice(0, 8) ?? "System"}</td>
                      <td className="capitalize">
                        {l.description ?? l.action.replaceAll("_", " ")}
                      </td>
                      <td>
                        {patients.find(
                          (p) => p.id === (l as AuditRow & { patient_id?: string }).patient_id,
                        )?.patient_id ?? "—"}
                      </td>
                      <td>
                        {(l as AuditRow & { document_id?: string }).document_id?.slice(0, 8) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty text="No audit activity yet." />
            )}
          </div>
        </section>
      )}
      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change staff role?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange && (
                <>
                  This changes{" "}
                  <strong>{pendingChange.target.username ?? pendingChange.target.user_id}</strong>{" "}
                  from <strong className="capitalize">{pendingChange.target.role}</strong> to{" "}
                  <strong className="capitalize">{pendingChange.next}</strong>.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingChange(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving !== ""}
              onClick={(e) => {
                e.preventDefault();
                void confirmChangeRole();
              }}
            >
              {saving !== "" ? "Saving…" : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Workspace>
  );
}
