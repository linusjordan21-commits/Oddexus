import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BrandHeader } from "@/components/BrandHeader";
import { apiUrl } from "@/lib/apiUrl";
import { computeLayMatch, roundLayStake } from "@/lib/layMatching";

type OutTriple = { "1"?: number | null; X?: number | null; "2"?: number | null };
interface ExtractionMatch {
  title: string;
  startTs?: string;
  league?: string;
  books: Record<string, OutTriple>;
  smarketsBack: OutTriple;
  smarketsLay: OutTriple;
}
interface ExtractionResponse {
  ok: boolean;
  commission: number;
  smarketsUpdatedAt: string | null;
  matchCount: number;
  matches: ExtractionMatch[];
}

interface Account {
  id: string;
  bookmakerId: string;
  balance: number;
  wageringRemaining: number;
  minOdds: number;
}
interface Freebet {
  id: string;
  bookmakerId: string;
  amount: number;
  minOdds: number;
}

const OUTCOMES: Array<"1" | "X" | "2"> = ["1", "X", "2"];
const STORAGE_KEY = "smarkets-extraction-project";

/** Förladdat "temporärt projekt": dina 4 konton med pengar + 5 freebets.
 *  Sparas till localStorage så det överlever omladdning. */
const DEFAULT_ACCOUNTS: Account[] = [
  { id: "acc-gb", bookmakerId: "goldenbull", balance: 2650, wageringRemaining: 0, minOdds: 1.5 },
  { id: "acc-x3", bookmakerId: "x3000", balance: 2630, wageringRemaining: 0, minOdds: 1.5 },
  { id: "acc-sb", bookmakerId: "speedybet", balance: 2650, wageringRemaining: 0, minOdds: 1.5 },
  { id: "acc-1x2", bookmakerId: "1x2", balance: 2630, wageringRemaining: 0, minOdds: 1.5 },
];
const DEFAULT_FREEBETS: Freebet[] = [
  { id: "fb-unibet", bookmakerId: "unibet", amount: 1000, minOdds: 2.0 },
  { id: "fb-hajper", bookmakerId: "hajper", amount: 500, minOdds: 2.0 },
  { id: "fb-dbet", bookmakerId: "dbet", amount: 500, minOdds: 2.0 },
  { id: "fb-mrvegas", bookmakerId: "mrvegas", amount: 500, minOdds: 2.0 },
  { id: "fb-megariches", bookmakerId: "megariches", amount: 500, minOdds: 2.0 },
];

function loadProject(): { accounts: Account[]; freebets: Freebet[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { accounts?: Account[]; freebets?: Freebet[] };
      if (Array.isArray(p.accounts) && Array.isArray(p.freebets)) {
        return { accounts: p.accounts, freebets: p.freebets };
      }
    }
  } catch { /* fall through */ }
  return { accounts: DEFAULT_ACCOUNTS, freebets: DEFAULT_FREEBETS };
}

const OUTCOME_LABEL: Record<string, string> = { "1": "Hemma", X: "Oavgjort", "2": "Borta" };
const BOOKMAKER_NAMES: Record<string, string> = {
  goldenbull: "Golden Bull", x3000: "X3000", speedybet: "Speedybet", oneTwo: "1x2", "1x2": "1x2",
  betsson: "Betsson", bethard: "Bethard", spelklubben: "Spelklubben", nordicbet: "NordicBet", betsafe: "Betsafe",
  hajper: "Hajper", snabbare: "Snabbare", comeon: "ComeOn", casinostugan: "Casinostugan", lyllo: "Lyllo",
  unibet: "Unibet", dbet: "DBET", mrvegas: "MrVegas", megariches: "MegaRiches",
};
function bookName(id: string): string { return BOOKMAKER_NAMES[id] ?? id; }
function rid(): string { return Math.random().toString(36).slice(2, 9); }

/** En rekommenderad uttags-bet (lay-matchad mot Smarkets). */
interface Rec {
  match: string;
  startTs?: string;
  outcome: "1" | "X" | "2";
  backOdds: number;
  layOdds: number;
  backStake: number;
  layStake: number;
  liability: number;
  matchedProfit: number; // netto (negativt = kostnad för vanligt bet, positivt = behållet för freebet)
}

export default function SmarketsExtraction() {
  const [data, setData] = useState<ExtractionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(() => loadProject().accounts);
  const [freebets, setFreebets] = useState<Freebet[]>(() => loadProject().freebets);

  // Spara projektet (konton + freebets) till localStorage vid varje ändring.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ accounts, freebets })); } catch { /* ignore */ }
  }, [accounts, freebets]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/smarkets-extraction?hours=72"));
      const json = (await res.json()) as ExtractionResponse;
      if (!json.ok) throw new Error("Kunde inte hämta Smarkets-matcher");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void fetchData(); }, [fetchData]);

  const commission = data?.commission ?? 0.02;
  // Bookmakers vi faktiskt har odds för (för dropdownen).
  const availableBooks = useMemo(() => {
    const set = new Set<string>();
    for (const m of data?.matches ?? []) for (const b of Object.keys(m.books)) set.add(b);
    return [...set].sort();
  }, [data]);

  /** Top-rekommendationer för ett konto (vanligt bet, stake återbetalas). */
  function recsForAccount(acc: Account): Rec[] {
    const recs: Rec[] = [];
    for (const m of data?.matches ?? []) {
      const back = m.books[acc.bookmakerId];
      if (!back) continue;
      for (const o of OUTCOMES) {
        const b = back[o];
        const l = m.smarketsLay[o];
        if (typeof b !== "number" || b < acc.minOdds) continue;
        if (typeof l !== "number" || !(l > commission)) continue;
        const r = computeLayMatch({ backStake: acc.balance, backOdds: b, layOdds: l, commission, stakeReturned: true });
        recs.push({
          match: m.title, startTs: m.startTs, outcome: o, backOdds: b, layOdds: l,
          backStake: acc.balance, layStake: roundLayStake(r.layStake), liability: r.liability, matchedProfit: r.matchedProfit,
        });
      }
    }
    // Bäst = minst kostnad (matchedProfit närmast 0 / högst).
    return recs.sort((a, b) => b.matchedProfit - a.matchedProfit).slice(0, 3);
  }

  /** Top-rekommendationer för en freebet (stake EJ återbetald, höga odds bäst). */
  function recsForFreebet(fb: Freebet): Rec[] {
    const recs: Rec[] = [];
    for (const m of data?.matches ?? []) {
      const back = m.books[fb.bookmakerId];
      if (!back) continue;
      for (const o of OUTCOMES) {
        const b = back[o];
        const l = m.smarketsLay[o];
        if (typeof b !== "number" || b < fb.minOdds) continue;
        if (typeof l !== "number" || !(l > commission)) continue;
        const r = computeLayMatch({ backStake: fb.amount, backOdds: b, layOdds: l, commission, stakeReturned: false });
        recs.push({
          match: m.title, startTs: m.startTs, outcome: o, backOdds: b, layOdds: l,
          backStake: fb.amount, layStake: roundLayStake(r.layStake), liability: r.liability, matchedProfit: r.matchedProfit,
        });
      }
    }
    return recs.sort((a, b) => b.matchedProfit - a.matchedProfit).slice(0, 3);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <BrandHeader className="mb-4" />
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/bonus-optimizer"><Button variant="ghost" size="sm"><ArrowLeft className="mr-1 h-4 w-4" />Tillbaka</Button></Link>
            <h1 className="text-2xl font-bold tracking-tight">Smarkets-uttag (dag 2)</h1>
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchData()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Uppdatera
          </Button>
        </div>

        <Card className="mb-4 border-sky-500/30 bg-sky-500/5">
          <CardContent className="p-4 text-xs text-muted-foreground">
            Mata in dina konton (saldo att tömma) + freebets. Appen matchar dina bookmaker-odds mot
            Smarkets lay-odds och föreslår bets: <b>backa</b> på bookmakern, <b>laya</b> på Smarkets
            ({(commission * 100).toFixed(0)}% kommission). Du behåller ungefär samma pengar — men flyttar
            dem till Smarkets (fria) och uppfyller omsättningen.
            {data && <span className="ml-1">Smarkets-data: {data.matchCount} matcher · uppdaterad {data.smarketsUpdatedAt ? new Date(data.smarketsUpdatedAt).toLocaleTimeString("sv-SE") : "—"}.</span>}
          </CardContent>
        </Card>

        {error && <Card className="mb-4 border-destructive/50"><CardContent className="p-4 text-sm text-destructive">{error}</CardContent></Card>}

        {/* KONTON */}
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-bold">Konton med saldo</h2>
          <Button size="sm" variant="outline" onClick={() => setAccounts((a) => [...a, { id: rid(), bookmakerId: availableBooks[0] ?? "goldenbull", balance: 0, wageringRemaining: 0, minOdds: 1.5 }])}>
            <Plus className="mr-1 h-4 w-4" />Lägg till konto
          </Button>
        </div>
        <div className="space-y-3">
          {accounts.map((acc) => {
            const recs = recsForAccount(acc);
            return (
              <Card key={acc.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Bookmaker">
                      <select className="h-9 rounded-md border bg-background px-2 text-sm" value={acc.bookmakerId}
                        onChange={(e) => setAccounts((a) => a.map((x) => x.id === acc.id ? { ...x, bookmakerId: e.target.value } : x))}>
                        {[acc.bookmakerId, ...availableBooks.filter((b) => b !== acc.bookmakerId)].map((b) => <option key={b} value={b}>{bookName(b)}</option>)}
                      </select>
                    </Field>
                    <Field label="Saldo (kr)"><NumInput value={acc.balance} onChange={(v) => setAccounts((a) => a.map((x) => x.id === acc.id ? { ...x, balance: v } : x))} /></Field>
                    <Field label="Omsättn. kvar (kr)"><NumInput value={acc.wageringRemaining} onChange={(v) => setAccounts((a) => a.map((x) => x.id === acc.id ? { ...x, wageringRemaining: v } : x))} /></Field>
                    <Field label="Min odds"><NumInput value={acc.minOdds} step={0.1} onChange={(v) => setAccounts((a) => a.map((x) => x.id === acc.id ? { ...x, minOdds: v } : x))} /></Field>
                    <Button size="icon" variant="ghost" className="h-9 w-9 text-rose-500" onClick={() => setAccounts((a) => a.filter((x) => x.id !== acc.id))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  <RecList recs={recs} kind="account" loading={loading} bookId={acc.bookmakerId} />
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* FREEBETS */}
        <div className="mb-2 mt-6 flex items-center justify-between">
          <h2 className="text-base font-bold">Freebets</h2>
          <Button size="sm" variant="outline" onClick={() => setFreebets((f) => [...f, { id: rid(), bookmakerId: availableBooks[0] ?? "goldenbull", amount: 0, minOdds: 3.0 }])}>
            <Plus className="mr-1 h-4 w-4" />Lägg till freebet
          </Button>
        </div>
        <div className="space-y-3">
          {freebets.map((fb) => {
            const recs = recsForFreebet(fb);
            return (
              <Card key={fb.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Bookmaker">
                      <select className="h-9 rounded-md border bg-background px-2 text-sm" value={fb.bookmakerId}
                        onChange={(e) => setFreebets((f) => f.map((x) => x.id === fb.id ? { ...x, bookmakerId: e.target.value } : x))}>
                        {[fb.bookmakerId, ...availableBooks.filter((b) => b !== fb.bookmakerId)].map((b) => <option key={b} value={b}>{bookName(b)}</option>)}
                      </select>
                    </Field>
                    <Field label="Freebet (kr)"><NumInput value={fb.amount} onChange={(v) => setFreebets((f) => f.map((x) => x.id === fb.id ? { ...x, amount: v } : x))} /></Field>
                    <Field label="Min odds"><NumInput value={fb.minOdds} step={0.1} onChange={(v) => setFreebets((f) => f.map((x) => x.id === fb.id ? { ...x, minOdds: v } : x))} /></Field>
                    <Button size="icon" variant="ghost" className="h-9 w-9 text-rose-500" onClick={() => setFreebets((f) => f.filter((x) => x.id !== fb.id))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  <RecList recs={recs} kind="freebet" loading={loading} bookId={fb.bookmakerId} />
                </CardContent>
              </Card>
            );
          })}
          {freebets.length === 0 && <p className="text-xs text-muted-foreground">Inga freebets tillagda än.</p>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>;
}
function NumInput({ value, onChange, step = 10 }: { value: number; onChange: (v: number) => void; step?: number }) {
  return <Input type="number" step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number(e.target.value) || 0)} className="h-9 w-28 font-mono" />;
}

function RecList({ recs, kind, loading, bookId }: { recs: Rec[]; kind: "account" | "freebet"; loading: boolean; bookId: string }) {
  if (loading) return <div className="mt-3 text-xs text-muted-foreground">Laddar Smarkets-matcher…</div>;
  if (recs.length === 0) return <div className="mt-3 text-xs text-muted-foreground">Inga Smarkets-matchade odds hittade för {bookName(bookId)} just nu (prova sänka min odds eller uppdatera).</div>;
  return (
    <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
      {recs.map((r, i) => (
        <div key={i} className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{r.match}</span>
            <Badge variant="secondary" className="text-[10px]">{OUTCOME_LABEL[r.outcome]} ({r.outcome})</Badge>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono sm:grid-cols-4">
            <span>Backa: <b>{r.backStake.toFixed(0)} kr</b> @ {r.backOdds.toFixed(2)}</span>
            <span>Laya: <b>{r.layStake.toFixed(2)} kr</b> @ {r.layOdds.toFixed(2)}</span>
            <span>Liability: {r.liability.toFixed(0)} kr</span>
            <span className={r.matchedProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500"}>
              {kind === "freebet" ? "Behåller" : "Kostnad"}: {r.matchedProfit >= 0 ? "+" : ""}{r.matchedProfit.toFixed(0)} kr
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
