import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
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
import { resetStaffPassword } from "@/lib/reset-password.server";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
type AuditRow = {
  id: string;
  user_id: string | null;
  action: string;
  description: string | null;
  created_at: string;
};

function RoleBadge({ role }: { role: "admin" | "staff" }) {
  const tone = role === "admin" ? "bg-gold/15 text-gold" : "bg-info/10 text-info";
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-1 text-[11px] font-bold uppercase ${tone}`}
    >
      {role}
    </span>
  );
}

function CreateLoginPanel({
  onCreated,
}: {
  onCreated: (username: string, password: string) => void;
}) {
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
      onCreated(result.username, password);
      reset();
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

function ResetPasswordDialog({
  target,
  onClose,
  onReset,
}: {
  target: AccountListRow | null;
  onClose: () => void;
  onReset: (username: string, password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirm(false);
    setMessage("");
    setBusy(false);
  }, [target]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !target) return;
    setMessage("");
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
      const result = await resetStaffPassword({
        data: { targetUserId: target.user_id, password, confirmPassword },
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      toast.success(`Password reset for "${result.username}".`);
      onReset(result.username, password);
    } catch {
      setMessage("Unable to reset this password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set new password{target ? ` for ${target.username}` : ""}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="field-label">New Password</span>
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
          {message && (
            <p role="status" className="text-xs text-destructive">
              {message}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CopyPasswordButton({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      toast.success("Password copied.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Unable to copy password.");
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy password"
      className="text-muted-foreground hover:text-foreground"
    >
      {copied ? (
        <Check className="size-4" aria-hidden="true" />
      ) : (
        <Copy className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

function StaffAccessTable({
  accounts,
  currentUserId,
  sessionPasswords,
  revealed,
  onToggleReveal,
  saving,
  onRequestRoleChange,
  onRequestPasswordReset,
}: {
  accounts: AccountListRow[];
  currentUserId: string;
  sessionPasswords: Record<string, string>;
  revealed: Record<string, boolean>;
  onToggleReveal: (username: string) => void;
  saving: string;
  onRequestRoleChange: (target: AccountListRow, next: "admin" | "staff") => void;
  onRequestPasswordReset: (target: AccountListRow) => void;
}) {
  if (!accounts.length) return <Empty text="No logins yet." />;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Password</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => {
            const isSelf = a.user_id === currentUserId;
            const knownPassword = sessionPasswords[a.username];
            const isRevealed = revealed[a.username] === true;
            return (
              <tr key={a.user_id}>
                <td>
                  <span className="font-semibold">{a.username}</span>
                  {isSelf && (
                    <span className="ml-2 text-[10px] font-bold text-muted-foreground">(YOU)</span>
                  )}
                </td>
                <td>
                  <RoleBadge role={a.role} />
                </td>
                <td>
                  {knownPassword != null ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-xs">
                        {isRevealed ? knownPassword : "••••••••"}
                      </span>
                      <button
                        type="button"
                        onClick={() => onToggleReveal(a.username)}
                        aria-label={isRevealed ? "Hide password" : "Show password"}
                        aria-pressed={isRevealed}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {isRevealed ? (
                          <EyeOff className="size-4" aria-hidden="true" />
                        ) : (
                          <Eye className="size-4" aria-hidden="true" />
                        )}
                      </button>
                      <CopyPasswordButton password={knownPassword} />
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRequestPasswordReset(a)}
                    >
                      Set New Password
                    </Button>
                  )}
                </td>
                <td>
                  {isSelf ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <select
                      aria-label={`Change role for ${a.username}`}
                      className="field w-auto"
                      value={a.role}
                      disabled={saving === a.user_id}
                      onChange={(e) => onRequestRoleChange(a, e.target.value as "admin" | "staff")}
                    >
                      <option value="admin">Admin</option>
                      <option value="staff">Staff</option>
                    </select>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Settings() {
  const { user, role, patients } = useApp();
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [saving, setSaving] = useState("");
  const [accounts, setAccounts] = useState<AccountListRow[]>([]);
  const [sessionPasswords, setSessionPasswords] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [pendingChange, setPendingChange] = useState<{
    target: AccountListRow;
    next: "admin" | "staff";
  } | null>(null);
  const [resetTarget, setResetTarget] = useState<AccountListRow | null>(null);
  const refreshAccounts = () => {
    void listAccounts()
      .then(setAccounts)
      .catch(() => {});
  };
  useEffect(() => {
    if (role === "admin") {
      refreshAccounts();
      void supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100)
        .then(({ data }) => setLogs(data ?? []));
    }
    // Session-only passwords never leave this component: they reset on
    // navigation away from Settings, sign-out (which unmounts this tree),
    // and page refresh, since nothing here persists to storage.
    return () => {
      setSessionPasswords({});
      setRevealed({});
    };
  }, [role]);
  function handleCreated(username: string, password: string) {
    setSessionPasswords((m) => ({ ...m, [username]: password }));
    refreshAccounts();
  }
  function handlePasswordReset(username: string, password: string) {
    setSessionPasswords((m) => ({ ...m, [username]: password }));
    setRevealed((m) => ({ ...m, [username]: false }));
    setResetTarget(null);
  }
  function toggleReveal(username: string) {
    setRevealed((m) => ({ ...m, [username]: !m[username] }));
  }
  async function confirmChangeRole() {
    if (!pendingChange) return;
    const { target, next } = pendingChange;
    setSaving(target.user_id);
    const result = await changeStaffRole({ data: { targetUserId: target.user_id, newRole: next } });
    setSaving("");
    setPendingChange(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setAccounts(
      accounts.map((a) => (a.user_id === target.user_id ? { ...a, role: result.newRole } : a)),
    );
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
        {role === "admin" && <CreateLoginPanel onCreated={handleCreated} />}
      </div>
      {role === "admin" ? (
        <section className="mt-8 rounded-md border bg-card p-6">
          <h2 className="page-title mb-5 text-lg">Staff Access</h2>
          <StaffAccessTable
            accounts={accounts}
            currentUserId={user.id}
            sessionPasswords={sessionPasswords}
            revealed={revealed}
            onToggleReveal={toggleReveal}
            saving={saving}
            onRequestRoleChange={(target, next) => setPendingChange({ target, next })}
            onRequestPasswordReset={(target) => setResetTarget(target)}
          />
          <p className="pt-4 text-xs leading-5 text-muted-foreground">
            Users must create their own account before an administrator can assign access. Passwords
            are shown only for logins created or reset in this browser session and are cleared on
            sign-out or refresh.
          </p>
        </section>
      ) : (
        <section className="mt-8 rounded-md border bg-card p-6">
          <h2 className="page-title mb-5 text-lg">Staff Access</h2>
          <p className="text-sm text-muted-foreground">
            Only administrators can manage staff roles.
          </p>
        </section>
      )}
      {role === "admin" && (
        <section className="mt-8">
          <h2 className="page-title mb-4 text-lg">Audit Activity</h2>
          <div
            className="table-wrap max-h-[360px] overflow-y-auto"
            tabIndex={logs.length ? 0 : undefined}
            role={logs.length ? "region" : undefined}
            aria-label={logs.length ? "Audit activity log" : undefined}
          >
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
                  This changes <strong>{pendingChange.target.username}</strong> from{" "}
                  <strong className="capitalize">{pendingChange.target.role}</strong> to{" "}
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
      <ResetPasswordDialog
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        onReset={handlePasswordReset}
      />
    </Workspace>
  );
}
