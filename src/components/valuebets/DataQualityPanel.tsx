/**
 * #12 — Data quality warnings. Läser /api/valuebets-diagnostiken (som redan
 * beräknas) och flaggar dålig data så analysen inte förgiftas: stale Pinnacle,
 * saknad likviditet, extrema outliers, samt hur många par som avvisades pga
 * lag-/tid-/liga-mismatch (= potentiella felmatchningar).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Vb = { needsReview?: boolean; pinnacle?: { limit?: number | null } };
type Resp = {
  matchesScanned?: number;
  pinnacleStatus?: string;
  pinnacleAgeSeconds?: number | null;
  isPinnacleFresh?: boolean;
  valueBets?: Vb[];
  diagnostics?: {
    pairsConsidered?: number;
    pairsRejectedTeams?: number;
    pairsRejectedTime?: number;
    pairsRejectedLeague?: number;
    pairsRejectedSides?: number;
    evRejectedExtreme?: number;
  };
};

type Check = { label: string; value: string; bad: boolean; hint?: string };

export function DataQualityPanel() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/valuebets?hours=24", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Resp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) return <div className="p-6 text-sm text-muted-foreground">Laddar…</div>;
  if (err && !data) return <div className="p-6 text-sm text-destructive">Kunde inte ladda: {err}</div>;
  if (!data) return null;

  const vbs = data.valueBets ?? [];
  const d = data.diagnostics ?? {};
  const missingLiq = vbs.filter((v) => v.pinnacle?.limit == null).length;
  const needsReview = vbs.filter((v) => v.needsReview).length;
  const ageMin = data.pinnacleAgeSeconds != null ? Math.round(data.pinnacleAgeSeconds / 60) : null;

  const checks: Check[] = [
    {
      label: "Pinnacle-färskhet",
      value: data.isPinnacleFresh ? `färsk (${ageMin ?? "?"} min)` : `STALE (${ageMin ?? "?"} min)`,
      bad: data.isPinnacleFresh === false,
      hint: "Stale referens → value bets döljs (säkerhetsgaten).",
    },
    {
      label: "Saknad likviditet",
      value: `${missingLiq} av ${vbs.length}`,
      bad: vbs.length > 0 && missingLiq / vbs.length > 0.5,
      hint: "Value bets utan Pinnacle-likviditet — edgen svänger mer, lita mindre.",
    },
    {
      label: "Extrema outliers (review)",
      value: String(needsReview),
      bad: needsReview > 0,
      hint: "EV över review-tröskeln — trolig stale odds / felmatchad marknad. Dubbelkolla.",
    },
    {
      label: "Avvisade: lag-mismatch",
      value: String(d.pairsRejectedTeams ?? 0),
      bad: false,
      hint: "Par där lagnamn inte matchade — korrekt bortfiltrerade (skydd mot felmatchning).",
    },
    {
      label: "Avvisade: tid-mismatch",
      value: String(d.pairsRejectedTime ?? 0),
      bad: false,
      hint: "Olika avsparkstid (>5 min) → fel match, korrekt avvisade.",
    },
    {
      label: "Avvisade: liga-mismatch",
      value: String(d.pairsRejectedLeague ?? 0),
      bad: false,
    },
    {
      label: "Avvisade: extrem EV",
      value: String(d.evRejectedExtreme ?? 0),
      bad: false,
      hint: "EV > 25% eller favorit-flip → nästan alltid datafel, korrekt avvisade.",
    },
  ];

  const anyBad = checks.some((c) => c.bad);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {anyBad ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            Datakvalitet
          </h2>
          <p className="text-xs text-muted-foreground">
            Skannade {data.matchesScanned ?? 0} matcher · {vbs.length} value bets (24h). Skydd mot dålig data.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <Card>
        <CardContent className="divide-y p-0">
          {checks.map((c) => (
            <div key={c.label} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{c.label}</div>
                {c.hint && <div className="text-[11px] text-muted-foreground">{c.hint}</div>}
              </div>
              <span
                className={`shrink-0 rounded px-2 py-0.5 text-xs font-semibold tabular-nums ${
                  c.bad
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-muted text-foreground"
                }`}
              >
                {c.value}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
