/**
 * StrategyLab — interaktiv backtester (Fas 4) ovanpå den spårade datan.
 *
 * Filtrera signalerna (bok, marknad, EV-spann, tid-till-avspark, timme, veckodag)
 * och se hur EV + CLV faller ut för just den strategin. CLV är target — vi
 * backtestar utan matchresultat (slog vi closing-linjen?). Två strategier kan
 * jämföras sida vid sida.
 */
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FlaskConical, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Result = {
  count: number;
  avgEv: number | null;
  medianEv: number | null;
  clvSettled: number;
  avgClv: number | null;
  medianClv: number | null;
  beatPct: number | null;
  clvHistogram: { label: string; count: number }[];
};
type Filters = {
  book: string;
  market: string;
  minEv: string;
  tts: string;
  hourMin: string;
  hourMax: string;
  quality: string;
  // Market Trust Layer (§8): liquidity/consensus-filter.
  liqGrade: string;
  minLiq: string;
  minPinLimit: string;
  minSharps: string;
  excludeUnknown: string;
};

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const ANY = "__any__";
const MARKETS = [
  ["moneyline", "1X2 (ML)"], ["1x2", "1X2"], ["total", "Totalt"], ["ah", "AH"],
  ["eh3", "EH3"], ["corner_total", "Hörnor O/U"], ["corner_ah", "Hörnor AH"],
] as const;
const TTS = ["<15m", "15-60m", "1-3h", "3-6h", "6-12h", "12-24h", "24h+"];
const EV_MINS = [["0.02", "≥2%"], ["0.05", "≥5%"], ["0.1", "≥10%"], ["0.15", "≥15%"]] as const;
// Datakvalitets-filter (steg 6). Default 'clean' → backtest exkluderar suspekt/osäker data.
const QUALITY = [["clean", "Endast ren"], ["all", "Allt"], ["uncertain", "Osäker"], ["issue", "Dålig kvalitet"]] as const;
// Market Trust Layer (§8) — liquidity/consensus-filter (PRIOR-grade, ej kalibrerad än).
const LIQ_GRADES = [["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"]] as const;
const LIQ_MINS = [["0.55", "≥0.55"], ["0.7", "≥0.70"], ["0.85", "≥0.85"]] as const;
const PIN_LIMITS = [["500", "≥500"], ["1000", "≥1000"], ["2500", "≥2500"]] as const;
const SHARP_MINS = [["2", "≥2 källor"], ["3", "≥3 källor"]] as const;
const EXCLUDE_UNKNOWN = [["1", "Dölj okänd"]] as const;
const axis = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
const tooltipStyle = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "hsl(var(--foreground))" },
};

const EMPTY: Filters = { book: ANY, market: ANY, minEv: "0.02", tts: ANY, hourMin: ANY, hourMax: ANY, quality: "clean", liqGrade: ANY, minLiq: ANY, minPinLimit: ANY, minSharps: ANY, excludeUnknown: ANY };

function buildQs(f: Filters): string {
  const p = new URLSearchParams({ days: "60" });
  if (f.book !== ANY) p.set("book", f.book);
  if (f.market !== ANY) p.set("market", f.market);
  if (f.minEv) p.set("min_ev", f.minEv);
  if (f.tts !== ANY) p.set("tts", f.tts);
  if (f.hourMin !== ANY) p.set("hour_min", f.hourMin);
  if (f.hourMax !== ANY) p.set("hour_max", f.hourMax);
  if (f.quality) p.set("quality", f.quality);
  if (f.liqGrade !== ANY) p.set("liquidity_grade", f.liqGrade);
  if (f.minLiq !== ANY) p.set("min_liquidity_score", f.minLiq);
  if (f.minPinLimit !== ANY) p.set("min_pinnacle_limit", f.minPinLimit);
  if (f.minSharps !== ANY) p.set("min_sharp_sources", f.minSharps);
  if (f.excludeUnknown === "1") p.set("exclude_unknown_liquidity", "1");
  return p.toString();
}

function StatBlock({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "muted" }) {
  const color = tone === "good" ? "text-primary" : tone === "bad" ? "text-destructive" : "text-foreground";
  return (
    <div>
      <div className={`font-mono text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

function StrategyPanel({ title, books }: { title: string; books: string[] }) {
  const [f, setF] = useState<Filters>(EMPTY);
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (filters: Filters) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/tracking/strategy?${buildQs(filters)}`, { credentials: "include", cache: "no-store" });
      if (r.ok) setRes((await r.json()) as Result);
    } catch {
      /* tyst */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run(EMPTY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof Filters, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const sel = (k: keyof Filters, placeholder: string, opts: [string, string][], withAny = true) => (
    <Select value={f[k]} onValueChange={(v) => set(k, v)}>
      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {withAny && <SelectItem value={ANY}>Alla</SelectItem>}
        {opts.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Button size="sm" variant="outline" className="h-7" onClick={() => void run(f)} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Bok</Label>
            {sel("book", "Alla böcker", books.map((b) => [b, b]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Marknad</Label>
            {sel("market", "Alla", MARKETS.map((m) => [m[0], m[1]]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Min-EV</Label>
            {sel("minEv", "≥2%", EV_MINS.map((e) => [e[0], e[1]]), false)}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Tid till avspark</Label>
            {sel("tts", "Alla", TTS.map((t) => [t, t]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Timme från</Label>
            {sel("hourMin", "Alla", Array.from({ length: 24 }, (_, h) => [String(h), `${h}:00`]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Timme till</Label>
            {sel("hourMax", "Alla", Array.from({ length: 24 }, (_, h) => [String(h), `${h}:00`]))}
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Datakvalitet</Label>
            {sel("quality", "Endast ren", QUALITY.map((q) => [q[0], q[1]]), false)}
          </div>

          {/* Market Trust Layer (§8): liquidity/consensus-filter */}
          <div className="col-span-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Likviditet &amp; sharp-consensus
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Likviditets-grade</Label>
            {sel("liqGrade", "Alla", LIQ_GRADES.map((g) => [g[0], g[1]]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Min liquidity-score</Label>
            {sel("minLiq", "Alla", LIQ_MINS.map((m) => [m[0], m[1]]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Min Pinnacle-limit</Label>
            {sel("minPinLimit", "Alla", PIN_LIMITS.map((m) => [m[0], m[1]]))}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Min sharp-källor</Label>
            {sel("minSharps", "Alla", SHARP_MINS.map((m) => [m[0], m[1]]))}
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Okänd likviditet</Label>
            {sel("excludeUnknown", "Alla", EXCLUDE_UNKNOWN.map((m) => [m[0], m[1]]))}
          </div>
        </div>

        <div className="flex gap-2">
          <Button size="sm" className="h-8 flex-1" onClick={() => void run(f)} disabled={loading}>Kör backtest</Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => { setF(EMPTY); void run(EMPTY); }}>Rensa</Button>
        </div>

        {res && (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              <StatBlock label="signaler" value={String(res.count)} />
              <StatBlock label="snitt-EV" value={pct(res.avgEv)} tone="good" />
              <StatBlock label="slog linjen" value={res.beatPct == null ? "—" : `${(res.beatPct * 100).toFixed(0)}%`} tone={res.beatPct != null && res.beatPct >= 0.5 ? "good" : "muted"} />
              <StatBlock label={`snitt-CLV (${res.clvSettled})`} value={pct(res.avgClv)} tone={(res.avgClv ?? 0) >= 0 ? "good" : "bad"} />
            </div>
            {res.clvSettled > 0 ? (
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={res.clvHistogram} margin={{ top: 4, right: 8, bottom: 4, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={axis} />
                    <YAxis tick={axis} allowDecimals={false} />
                    <Tooltip {...tooltipStyle} />
                    <Bar dataKey="count" name="Signaler" radius={[3, 3, 0, 0]}>
                      {res.clvHistogram.map((h, i) => (
                        <Cell key={i} fill={h.label.startsWith("0") || h.label.endsWith("+") || h.label === "5–10%" ? "hsl(var(--primary))" : "hsl(var(--destructive))"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{res.count} signaler matchar, men inga har settlad CLV ännu (settlas nära avspark).</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StrategyLab() {
  const [books, setBooks] = useState<string[]>([]);

  useEffect(() => {
    // Hämta bok-listan från analytics (per-bok-aggregatet) för dropdownen.
    void (async () => {
      try {
        const r = await fetch(`/api/tracking/analytics?hours=720`, { credentials: "include", cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { byBook?: { key: string }[] };
          setBooks((j.byBook ?? []).map((b) => b.key).filter(Boolean));
        }
      } catch {
        /* tyst */
      }
    })();
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <FlaskConical className="h-4 w-4" /> Strategy Lab
        </h2>
        <p className="text-xs text-muted-foreground">
          Filtrera de spårade signalerna och se utfallet. CLV (slog vi closing-linjen) är måttet — backtest utan
          matchresultat. Jämför två strategier sida vid sida. Fönster: 60 dagar.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StrategyPanel title="Strategi A" books={books} />
        <StrategyPanel title="Strategi B" books={books} />
      </div>
    </div>
  );
}
