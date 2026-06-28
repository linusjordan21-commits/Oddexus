/**
 * #9 — Pinnacle sharp lines (AH + totals), read-only referens.
 * Visar Pinnacles no-vig fair odds för huvud-handicap (AH) och huvud-total
 * (Över/Under) per kommande match. Vi auto-genererar ALDRIG valuebets på dessa
 * (reglemente kan skilja mellan böcker) — det här är en referens att jämföra
 * manuellt mot valfri softbook tills softbook-AH/totals-hämtning byggts.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Spread = {
  line?: number;
  homeLabel?: string;
  awayLabel?: string;
  homeFairOdds: number | null;
  awayFairOdds: number | null;
  vigPct: number | null;
};
type Total = {
  line?: number;
  overFairOdds: number | null;
  underFairOdds: number | null;
  vigPct: number | null;
};
type Match = {
  match: string;
  sport?: string;
  league?: string;
  startTs: string | null;
  spread: Spread | null;
  total: Total | null;
};

const odds = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2));
const fmtStart = (ts: string | null) =>
  ts ? new Date(ts).toLocaleString("sv-SE", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export function SharpLinesTable() {
  const [hours, setHours] = useState<24 | 48 | 72>(72);
  const [matches, setMatches] = useState<Match[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (h: number) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/valuebets/sharp-lines?hours=${h}`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { matches?: Match[]; updatedAt?: string | null };
      setMatches(j.matches ?? []);
      setUpdatedAt(j.updatedAt ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(hours);
  }, [load, hours]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Pinnacle sharp lines — AH &amp; totals</h2>
          <p className="text-xs text-muted-foreground">
            No-vig fair odds för huvud-handicap och huvud-total. Referens att jämföra manuellt — inga auto-valuebets.
            {updatedAt ? ` Uppdaterad ${new Date(updatedAt).toLocaleTimeString("sv-SE")}.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {([24, 48, 72] as const).map((h) => (
              <Button key={h} size="sm" variant={hours === h ? "default" : "outline"} className="h-8" onClick={() => setHours(h)}>
                {h}h
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load(hours)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="text-[11px] text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left">Match</th>
                <th className="px-2 py-2 text-left">Start</th>
                <th className="px-2 py-2 text-center">AH-linje</th>
                <th className="px-2 py-2 text-right">Hemma fair</th>
                <th className="px-2 py-2 text-right">Borta fair</th>
                <th className="px-2 py-2 text-center">Total</th>
                <th className="px-2 py-2 text-right">Över fair</th>
                <th className="px-2 py-2 text-right">Under fair</th>
              </tr>
            </thead>
            <tbody>
              {matches.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-muted-foreground">
                    Inga linjer i fönstret ännu.
                  </td>
                </tr>
              ) : (
                matches.map((m, i) => (
                  <tr key={`${m.match}-${i}`} className="border-b last:border-0">
                    <td className="max-w-[240px] truncate px-3 py-1.5" title={m.match}>
                      <span className="font-medium">{m.match}</span>
                      {m.league && <span className="ml-1.5 text-[10px] text-muted-foreground">{m.league}</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{fmtStart(m.startTs)}</td>
                    <td className="px-2 py-1.5 text-center font-mono tabular-nums">
                      {m.spread?.line != null ? m.spread.line : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{odds(m.spread?.homeFairOdds)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{odds(m.spread?.awayFairOdds)}</td>
                    <td className="px-2 py-1.5 text-center font-mono tabular-nums">
                      {m.total?.line != null ? m.total.line : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{odds(m.total?.overFairOdds)}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{odds(m.total?.underFairOdds)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
