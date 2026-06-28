/**
 * TrackingDashboard — visar den ALWAYS-ON-spårade valuebet-datan (fas 1).
 *
 * Den gamla spårningen (request-driven, dubbelräknad per bok, disk-lagrad) är
 * raderad. Den här vyn LÄSER bara från Supabase via /api/tracking/*, som matas
 * av background-workern (persist-signals) var ~5 min — oberoende av om någon
 * besöker sidan. En signal = en opportunity (deduppad över böcker); alla
 * value-böcker finns i `books`-arrayen, headline = boken med högst EV.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import BookmakerName from "@/components/BookmakerName";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type SignalBook = { book?: string; odds?: number; ev?: number };
type Signal = {
  signal_id: string;
  market_key: string;
  sport: string | null;
  league: string | null;
  match: string | null;
  start_time: string | null;
  start_time_sweden: string | null;
  soft_bookmaker: string | null;
  market_type: string | null;
  selection: string | null;
  line: number | null;
  status: string;
  first_detected_at: string | null;
  first_detected_at_sweden: string | null;
  last_seen_at: string | null;
  max_ev: number | null;
  current_ev: number | null;
  ev_at_detection: number | null;
  market_mismatch_risk: string | null;
  data_quality_flag: string | null;
  clv_status: string | null;
  clv_pct: number | null;
  extra: {
    books?: SignalBook[];
    // Market Trust Layer (§9): persisterad trust-/likviditets-data.
    liquidity_grade?: string;
    liquidity_score?: number;
    pinnacle_limit?: number;
    betfair?: { liquidity_factor?: number; spread_pct?: number; matched_volume?: number; back?: number | null; lay?: number | null; mid?: number | null };
    sharp_prices?: { pinnacle?: number; sbobet?: number; betfair?: number };
    sharp_consensus?: { consensus_score?: number; sources_count?: number; price_spread_pct?: number; primary_source?: string };
    trust_flags?: string[];
    recommendation?: string;
    source_freshness?: { sbobet?: { age_sec: number | null; fresh: boolean }; betfair?: { age_sec: number | null; fresh: boolean } };
  } | null;
};

// Datakvalitets-badge (steg 6): null/clean → ingen badge (ren). Gul = osäker, röd = dålig.
const QUALITY_BADGE: Record<string, { label: string; variant: "secondary" | "destructive" | "outline" }> = {
  uncertain: { label: "osäker", variant: "outline" },
  suspicious_ev: { label: "suspekt EV", variant: "destructive" },
  mismatch: { label: "mismatch", variant: "destructive" },
};
type SeriesPoint = {
  taken_at: string;
  taken_at_sweden: string | null;
  ev: number | null;
  soft_odds: number | null;
  sharp_fair_odds: number | null;
};
type FreshSource = { source_id: string | null; updated_at: string | null; age_sec: number | null; status: string };

const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`);
const odds = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(2));
const fmtTime = (ts: string | null) => (ts ? new Date(ts).toLocaleString("sv-SE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtAge = (sec: number | null) => {
  if (sec == null) return "—";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
};
const marketLabel = (m: string | null) => {
  switch (m) {
    case "moneyline": return "1X2 (ML)";
    case "1x2": return "1X2";
    case "total": return "Totalt";
    case "ah": return "AH";
    case "eh3": return "EH3";
    case "corner_total": return "Hörnor O/U";
    case "corner_ah": return "Hörnor AH";
    default: return m ?? "—";
  }
};

// Market Trust Layer (§9): färg/etikett för grade + §7-rekommendation (PRIOR).
function gradeColor(g: string): string {
  switch (g) { case "A": return "hsl(142 72% 42%)"; case "B": return "hsl(90 55% 45%)"; case "C": return "hsl(40 90% 50%)"; case "D": return "hsl(0 75% 55%)"; default: return "hsl(var(--muted-foreground))"; }
}
function recColor(r: string): string {
  switch (r) { case "avoid": case "manual_review": return "hsl(0 75% 55%)"; case "stake_reduce": return "hsl(35 90% 50%)"; case "watch": return "hsl(210 80% 60%)"; default: return "hsl(142 72% 42%)"; }
}
function recLabel(r: string): string {
  switch (r) { case "avoid": return "Undvik"; case "manual_review": return "Granska"; case "stake_reduce": return "Sänk insats"; case "watch": return "Vänta"; default: return "Bet"; }
}

/** Liten inline-sparkline över EV-utvecklingen (look-ahead-säker tidsserie). */
function Sparkline({ points }: { points: SeriesPoint[] }) {
  const evs = points.map((p) => p.ev).filter((v): v is number => v != null && Number.isFinite(v));
  if (evs.length < 2) return <span className="text-[11px] text-muted-foreground">för få datapunkter</span>;
  const min = Math.min(...evs);
  const max = Math.max(...evs);
  const range = max - min || 1;
  const w = 220;
  const h = 36;
  const step = w / (evs.length - 1);
  const path = evs
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-primary" />
    </svg>
  );
}

export function TrackingDashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [sources, setSources] = useState<FreshSource[]>([]);
  const [inactiveCount, setInactiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [minEv, setMinEv] = useState(0.02);
  const [status, setStatus] = useState("active");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [series, setSeries] = useState<Record<string, SeriesPoint[]>>({});

  const load = useCallback(async (mev: number, st: string) => {
    setLoading(true);
    setErr(null);
    try {
      const [sigRes, freshRes] = await Promise.all([
        fetch(`/api/tracking/signals?status=${encodeURIComponent(st)}&min_ev=${mev}&limit=500`, { credentials: "include", cache: "no-store" }),
        fetch(`/api/tracking/freshness`, { credentials: "include", cache: "no-store" }),
      ]);
      if (!sigRes.ok) throw new Error(`signals HTTP ${sigRes.status}`);
      const sigJson = (await sigRes.json()) as { configured?: boolean; rows?: Signal[] };
      setConfigured(sigJson.configured !== false);
      setSignals(sigJson.rows ?? []);
      if (freshRes.ok) {
        const f = (await freshRes.json()) as { sources?: FreshSource[]; inactiveCount?: number };
        setSources(f.sources ?? []);
        setInactiveCount(f.inactiveCount ?? 0);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(minEv, status);
  }, [load, minEv, status]);

  const toggleExpand = useCallback(
    async (sig: Signal) => {
      if (expanded === sig.signal_id) {
        setExpanded(null);
        return;
      }
      setExpanded(sig.signal_id);
      if (!series[sig.signal_id]) {
        try {
          const r = await fetch(`/api/tracking/series?signal=${encodeURIComponent(sig.signal_id)}`, { credentials: "include", cache: "no-store" });
          if (r.ok) {
            const j = (await r.json()) as { rows?: SeriesPoint[] };
            setSeries((prev) => ({ ...prev, [sig.signal_id]: j.rows ?? [] }));
          }
        } catch {
          /* tyst — sparkline visar bara "för få datapunkter" */
        }
      }
    },
    [expanded, series],
  );

  const staleCount = useMemo(() => sources.filter((s) => s.status === "stale").length, [sources]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Spårning (always-on)
          </h2>
          <p className="text-xs text-muted-foreground">
            Bakgrunds-workern spårar varje opportunity var ~5 min — oberoende av om sidan är öppen. En rad = en
            opportunity (deduppad över böcker), headline = boken med högst EV.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-[170px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Aktiva (live/kommande)</SelectItem>
              <SelectItem value="closed_with_clv">Avgjorda (CLV)</SelectItem>
              <SelectItem value="closed_no_closing">Utan closing</SelectItem>
              <SelectItem value="expired">Utgångna</SelectItem>
              <SelectItem value="data_quality_issue">Datakvalitetsproblem</SelectItem>
              <SelectItem value="all">Alla</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            {([0.02, 0.05, 0.1] as const).map((m) => (
              <Button key={m} size="sm" variant={minEv === m ? "default" : "outline"} className="h-8" onClick={() => setMinEv(m)}>
                ≥{(m * 100).toFixed(0)}%
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load(minEv, status)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Källfärskhet — flaggar stale sharps (skydd mot fake valuebets) */}
      {sources.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-1.5 p-3">
            <span className="mr-1 text-[11px] font-semibold uppercase text-muted-foreground">Källor:</span>
            {staleCount > 0 && (
              <Badge variant="destructive" className="text-[10px]">{staleCount} stale</Badge>
            )}
            {sources.map((s) => (
              <Badge
                key={s.source_id ?? Math.random()}
                variant={s.status === "stale" ? "destructive" : "secondary"}
                className="text-[10px] font-mono"
                title={s.updated_at ?? ""}
              >
                {(s.source_id ?? "?").replace(/-rows$/, "")} {fmtAge(s.age_sec)}
              </Badge>
            ))}
            {inactiveCount > 0 && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground" title="Källor utan uppdatering >6h (retirerade/diagnostik) — döljs från färskheten">
                +{inactiveCount} inaktiva
              </Badge>
            )}
          </CardContent>
        </Card>
      )}

      {!configured && (
        <p className="text-sm text-muted-foreground">
          Supabase är inte konfigurerad på servern (SUPABASE_URL/SERVICE_KEY saknas) — spårningen är inaktiv.
        </p>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
      {configured && !err && signals.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">Inga aktiva signaler ännu — workern fyller på var ~5 min.</p>
      )}

      {signals.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left">Match</th>
                  <th className="px-2 py-2 text-left">Marknad</th>
                  <th className="px-2 py-2 text-left">Val</th>
                  <th className="px-2 py-2 text-left">Bästa bok</th>
                  <th className="px-2 py-2 text-right">EV (max)</th>
                  <th className="px-2 py-2 text-right">CLV</th>
                  <th className="px-2 py-2 text-left">Trust</th>
                  <th className="px-2 py-2 text-right">Böcker</th>
                  <th className="px-2 py-2 text-left">Först sedd</th>
                  <th className="px-2 py-2 text-left">Senast</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => {
                  const books = s.extra?.books ?? [];
                  const isOpen = expanded === s.signal_id;
                  return (
                    <Fragment key={s.signal_id}>
                      <tr
                        className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                        onClick={() => void toggleExpand(s)}
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{s.match ?? "—"}</span>
                            {s.data_quality_flag && QUALITY_BADGE[s.data_quality_flag] ? (
                              <Badge variant={QUALITY_BADGE[s.data_quality_flag].variant} className="text-[9px]">
                                {QUALITY_BADGE[s.data_quality_flag].label}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-muted-foreground">{s.league ?? s.sport ?? ""}</div>
                        </td>
                        <td className="px-2 py-2">
                          {marketLabel(s.market_type)}
                          {s.line != null ? <span className="text-muted-foreground"> {s.line}</span> : null}
                        </td>
                        <td className="px-2 py-2">{s.selection ?? "—"}</td>
                        <td className="px-2 py-2">
                          {s.soft_bookmaker ? <BookmakerName name={s.soft_bookmaker} className="w-24" /> : "—"}
                          {s.market_mismatch_risk ? (
                            <Badge variant="outline" className="ml-1 text-[9px]">granska</Badge>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-right font-mono font-semibold text-primary">{pct(s.max_ev)}</td>
                        <td className="px-2 py-2 text-right font-mono">
                          {s.clv_status === "settled" && s.clv_pct != null ? (
                            <span className={s.clv_pct >= 0 ? "text-primary" : "text-destructive"}>{pct(s.clv_pct)}</span>
                          ) : s.clv_status === "no_closing" ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className="text-muted-foreground/60" title="settlas nära avspark">·</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {s.extra?.liquidity_grade && s.extra.liquidity_grade !== "unknown" && (
                            <span className="font-mono font-bold" style={{ color: gradeColor(s.extra.liquidity_grade) }} title="Likviditets-grade (PRIOR)">{s.extra.liquidity_grade}</span>
                          )}
                          {s.extra?.recommendation && s.extra.recommendation !== "bet" && (
                            <span className="ml-1 text-[9px] font-semibold uppercase" style={{ color: recColor(s.extra.recommendation) }}>{recLabel(s.extra.recommendation)}</span>
                          )}
                          {(s.extra?.trust_flags?.length ?? 0) > 0 && (
                            <span className="ml-1 text-[9px] text-amber-600 dark:text-amber-400" title={s.extra!.trust_flags!.join(", ")}>⚠{s.extra!.trust_flags!.length}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {books.length > 1 ? (
                            <Badge variant="secondary" className="text-[10px]">{books.length}</Badge>
                          ) : (
                            <span className="text-muted-foreground">{books.length || 1}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{fmtTime(s.first_detected_at)}</td>
                        <td className="px-2 py-2 text-muted-foreground">{fmtTime(s.last_seen_at)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={10} className="px-3 py-3">
                            <div className="flex flex-wrap items-start gap-6">
                              <div>
                                <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">EV över tid</div>
                                <div className="text-primary">
                                  <Sparkline points={series[s.signal_id] ?? []} />
                                </div>
                                <div className="mt-1 text-[10px] text-muted-foreground">
                                  {(series[s.signal_id]?.length ?? 0)} snapshots · start {s.start_time_sweden ?? fmtTime(s.start_time)}
                                </div>
                              </div>
                              <div>
                                <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Alla value-böcker</div>
                                <div className="flex flex-wrap gap-1.5">
                                  {books.length === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
                                  {books
                                    .slice()
                                    .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0))
                                    .map((b, i) => (
                                      <Badge key={i} variant="outline" className="gap-1 text-[10px]">
                                        {b.book ? <BookmakerName name={b.book} className="w-16" /> : "?"}
                                        <span className="font-mono">{odds(b.odds)}</span>
                                        <span className="font-mono text-primary">{pct(b.ev)}</span>
                                      </Badge>
                                    ))}
                                </div>
                              </div>
                              {s.extra && (s.extra.sharp_prices || s.extra.liquidity_grade || (s.extra.trust_flags?.length ?? 0) > 0) && (
                                <div>
                                  <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Sharp-priser &amp; likviditet</div>
                                  <div className="space-y-0.5 text-[11px] font-mono">
                                    {s.extra.sharp_prices?.pinnacle != null && (
                                      <div>Pinnacle {odds(s.extra.sharp_prices.pinnacle)}{s.extra.pinnacle_limit != null ? <span className="text-muted-foreground"> · limit {s.extra.pinnacle_limit}</span> : null}</div>
                                    )}
                                    {s.extra.sharp_prices?.sbobet != null && <div>SBOBET {odds(s.extra.sharp_prices.sbobet)}</div>}
                                    {s.extra.sharp_prices?.betfair != null && (
                                      <div>Betfair {odds(s.extra.sharp_prices.betfair)}{s.extra.betfair?.matched_volume != null ? <span className="text-muted-foreground"> · vol {Math.round(s.extra.betfair.matched_volume).toLocaleString("sv-SE")}</span> : null}</div>
                                    )}
                                    {(s.extra.betfair?.back != null || s.extra.betfair?.lay != null) && (
                                      <div className="text-muted-foreground">börs back {s.extra.betfair?.back != null ? odds(s.extra.betfair.back) : "—"} / lay {s.extra.betfair?.lay != null ? odds(s.extra.betfair.lay) : "—"}</div>
                                    )}
                                    {s.extra.liquidity_grade && s.extra.liquidity_grade !== "unknown" && (
                                      <div>Grade <span className="font-bold" style={{ color: gradeColor(s.extra.liquidity_grade) }}>{s.extra.liquidity_grade}</span>
                                        {s.extra.sharp_consensus?.consensus_score != null ? <span className="text-muted-foreground"> · consensus {s.extra.sharp_consensus.consensus_score}</span> : null}
                                        {s.extra.sharp_consensus?.sources_count != null ? <span className="text-muted-foreground"> · {s.extra.sharp_consensus.sources_count} källor</span> : null}</div>
                                    )}
                                    {s.extra.recommendation && (
                                      <div>Rek: <span className="font-semibold uppercase" style={{ color: recColor(s.extra.recommendation) }}>{recLabel(s.extra.recommendation)}</span> <span className="text-[9px] text-muted-foreground">(PRIOR)</span></div>
                                    )}
                                    {(s.extra.trust_flags?.length ?? 0) > 0 && (
                                      <div className="text-amber-600 dark:text-amber-400">{s.extra.trust_flags!.join(", ")}</div>
                                    )}
                                    {s.extra.source_freshness && (s.extra.source_freshness.sbobet?.age_sec != null || s.extra.source_freshness.betfair?.age_sec != null) && (
                                      <div className="text-muted-foreground">
                                        färskhet:
                                        {s.extra.source_freshness.sbobet?.age_sec != null ? <span className={s.extra.source_freshness.sbobet.fresh ? "" : "text-destructive"}> SBOBET {fmtAge(s.extra.source_freshness.sbobet.age_sec)}{s.extra.source_freshness.sbobet.fresh ? "" : "⚠"}</span> : null}
                                        {s.extra.source_freshness.betfair?.age_sec != null ? <span className={s.extra.source_freshness.betfair.fresh ? "" : "text-destructive"}> Betfair {fmtAge(s.extra.source_freshness.betfair.age_sec)}{s.extra.source_freshness.betfair.fresh ? "" : "⚠"}</span> : null}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
