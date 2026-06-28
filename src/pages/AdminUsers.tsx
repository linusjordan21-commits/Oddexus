import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type LicenseSummary = {
  has_license: boolean;
  license_id: string | null;
  license_key: string | null;
  active: boolean;
  expires_at: string | null;
  device_id: string | null;
};

type PlanId = "free" | "basic" | "pro";

type SubscriptionSummary = {
  plan: PlanId;
  effective_plan: PlanId;
  status: string;
  active: boolean;
  current_period_end: string | null;
  auto_renew: boolean;
  via_mollie: boolean;
};

type AppUserRow = {
  id: string;
  username: string;
  active: boolean;
  valuebets: boolean;
  bonusFinder: boolean;
  bonusOptimizer: boolean;
  athena: boolean;
  created_at: string;
  updated_at: string;
  license: LicenseSummary;
  subscription?: SubscriptionSummary;
};

const PLAN_LABELS: Record<PlanId, string> = {
  free: "Free",
  basic: "Basic (Ithaca)",
  pro: "Pro (Ithaca + Argos)",
};

export default function AdminUsers() {
  const [users, setUsers] = useState<AppUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordEdits, setPasswordEdits] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ total: number; active: number; expiringSoon: number } | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 403) {
        setError("Kräver admin-inloggning");
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { users?: AppUserRow[] };
      setUsers(json.users ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users/subscription-stats", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        stats?: { total: number; active: number; expiringSoon: number };
      };
      if (json.stats) setStats(json.stats);
    } catch {
      /* icke-kritiskt */
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
    void fetchStats();
  }, [fetchUsers, fetchStats]);

  const setPlan = async (
    user: AppUserRow,
    body: { action?: "set" | "extend" | "cancel"; plan?: PlanId; days?: number },
  ) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/subscription`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`Prenumeration uppdaterad för ${user.username}.`);
      await fetchUsers();
      await fetchStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    if (!newUsername.trim() || !newPassword) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, active: true }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setMessage(`Användare ${newUsername.trim()} skapad`);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const patchUser = async (
    id: string,
    patch: { active?: boolean; password?: string; valuebets?: boolean; bonusFinder?: boolean; bonusOptimizer?: boolean; athena?: boolean },
  ) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      if (patch.password) {
        setPasswordEdits((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async (user: AppUserRow) => {
    if (!confirm(`Radera användaren "${user.username}" permanent? Detta går inte att ångra.`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; deleted?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`Användaren "${json.deleted}" raderad.`);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const create30DayLicense = async (user: AppUserRow) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/autoclicker-license`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; license?: { license_key?: string } };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`Licens skapad för ${user.username}: ${json.license?.license_key ?? ""}`);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const revokeLicense = async (user: AppUserRow) => {
    if (!confirm(`Återkalla licensen för "${user.username}"? Personen har då ingen licensnyckel längre.`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/autoclicker-license`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`Licens återkallad för ${user.username}.`);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const resetLicenseDevice = async (user: AppUserRow) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/reset-license-device`, {
        method: "POST",
        credentials: "same-origin",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setMessage(`device_id nollställd för ${user.username}`);
      await fetchUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10 px-4 py-10">
      <div className="mx-auto max-w-6xl">
        <Link
          to="/admin"
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Admin
        </Link>
        <BrandHeader size="md" className="mb-4" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Användare</h1>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" asChild>
              <Link to="/admin/autoclicker-licenses">Autoclicker-licenser</Link>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void fetchUsers()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        {message && <p className="mt-2 text-sm text-green-700 dark:text-green-400">{message}</p>}

        {stats && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Prenumerationer totalt</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Aktiva nu</p>
                <p className="text-2xl font-bold text-green-700 dark:text-green-400">{stats.active}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Går ut inom 7 dagar</p>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.expiringSoon}</p>
              </CardContent>
            </Card>
          </div>
        )}

        <Card className="mt-6">
          <CardContent className="space-y-4 p-6">
            <h2 className="font-semibold">Skapa ny kund</h2>
            <p className="text-sm text-muted-foreground">
              1. Skapa användare → 2. Skapa 30-dagars licens → 3. Kunden loggar in → 4. /autoclicker
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="newUser">username</Label>
                <Input
                  id="newUser"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="kundnamn"
                  autoComplete="off"
                />
              </div>
              <div>
                <Label htmlFor="newPw">lösenord (min 10 tecken, siffra + bokstav)</Label>
                <Input
                  id="newPw"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <Button type="button" onClick={() => void createUser()} disabled={saving || !newUsername.trim() || !newPassword}>
              Skapa användare
            </Button>
          </CardContent>
        </Card>

        <Card className="mt-6 overflow-x-auto">
          <CardContent className="p-0">
            {loading ? (
              <p className="p-6 text-sm text-muted-foreground">Laddar…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Användare</TableHead>
                    <TableHead className="min-w-[260px]">Prenumeration</TableHead>
                    <TableHead>Aktiv</TableHead>
                    <TableHead className="min-w-[200px]">Behörigheter</TableHead>
                    <TableHead>Autoclicker</TableHead>
                    <TableHead>Giltig till</TableHead>
                    <TableHead>Licensnyckel</TableHead>
                    <TableHead className="min-w-[280px]">Åtgärder</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-muted-foreground">
                        Inga kundanvändare ännu.
                      </TableCell>
                    </TableRow>
                  ) : (
                    users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.username}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex items-center gap-2">
                              <select
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                value={u.subscription?.plan ?? "free"}
                                disabled={saving}
                                onChange={(e) =>
                                  void setPlan(u, { action: "set", plan: e.target.value as PlanId })
                                }
                              >
                                {(["free", "basic", "pro"] as PlanId[]).map((p) => (
                                  <option key={p} value={p}>
                                    {PLAN_LABELS[p]}
                                  </option>
                                ))}
                              </select>
                              {u.subscription?.active ? (
                                <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                                  aktiv
                                </span>
                              ) : (
                                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {u.subscription?.status ?? "none"}
                                </span>
                              )}
                              {u.subscription?.via_mollie && (
                                <span className="text-[10px] text-muted-foreground">Mollie</span>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {u.subscription?.current_period_end
                                ? `t.o.m. ${u.subscription.current_period_end.slice(0, 10)}`
                                : "ingen aktiv period"}
                            </div>
                            <div className="flex gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                disabled={saving}
                                onClick={() => void setPlan(u, { action: "extend", days: 30 })}
                              >
                                +30 dgr
                              </Button>
                              {u.subscription?.active && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-destructive/50 px-2 text-[11px] text-destructive hover:bg-destructive/10"
                                  disabled={saving}
                                  onClick={() => void setPlan(u, { action: "cancel" })}
                                >
                                  Avsluta
                                </Button>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={u.active}
                            disabled={saving}
                            onCheckedChange={(checked) => void patchUser(u.id, { active: checked })}
                          />
                        </TableCell>
                        <TableCell>
                          {/* Per-användare-behörigheter: varje funktion gateas på
                              sidan + API. Av = kunden ser "Kommer snart". */}
                          <div className="flex flex-col gap-1.5">
                            <PermToggle label="Valuebets" checked={u.valuebets} disabled={saving} onChange={(c) => void patchUser(u.id, { valuebets: c })} />
                            <PermToggle label="Bonus Finder" checked={u.bonusFinder} disabled={saving} onChange={(c) => void patchUser(u.id, { bonusFinder: c })} />
                            <PermToggle label="Bonus Optimizer" checked={u.bonusOptimizer} disabled={saving} onChange={(c) => void patchUser(u.id, { bonusOptimizer: c })} />
                            <PermToggle label="Athena" checked={u.athena} disabled={saving} onChange={(c) => void patchUser(u.id, { athena: c })} />
                          </div>
                        </TableCell>
                        <TableCell>
                          {u.license.has_license ? (
                            u.license.active ? (
                              <span className="text-green-700 dark:text-green-400">aktiv</span>
                            ) : (
                              "inaktiv"
                            )
                          ) : (
                            <span className="text-muted-foreground">saknas</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {u.license.expires_at ? u.license.expires_at.slice(0, 10) : "—"}
                        </TableCell>
                        <TableCell>
                          {u.license.license_key ? (
                            <code className="text-xs">{u.license.license_key}</code>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={saving}
                              onClick={() => void create30DayLicense(u)}
                            >
                              Skapa 30-dagars autoclicker-licens
                            </Button>
                            {u.license.has_license && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={saving}
                                onClick={() => void resetLicenseDevice(u)}
                              >
                                Nollställ device_id
                              </Button>
                            )}
                            {u.license.has_license && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={saving}
                                className="border-destructive/50 text-destructive hover:bg-destructive/10"
                                onClick={() => void revokeLicense(u)}
                              >
                                Återkalla licens
                              </Button>
                            )}
                            <div className="flex gap-2">
                              <Input
                                type="password"
                                placeholder="Nytt lösenord"
                                className="h-8 text-xs"
                                value={passwordEdits[u.id] ?? ""}
                                onChange={(e) =>
                                  setPasswordEdits((prev) => ({ ...prev, [u.id]: e.target.value }))
                                }
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={saving || !(passwordEdits[u.id] ?? "").length}
                                onClick={() =>
                                  void patchUser(u.id, { password: passwordEdits[u.id] })
                                }
                              >
                                Spara
                              </Button>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={saving}
                              className="border-destructive/50 text-destructive hover:bg-destructive/10"
                              onClick={() => void deleteUser(u)}
                            >
                              Radera användare
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PermToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className={checked ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} className="scale-90" />
    </label>
  );
}
