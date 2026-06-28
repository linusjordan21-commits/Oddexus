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

type BotLicense = {
  id: string;
  license_key: string;
  username: string | null;
  customer_email: string | null;
  active: boolean;
  expires_at: string;
  device_id: string | null;
  max_devices: number;
  notes: string | null;
};

type StorageStatus = {
  license_file_path: string;
  license_file_exists: boolean;
  license_count: number;
  active_license_count: number;
  zip_file_path: string;
  zip_exists: boolean;
  zip_file_size_bytes: number | null;
  data_dir: string;
  download_dir: string;
  persistent_disk_recommended: boolean;
};

export default function AdminAutoclickerLicenses() {
  const [licenses, setLicenses] = useState<BotLicense[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [newKey, setNewKey] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newExpires, setNewExpires] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [newNotes, setNewNotes] = useState("");


  const fetchLicenses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/autoclicker-licenses", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { licenses?: BotLicense[]; storage?: StorageStatus };
      setLicenses(json.licenses ?? []);
      setStorage(json.storage ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLicenses();
  }, [fetchLicenses]);

  const createLicense = async () => {
    if (!newKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/autoclicker-licenses", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_key: newKey.trim(),
          username: newUsername.trim() || null,
          customer_email: newEmail.trim() || null,
          expires_at: new Date(newExpires + "T23:59:59.999Z").toISOString(),
          active: true,
          max_devices: 1,
          notes: newNotes.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewKey("");
      await fetchLicenses();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const patchLicense = async (id: string, patch: Partial<BotLicense>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/autoclicker-licenses/${id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      await fetchLicenses();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const resetDevice = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/autoclicker-licenses/${id}/reset-device`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      await fetchLicenses();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteLicense = async (lic: { id: string; license_key: string }) => {
    if (!confirm(`Radera licensen ${lic.license_key} permanent? Kunden kan då inte längre använda boten.`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/autoclicker-licenses/${lic.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      await fetchLicenses();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10 px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/admin"
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Admin
        </Link>
        <BrandHeader size="md" className="mb-4" />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">Autoclicker-licenser</h1>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" asChild>
              <Link to="/admin/users">Users</Link>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void fetchLicenses()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <Card className="mt-6">
          <CardContent className="space-y-2 p-6 text-sm">
            <h2 className="font-semibold">Production-status</h2>
            {storage ? (
              <>
                <p>
                  Licenser: <strong>{storage.license_count}</strong> totalt,{" "}
                  <strong>{storage.active_license_count}</strong> aktiva
                </p>
                <p>
                  Licensfil:{" "}
                  <code className="text-xs">{storage.license_file_exists ? "finns" : "saknas"}</code> —{" "}
                  <span className="text-xs text-muted-foreground break-all">{storage.license_file_path}</span>
                </p>
                <p>
                  Zip (fallback, används ej):{" "}
                  <code className="text-xs">{storage.zip_exists ? "finns" : "saknas"}</code>{" "}
                  <span className="text-xs text-muted-foreground">— nedladdning byggs från koden</span>
                </p>
                {storage.persistent_disk_recommended && (
                  <p className="rounded-md border border-amber-400/40 bg-amber-50/40 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    Render: sätt APP_USERS_DATA_DIR, AUTOCLICKER_DATA_DIR och AUTOCLICKER_DOWNLOAD_DIR
                    på persistent disk — annars försvinner users, licenser och zip vid redeploy.
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">Laddar lagringsstatus…</p>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardContent className="space-y-3 p-6 text-sm">
            <h2 className="font-semibold">Autoclicker-nedladdning</h2>
            <div className="rounded-lg border border-emerald-600/30 bg-emerald-500/5 p-3">
              <p className="mb-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">✓ Helt automatisk</p>
              <p className="text-xs text-muted-foreground">
                Kunderna laddar alltid ner den <strong>senaste</strong> boten — den byggs och serveras direkt från
                koden vid varje nedladdning. Du behöver aldrig bygga, skicka eller ladda upp någon zip. Varje gång
                boten uppdateras (deploy) får alla kunder automatiskt den nya versionen.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              En ev. <code>autoclicker-share.zip</code> på disken används <strong>inte</strong> längre för
              nedladdning — den ligger bara kvar som nödfallback om koden mot förmodan inte kan läsas.
            </p>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardContent className="space-y-4 p-6">
            <h2 className="font-semibold">Skapa ny licens</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="newKey">license_key</Label>
                <Input id="newKey" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="TEST-OK-123" />
              </div>
              <div>
                <Label htmlFor="newUser">username (inloggning på sajten)</Label>
                <Input id="newUser" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="newEmail">customer_email</Label>
                <Input id="newEmail" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="newExp">expires_at</Label>
                <Input id="newExp" type="date" value={newExpires} onChange={(e) => setNewExpires(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="newNotes">notes</Label>
                <Input id="newNotes" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="Valfritt" />
              </div>
            </div>
            <Button type="button" onClick={() => void createLicense()} disabled={saving || !newKey.trim()}>
              Skapa licens
            </Button>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardContent className="p-6 text-sm">
            <h2 className="font-semibold">Så används licensen</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Skapa licens för kund</li>
              <li>Sätt active=true och expires_at</li>
              <li>Kunden laddar ner botten från /autoclicker</li>
              <li>Botten låser licensen till första device_id</li>
              <li>Reset device_id om kunden byter dator</li>
            </ol>
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
                    <TableHead>Nyckel</TableHead>
                    <TableHead>Användare</TableHead>
                    <TableHead>Aktiv</TableHead>
                    <TableHead>Utgår</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Enhet</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {licenses.map((lic) => (
                    <TableRow key={lic.id}>
                      <TableCell className="font-mono text-xs">{lic.license_key}</TableCell>
                      <TableCell className="text-xs">{lic.username ?? "—"}</TableCell>
                      <TableCell>
                        <Switch
                          checked={lic.active}
                          onCheckedChange={(active) => void patchLicense(lic.id, { active })}
                          disabled={saving}
                        />
                      </TableCell>
                      <TableCell className="text-xs">{lic.expires_at.slice(0, 10)}</TableCell>
                      <TableCell className="max-w-[100px] truncate text-xs" title={lic.notes ?? ""}>
                        {lic.notes ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-xs" title={lic.device_id ?? ""}>
                        {lic.device_id ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="text-xs"
                            disabled={saving}
                            onClick={() => void resetDevice(lic.id)}
                          >
                            Nollställ enhet
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-destructive/50 text-xs text-destructive hover:bg-destructive/10"
                            disabled={saving}
                            onClick={() => void deleteLicense(lic)}
                          >
                            Radera
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <p className="mt-4 text-xs text-muted-foreground">
          Botten anropar POST /api/bot-license. Koppla licens till samma username som kunden loggar in med för
          nedladdning på /autoclicker.
        </p>
      </div>
    </div>
  );
}
