import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Storage Health Panel (admin-only).
 *
 * Visar live var users + licenser sparas och varnar om persistent storage
 * inte är konfigurerad korrekt. Hjälper admin verifiera Render disk-mount
 * och env-vars utan att behöva curla från Render-konsol.
 */

interface StorageHealthData {
  ok: true;
  healthy: boolean;
  warnings: string[];
  users_file_exists: boolean;
  users_count: number;
  users_path: string;
  users_data_dir: string;
  users_dir_writable: boolean;
  users_dir_writable_reason?: string;
  using_persistent_users_dir: boolean;
  licenses_file_exists: boolean;
  license_count: number;
  licenses_path: string;
  licenses_data_dir: string;
  licenses_dir_writable: boolean;
  licenses_dir_writable_reason?: string;
  using_persistent_licenses_dir: boolean;
  zip_exists: boolean;
  download_path: string;
  download_dir_writable?: boolean;
  download_dir_writable_reason?: string;
  env: {
    NODE_ENV: string | null;
    RENDER: string | null;
    APP_USERS_DATA_DIR: string | null;
    AUTOCLICKER_DATA_DIR: string | null;
    AUTOCLICKER_DOWNLOAD_DIR: string | null;
  };
  process_cwd: string;
  expected_render_disk_path: string;
  render_disk_path_exists: boolean;
  expected_mount_path?: string;
  expected_mount_exists?: boolean;
  expected_mount_is_directory?: boolean;
  expected_mount_writable?: boolean;
  expected_mount_writable_reason?: string;
  paths_are_under_expected_mount?: boolean;
  persistent_disk_recommended: boolean;
  cache_dir?: string;
  cache_dir_env_set?: boolean;
  cache_dir_persistent?: boolean;
  cache_dir_writable?: boolean;
  cache_dir_writable_reason?: string;
  process_uptime_seconds?: number;
  process_started_at?: string;
  write_gate: "ok" | "blocked";
  write_gate_reason?: string;
  write_gate_missing_env?: string[];
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function StorageHealthPanel() {
  const [data, setData] = useState<StorageHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/storage/health", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setData(null);
        return;
      }
      const json = (await res.json()) as StorageHealthData;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
  }, [fetchHealth]);

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="p-5 text-xs text-muted-foreground">Laddar storage-status…</CardContent>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card>
        <CardContent className="p-5 text-xs text-red-500">Kunde inte ladda storage-status: {error}</CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const dotColor = data.healthy ? "text-emerald-500" : "text-amber-500";
  const StatusIcon = data.healthy ? CheckCircle2 : AlertTriangle;

  return (
    <Card>
      <CardContent className="space-y-3 p-5 text-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-semibold">Persistent storage</span>
            <StatusIcon className={`h-4 w-4 ${dotColor}`} aria-hidden />
            <Badge
              variant="outline"
              className={`text-[10px] ${
                data.healthy
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
            >
              {data.healthy ? "OK" : `${data.warnings.length} varning${data.warnings.length === 1 ? "" : "ar"}`}
            </Badge>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void fetchHealth()}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Warnings */}
        {data.warnings.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2">
            <div className="mb-1 font-medium text-amber-700 dark:text-amber-300">Varningar</div>
            <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
              {data.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Write gate */}
        {data.write_gate === "blocked" && (
          <div className="rounded-md border border-red-500/40 bg-red-500/[0.08] px-3 py-2">
            <div className="font-medium text-red-700 dark:text-red-300">⛔ Skrivlås aktivt</div>
            <div className="mt-1 text-[11px] text-red-600 dark:text-red-300">{data.write_gate_reason}</div>
            {data.write_gate_missing_env && data.write_gate_missing_env.length > 0 && (
              <div className="mt-1 text-[11px] text-red-600 dark:text-red-300">
                Saknade env vars: <code className="rounded bg-background/40 px-1">{data.write_gate_missing_env.join(", ")}</code>
              </div>
            )}
          </div>
        )}

        {/* Users */}
        <div className="space-y-1">
          <div className="font-medium text-foreground">Users</div>
          <div className="grid grid-cols-[140px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <span className="text-muted-foreground">Path</span>
            <code className="break-all">{data.users_path}</code>
            <span className="text-muted-foreground">Count</span>
            <span>{data.users_count}</span>
            <span className="text-muted-foreground">File exists</span>
            <span>{data.users_file_exists ? "✓" : "✗"}</span>
            <span className="text-muted-foreground">Dir writable</span>
            <span>{data.users_dir_writable ? "✓" : `✗ ${data.users_dir_writable_reason ?? ""}`}</span>
            <span className="text-muted-foreground">Persistent dir</span>
            <span>{data.using_persistent_users_dir ? "✓ via APP_USERS_DATA_DIR" : "✗ legacy fallback"}</span>
          </div>
        </div>

        {/* Licenses */}
        <div className="space-y-1">
          <div className="font-medium text-foreground">Autoclicker licenser</div>
          <div className="grid grid-cols-[140px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <span className="text-muted-foreground">Path</span>
            <code className="break-all">{data.licenses_path}</code>
            <span className="text-muted-foreground">Count</span>
            <span>{data.license_count}</span>
            <span className="text-muted-foreground">File exists</span>
            <span>{data.licenses_file_exists ? "✓" : "✗"}</span>
            <span className="text-muted-foreground">Dir writable</span>
            <span>{data.licenses_dir_writable ? "✓" : `✗ ${data.licenses_dir_writable_reason ?? ""}`}</span>
            <span className="text-muted-foreground">Persistent dir</span>
            <span>{data.using_persistent_licenses_dir ? "✓ via AUTOCLICKER_DATA_DIR" : "✗ legacy fallback"}</span>
            <span className="text-muted-foreground">Zip path</span>
            <code className="break-all">{data.download_path}</code>
            <span className="text-muted-foreground">Zip exists</span>
            <span>{data.zip_exists ? "✓" : "✗"}</span>
          </div>
        </div>

        {/* Env */}
        <div className="space-y-1">
          <div className="font-medium text-foreground">Env</div>
          <div className="grid grid-cols-[200px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <span className="text-muted-foreground">NODE_ENV</span>
            <code>{data.env.NODE_ENV ?? "(unset)"}</code>
            <span className="text-muted-foreground">RENDER</span>
            <code>{data.env.RENDER ?? "(unset)"}</code>
            <span className="text-muted-foreground">APP_USERS_DATA_DIR</span>
            <code className="break-all">{data.env.APP_USERS_DATA_DIR ?? "(unset)"}</code>
            <span className="text-muted-foreground">AUTOCLICKER_DATA_DIR</span>
            <code className="break-all">{data.env.AUTOCLICKER_DATA_DIR ?? "(unset)"}</code>
            <span className="text-muted-foreground">AUTOCLICKER_DOWNLOAD_DIR</span>
            <code className="break-all">{data.env.AUTOCLICKER_DOWNLOAD_DIR ?? "(unset)"}</code>
            <span className="text-muted-foreground">process.cwd()</span>
            <code className="break-all">{data.process_cwd}</code>
            <span className="text-muted-foreground">Render disk mount</span>
            <code className="break-all">
              {data.expected_mount_path ?? data.expected_render_disk_path}{" "}
              {(data.expected_mount_exists ?? data.render_disk_path_exists) ? "(✓ exists" : "(✗ missing"}
              {data.expected_mount_is_directory != null && (data.expected_mount_is_directory ? ", dir" : ", not dir")}
              {data.expected_mount_writable != null && (data.expected_mount_writable ? ", writable" : ", read-only")}
              {")"}
            </code>
            {data.paths_are_under_expected_mount != null && (
              <>
                <span className="text-muted-foreground">Paths under mount</span>
                <span>{data.paths_are_under_expected_mount ? "✓ alla 3 paths under mount" : "✗ någon path utanför mount"}</span>
              </>
            )}
            {data.download_dir_writable != null && (
              <>
                <span className="text-muted-foreground">Download dir writable</span>
                <span>{data.download_dir_writable ? "✓" : `✗ ${data.download_dir_writable_reason ?? ""}`}</span>
              </>
            )}
          </div>
        </div>

        {/* Prestanda & drift — varma cacher + uptime. Avslöjar om instansen
            somnar/recyclas (låg uptime) och om sidorna laddar kallt efter
            omstart (varm cache ej persistent). */}
        {(data.cache_dir != null || data.process_uptime_seconds != null) && (
          <div className="space-y-1">
            <div className="font-medium text-foreground">Prestanda &amp; drift</div>
            <div className="grid grid-cols-[200px_1fr] gap-x-2 gap-y-0.5 text-[11px]">
              {data.cache_dir != null && (
                <>
                  <span className="text-muted-foreground">Varm cache-mapp</span>
                  <code className="break-all">{data.cache_dir}</code>
                  <span className="text-muted-foreground">Varm cache persistent</span>
                  <span>
                    {data.cache_dir_persistent
                      ? data.cache_dir_env_set
                        ? "✓ via CACHE_DIR"
                        : "✓ ligger på monterad disk"
                      : "✗ EFEMÄR — sätt CACHE_DIR till persistent disk"}
                  </span>
                </>
              )}
              {data.process_uptime_seconds != null && (
                <>
                  <span className="text-muted-foreground">Process-uptime</span>
                  <span>
                    {formatUptime(data.process_uptime_seconds)}
                    {data.process_uptime_seconds < 1200 && (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        (nyligen omstartad)
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>
            {data.cache_dir_persistent === false && (
              <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                ⚠ Varma cacher (valuebets/bonus/optimizer) ligger i en efemär mapp och försvinner
                vid varje omstart/sömn → sidorna byggs om kallt och känns sega. Sätt env
                <code className="mx-1 rounded bg-background/40 px-1">CACHE_DIR</code>
                till en monterad persistent disk (t.ex. <code className="rounded bg-background/40 px-1">/var/data</code>).
              </div>
            )}
            {data.process_uptime_seconds != null && data.process_uptime_seconds < 1200 && (
              <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                ⚠ Instansen startade nyligen. Om uptime är lågt varje gång du kollar somnar/recyclas
                tjänsten när du är inaktiv — då stoppas spårning + warmers och sidorna laddar kallt.
                Säkerställ att tjänsten inte är på en plan som somnar och att keepalive pingar rätt URL.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
