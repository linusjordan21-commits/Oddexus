/**
 * TrackingAnalytics — aggregerade analysvyer (Fas 2) ovanpå den spårade datan.
 *
 * Inga outcomes krävs: detta svarar på "VAR / NÄR / HUR dyker value upp" —
 * per bok, per marknad, tid-till-avspark, tid på dygnet (svensk tid), och
 * EV-fördelning. Allt beräknas server-side (/api/tracking/analytics) över hela
 * datasetet, så vyn är lätt och täcker mer än den sidvisade listan.
 */
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Agg = { key: string; count: number; avgEv: number | null; maxEv: number | null; settled: number; avgClv: number | null; beatPct: number | null };
type Hist = { label: string; count: number };
type Clv = {
  settled: number;
  noClosing: number;
  pending: number;
  avgClvPct: number | null;
  beatPct: number | null;
  histogram: Hist[];
};
type Lifespan = { count: number; avgSec: number | null; medianSec: number | null; histogram: Hist[] };
type Analytics = {
  ok: boolean;
  windowHours: number;
  quality: string;
  total: number;
  totalAll: number;
  avgEv: number | null;
  medianEv: number | null;
  lifespan?: Lifespan;
  clv?: Clv;
  byBook: Agg[];
  byMarket: Agg[];
  byQuality: Agg[];
  byTimeToStart: Agg[];
  byHourSweden: { key: string; count: number }[];
  byWeekdaySweden: { key: string; count: number }[];
  evHistogram: Hist[];
};

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const QUALITY: [string, string][] = [["clean", "Endast ren"], ["all", "Allt"], ["uncertain", "Osäker"], ["issue", "Dålig kvalitet"]];
const dur = (s: number | null | undefined) => {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"];
const marketLabel = (m: string) => {
  switch (m) {
    case "moneyline": return "1X2 (ML)";
    case "1x2": return "1X2";
    case "total": return "Totalt";
    case "ah": return "AH";
    case "eh3": return "EH3";
    case "corner_total": return "Hörnor O/U";
    case "corner_ah": return "Hörnor AH";
    default: return m;
  }
};

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

const axis = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const tooltipStyle = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "hsl(var(--foreground))" },
};

export function TrackingAnalytics() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hours, setHours] = useState<24 | 72 | 168>(168);
  const [quality, setQuality] = useState("clean");
  const [exporting, setExporting] = useState(false);

  const exportPackage = useCallback(async () => {
    setExporting(true);
    try {
      const r = await fetch(`/api/tracking/export?days=30`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = `oddexus-analys-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(u);
    } catch {
      /* tyst — knappen återställs ändå */
    } finally {
      setExporting(false);
    }
  }, []);

  const load = useCallback(async (h: number, qual: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/tracking/analytics?hours=${h}&quality=${encodeURIComponent(qual)}`, { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Analytics);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(hours, quality);
  }, [load, hours, quality]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Analys</h2>
          <p className="text-xs text-muted-foreground">
            Var, när och hur value dyker upp — aggregerat över spårade signaler.
            {data ? ` ${data.total}${data.totalAll && data.totalAll !== data.total ? ` av ${data.totalAll}` : ""} signaler · snitt-EV ${pct(data.avgEv)} · median ${pct(data.medianEv)}.` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {([24, 72, 168] as const).map((h) => (
              <Button key={h} size="sm" variant={hours === h ? "default" : "outline"} className="h-8" onClick={() => setHours(h)}>
                {h === 168 ? "7d" : `${h}h`}
              </Button>
            ))}
          </div>
          <div className="flex gap-1">
            {QUALITY.map(([v, l]) => (
              <Button key={v} size="sm" variant={quality === v ? "default" : "outline"} className="h-8" onClick={() => setQuality(v)} title="Datakvalitets-filter">
                {l}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load(hours, quality)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" variant="default" className="h-8 gap-1.5" onClick={() => void exportPackage()} disabled={exporting} title="Ladda ner CSV + summary + färdig analys-prompt (30 dagar) att ge till Claude">
            <Download className={`h-4 w-4 ${exporting ? "animate-pulse" : ""}`} />
            {exporting ? "Exporterar…" : "Exportera analyspaket"}
          </Button>
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {data && data.total === 0 && !loading && (
        <p className="text-sm text-muted-foreground">Inga signaler i fönstret ännu — workern fyller på var ~5 min.</p>
      )}

      {/* CLV — slog vi closing-linjen? Gold standard, kräver inga matchresultat. */}
      {data && data.clv && (data.clv.settled > 0 || data.clv.pending > 0) && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">CLV — slog vi closing-linjen?</h3>
                <p className="text-[11px] text-muted-foreground">
                  Jämför våra entry-odds mot Pinnacles no-vig closing. Positiv CLV = äkta value (oberoende av resultat).
                </p>
              </div>
              <div className="flex flex-wrap gap-4 text-right">
                <div>
                  <div className="font-mono text-lg font-bold text-primary">
                    {data.clv.beatPct == null ? "—" : `${(data.clv.beatPct * 100).toFixed(0)}%`}
                  </div>
                  <div className="text-[10px] uppercase text-muted-foreground">slog linjen</div>
                </div>
                <div>
                  <div className={`font-mono text-lg font-bold ${(data.clv.avgClvPct ?? 0) >= 0 ? "text-primary" : "text-destructive"}`}>
                    {pct(data.clv.avgClvPct)}
                  </div>
                  <div className="text-[10px] uppercase text-muted-foreground">snitt-CLV</div>
                </div>
                <div>
                  <div className="font-mono text-lg font-bold">{data.clv.settled}</div>
                  <div className="text-[10px] uppercase text-muted-foreground">settlade</div>
                </div>
              </div>
            </div>
            {data.clv.settled > 0 ? (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.clv.histogram} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={axis} />
                    <YAxis tick={axis} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="count" name="Signaler" radius={[3, 3, 0, 0]}>
                      {data.clv.histogram.map((h, i) => (
                        <Cell key={i} fill={h.label.startsWith("0") || h.label.endsWith("+") || h.label === "5–10%" ? "hsl(var(--primary))" : "hsl(var(--destructive))"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {data.clv.pending} signaler väntar på closing-line (settlas nära avspark). Inga settlade ännu.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.total > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <ChartCard title="EV-fördelning" subtitle="Antal signaler per EV-spann (max-EV)">
            <BarChart data={data.evHistogram} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Tid till avspark" subtitle="När upptäcks value relativt avspark">
            <BarChart data={data.byTimeToStart} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="key" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Per bokmakare" subtitle="Antal value-signaler där boken var bäst · CLV i tooltip">
            <BarChart data={data.byBook.slice(0, 12)} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis type="number" tick={axis} allowDecimals={false} />
              <YAxis type="category" dataKey="key" tick={axis} width={70} />
              <Tooltip {...tooltipStyle} formatter={(v: number, _n, p) => {
                const a = p?.payload as Agg;
                const clv = a?.settled ? ` · CLV ${pct(a.avgClv)} (${a.settled})` : "";
                return [`${v} st · EV ${pct(a?.avgEv)}${clv}`, "Signaler"];
              }} />
              <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Per marknad" subtitle="Fördelning över marknadstyper · CLV i tooltip">
            <BarChart data={data.byMarket.map((m) => ({ ...m, label: marketLabel(m.key) }))} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} formatter={(v: number, _n, p) => {
                const a = p?.payload as Agg;
                const clv = a?.settled ? ` · CLV ${pct(a.avgClv)} (${a.settled})` : "";
                return [`${v} st · EV ${pct(a?.avgEv)}${clv}`, "Signaler"];
              }} />
              <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Tid på dygnet (svensk tid)" subtitle="Timme 0–23 då signaler först upptäcks">
            <BarChart data={data.byHourSweden} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="key" tick={axis} interval={1} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} labelFormatter={(l) => `kl ${l}:00`} />
              <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartCard>

          <ChartCard title="Veckodag (svensk tid)" subtitle="Mån–Sön då signaler först upptäcks">
            <BarChart data={data.byWeekdaySweden.map((d) => ({ ...d, label: WEEKDAYS[Number(d.key) - 1] ?? d.key }))} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="count" name="Signaler" radius={[2, 2, 0, 0]}>
                {data.byWeekdaySweden.map((d, i) => (
                  <Cell key={i} fill={Number(d.key) >= 6 ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))"} />
                ))}
              </Bar>
            </BarChart>
          </ChartCard>

          {/* Bet nu vs vänta: snitt-CLV per tid-till-avspark. Högre CLV i ett spann =
              det läget gav bäst pris mot closing. Kräver settlade signaler i spannet. */}
          <ChartCard title="Bet nu vs vänta" subtitle="Snitt-CLV per tid till avspark (positivt = slog closing)">
            <BarChart data={data.byTimeToStart.filter((t) => t.settled > 0)} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="key" tick={axis} />
              <YAxis tick={axis} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
              <Tooltip {...tooltipStyle} formatter={(v: number, _n, p) => [`${pct(v)} CLV · ${(p?.payload as Agg)?.settled} settlade`, "Snitt-CLV"]} />
              <Bar dataKey="avgClv" name="Snitt-CLV" radius={[3, 3, 0, 0]}>
                {data.byTimeToStart.filter((t) => t.settled > 0).map((t, i) => (
                  <Cell key={i} fill={(t.avgClv ?? 0) >= 0 ? "hsl(var(--primary))" : "hsl(var(--destructive))"} />
                ))}
              </Bar>
            </BarChart>
          </ChartCard>

          {/* Signal-livslängd: hur länge value består innan den försvinner/avspark. */}
          {data.lifespan && data.lifespan.count > 0 && (
            <ChartCard
              title="Signal-livslängd"
              subtitle={`Hur länge value består · median ${dur(data.lifespan.medianSec)} · snitt ${dur(data.lifespan.avgSec)}`}
            >
              <BarChart data={data.lifespan.histogram} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={axis} />
                <YAxis tick={axis} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="count" name="Signaler" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartCard>
          )}
        </div>
      )}
    </div>
  );
}
