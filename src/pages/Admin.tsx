import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BrandHeader } from "@/components/BrandHeader";
import { StorageHealthPanel } from "@/components/StorageHealthPanel";
import { SourceTolerancePanel } from "@/components/SourceTolerancePanel";
import { SourcesStatus } from "@/components/SourcesStatus";
import { useUserSettings } from "@/hooks/useUserSettings";
import { useAuth } from "@/contexts/AuthContext";

interface AuthSettings {
  username: string;
  authSource: "file" | "env";
  sessionVersion: number;
  updatedAt: string | null;
  persistentDiskWarning?: string;
}

interface StorageHealth {
  ok: boolean;
  users_file_exists: boolean;
  users_count: number;
  licenses_file_exists: boolean;
  license_count: number;
  zip_exists: boolean;
  users_path: string;
  licenses_path: string;
  download_path: string;
  persistent_disk_recommended: boolean;
}

export default function Admin() {
  const { t } = useUserSettings();
  const { user, refresh } = useAuth();
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  // Change password state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null);

  // Logout-all state
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const [logoutAllMsg, setLogoutAllMsg] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auth-settings", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as AuthSettings;
      setSettings(json);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fetchStorageHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/storage/health", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setStorageError(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as StorageHealth;
      setStorageHealth(json);
      setStorageError(null);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
    void fetchStorageHealth();
  }, [fetchSettings, fetchStorageHealth]);

  const handleChangePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (changing) return;
    setChangeError(null);
    setChangeSuccess(null);
    if (newPw !== confirmPw) {
      setChangeError(t("admin.passwordMismatch"));
      return;
    }
    setChanging(true);
    try {
      const res = await fetch("/api/admin/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) {
        setChangeSuccess(t("admin.passwordChanged"));
        setCurrentPw("");
        setNewPw("");
        setConfirmPw("");
        // Refresh metadata + auth-context (cookie kan ha re-issued)
        await fetchSettings();
        await refresh();
      } else {
        setChangeError(json.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setChangeError(e instanceof Error ? e.message : String(e));
    } finally {
      setChanging(false);
    }
  };

  const handleLogoutAll = async () => {
    if (loggingOutAll) return;
    if (!window.confirm(t("admin.logoutAllConfirm"))) return;
    setLogoutAllMsg(null);
    setLoggingOutAll(true);
    try {
      const res = await fetch("/api/admin/logout-all", {
        method: "POST",
        credentials: "same-origin",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok) {
        setLogoutAllMsg(t("admin.logoutAllDone"));
        await fetchSettings();
      } else {
        setLogoutAllMsg(json.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setLogoutAllMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoggingOutAll(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10">
        <div className="mb-6">
          <BrandHeader size="md" className="mb-4" />
          <h1 className="text-2xl font-bold tracking-tight">{t("admin.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.subtitle")}</p>
        </div>

        {/* Current settings */}
        <Card className="mb-4">
          <CardContent className="space-y-3 p-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("admin.currentUserLabel")}</span>
              <span className="font-medium">{user?.username ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("admin.authSourceLabel")}</span>
              {settings ? (
                <Badge variant={settings.authSource === "file" ? "default" : "secondary"} className="text-[10px]">
                  {settings.authSource}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">…</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("admin.passwordUpdatedAtLabel")}</span>
              <span className="font-mono text-xs">
                {settings?.updatedAt ? new Date(settings.updatedAt).toLocaleString() : "—"}
              </span>
            </div>
            {loadError && <div className="text-xs text-red-500">{loadError}</div>}
            {settings?.persistentDiskWarning && (
              <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-50/40 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-950/30">
                <div className="font-medium">{t("admin.diskWarningHeader")}</div>
                <div className="mt-0.5">{settings.persistentDiskWarning}</div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Persistent storage health */}
        <div className="mb-4">
          <StorageHealthPanel />
        </div>

        {/* Alla källor & bookmakers — grupperade per plattform (samma färg = samma odds). */}
        <div className="mb-4">
          <SourcesStatus />
        </div>

        {/* Källornas inlärda polling-tolerans (B2) */}
        <div className="mb-4">
          <SourceTolerancePanel />
        </div>

        {/* Change password */}
        <Card className="mb-4">
          <CardContent className="p-5">
            <h2 className="text-base font-semibold">{t("admin.changePasswordHeader")}</h2>
            <form onSubmit={handleChangePassword} className="mt-4 space-y-3" autoComplete="off">
              <div className="space-y-1.5">
                <Label htmlFor="currentPw">{t("admin.currentPasswordLabel")}</Label>
                <Input
                  id="currentPw"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  disabled={changing}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="newPw">{t("admin.newPasswordLabel")}</Label>
                <Input
                  id="newPw"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  disabled={changing}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirmPw">{t("admin.confirmPasswordLabel")}</Label>
                <Input
                  id="confirmPw"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  disabled={changing}
                />
              </div>
              {changeError && (
                <div className="rounded-md border border-red-300/40 bg-red-50/40 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30">
                  {changeError}
                </div>
              )}
              {changeSuccess && (
                <div className="rounded-md border border-emerald-300/40 bg-emerald-50/40 px-3 py-2 text-xs text-emerald-600 dark:bg-emerald-950/30">
                  {changeSuccess}
                </div>
              )}
              <Button type="submit" disabled={changing || !currentPw || !newPw || !confirmPw}>
                {changing ? t("admin.changingPassword") : t("admin.changePasswordButton")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardContent className="p-5">
            <h2 className="text-base font-semibold">Persistent lagring</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Users och autoclicker-licenser ska ligga på Render Persistent Disk.
            </p>
            {storageError && <p className="mt-2 text-sm text-destructive">{storageError}</p>}
            {storageHealth ? (
              <StorageHealthDetails health={storageHealth} />
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">Laddar lagringsstatus…</p>
            )}
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardContent className="p-5">
            <h2 className="text-base font-semibold">Admin-navigation</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" asChild>
                <Link to="/admin/users">Users</Link>
              </Button>
              <Button type="button" variant="outline" size="sm" asChild>
                <Link to="/admin/autoclicker-licenses">Autoclicker licenses</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Logout all */}
        <Card>
          <CardContent className="p-5">
            <h2 className="text-base font-semibold">{t("admin.logoutAllHeader")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("admin.logoutAllConfirm")}
            </p>
            <Button
              type="button"
              variant="destructive"
              className="mt-3"
              onClick={handleLogoutAll}
              disabled={loggingOutAll}
            >
              {t("admin.logoutAllButton")}
            </Button>
            {logoutAllMsg && (
              <div className="mt-3 rounded-md border border-emerald-300/40 bg-emerald-50/40 px-3 py-2 text-xs text-emerald-600 dark:bg-emerald-950/30">
                {logoutAllMsg}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StorageHealthDetails({ health }: { health: StorageHealth }) {
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p>
        Users: <strong>{health.users_count}</strong> — fil{" "}
        <code>{health.users_file_exists ? "finns" : "saknas"}</code>
      </p>
      <p className="break-all text-muted-foreground">{health.users_path}</p>
      <p>
        Licenser: <strong>{health.license_count}</strong> — fil{" "}
        <code>{health.licenses_file_exists ? "finns" : "saknas"}</code>
      </p>
      <p className="break-all text-muted-foreground">{health.licenses_path}</p>
      <p>
        Zip: <code>{health.zip_exists ? "finns" : "saknas"}</code>
      </p>
      <p className="break-all text-muted-foreground">{health.download_path}</p>
      {health.persistent_disk_recommended && (
        <p className="rounded-md border border-amber-400/40 bg-amber-50/40 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          Render: sätt APP_USERS_DATA_DIR, AUTOCLICKER_DATA_DIR och AUTOCLICKER_DOWNLOAD_DIR på
          persistent disk — annars försvinner users och licenser vid redeploy.
        </p>
      )}
    </div>
  );
}
