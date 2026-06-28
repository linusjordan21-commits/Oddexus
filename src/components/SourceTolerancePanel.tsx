/**
 * B2 — Källornas inlärda polling-tolerans (admin).
 * Visar varje källas FINASTE hämttakt som höll sig frisk (= källans gräns/
 * tolerans), nuvarande intervall, antal backoffs och senaste backoff. Hämtas
 * från den committade tolerans-filen via /api/admin/source-tolerance.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Gauge } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Row = {
  currentIntervalSec: number;
  toleranceFloorSec: number;
  hardFloorSec: number;
  ceilingSec: number;
  backoffCount: number;
  lastBackoffAt: string | null;
  lastStatus: string | null;
};
type Data = { found: boolean; updatedAt?: string; sources?: Record<string, Row> };

const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

export function SourceTolerancePanel() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/source-tolerance", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.sources ? Object.entries(data.sources).sort((a, b) => a[0].localeCompare(b[0])) : [];

  return (
    <Card>
      <CardContent className="space-y-3 p-5 text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Källornas polling-tolerans</span>
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void load()}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Rampen trappar ned hämttakten tills en källa visar block-signal, backar då, och minns den finaste
          takt som höll sig frisk = källans <strong>tolerans</strong>. Den går aldrig under den igen.
        </p>

        {err && <p className="text-destructive">{err}</p>}
        {data && !data.found && (
          <p className="text-muted-foreground">
            Ingen tolerans-data ännu — fylls på när keepalive-rampen kört en stund (committas var ~10:e min).
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-[10px] text-muted-foreground">
                <tr className="border-b">
                  <th className="px-2 py-1.5 text-left">Källa</th>
                  <th className="px-2 py-1.5 text-right">Nuvarande takt</th>
                  <th className="px-2 py-1.5 text-right">Tolerans (gräns)</th>
                  <th className="px-2 py-1.5 text-right">Backoffs</th>
                  <th className="px-2 py-1.5 text-right">Senaste backoff</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([id, r]) => (
                  <tr key={id} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-medium">{id}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt(r.currentIntervalSec)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                      {fmt(r.toleranceFloorSec)}
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.backoffCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                      {r.backoffCount}
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">
                      {r.lastBackoffAt ? new Date(r.lastBackoffAt).toLocaleString("sv-SE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.updatedAt && (
          <p className="text-[10px] text-muted-foreground">Uppdaterad {new Date(data.updatedAt).toLocaleString("sv-SE")}.</p>
        )}
      </CardContent>
    </Card>
  );
}
