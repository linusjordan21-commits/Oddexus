import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy, Download } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type StatusResponse =
  | { ok: true; active: false }
  | { ok: true; active: true; license_key: string; expires_at: string };

/** Kommando-block med kopiera-knapp (för dem som hellre kör i Terminal). */
function CommandBlock({ label, commands }: { label: string; commands: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check className="mr-1 h-3 w-3" />
              Kopierat
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3 w-3" />
              Kopiera
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {commands}
      </pre>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
        {n}
      </div>
      <div className="space-y-1 pt-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export default function Autoclicker() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/autoclicker/status", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        setError(`Kunde inte hämta status (HTTP ${res.status})`);
        setStatus(null);
        return;
      }
      setStatus((await res.json()) as StatusResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = status?.ok === true && status.active;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Tillbaka
        </Link>
        <BrandHeader size="md" className="mb-4" />
        <h1 className="text-2xl font-bold tracking-tight">Argos</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Autoclicker för casino-omsättning. Körs på din dator men styrs av ditt medlemskap — den fungerar bara
          så länge du är aktiv medlem.
        </p>

        {loading && <p className="mt-6 text-sm text-muted-foreground">Laddar…</p>}
        {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

        {/* AKTIV MEDLEM */}
        {!loading && !error && active && status.active && (
          <div className="mt-6 space-y-6">
            <Card>
              <CardContent className="space-y-4 p-6">
                <p className="font-medium text-green-700 dark:text-green-400">Ditt Argos-medlemskap är aktivt</p>
                <p className="text-sm text-muted-foreground">Giltigt till {status.expires_at.slice(0, 10)}</p>
                <Button asChild className="w-full sm:w-auto">
                  <a href="/autoclicker/download">
                    <Download className="mr-2 h-4 w-4" />
                    Ladda ner Argos
                  </a>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-5 p-6">
                <h2 className="text-lg font-semibold">Så kommer du igång (Mac)</h2>

                <Step n={1} title="Ladda ner och packa upp">
                  Klicka <strong>Ladda ner Argos</strong>. Dubbelklicka sedan zip-filen i Hämtade filer — en mapp skapas.
                </Step>

                <Step n={2} title="Starta">
                  Dubbelklicka <strong>Starta-boten.command</strong> i mappen. Första gången installeras allt som behövs
                  automatiskt (tar några minuter). Får du en säkerhetsvarning på Mac:{" "}
                  <span className="font-medium text-foreground">Systeminställningar → Integritet och säkerhet → "Tillåt ändå"</span>.
                </Step>

                <Step n={3} title="Logga in">
                  Boten ber om inloggning första gången — använd <strong>samma konto som här på oddexus.com</strong>.
                  Ingen licensnyckel behövs. Sedan kommer den ihåg dig.
                </Step>

                <Step n={4} title="Casinon och kalibrering">
                  Logga in på casinona i det bot-Chrome-fönster som öppnas, och klicka på <strong>SPIN</strong> och{" "}
                  <strong>SALDO</strong> när boten ber dig kalibrera. Klart — boten sköter resten.
                </Step>

                <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <strong>€</strong> = pausa / starta (ett tryck, ingen Enter). Nästa gång: dubbelklicka{" "}
                  <strong>Starta-boten.command</strong> igen — du är redan inloggad och fortsätter direkt.
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="text-lg font-semibold">Om dubbelklick inte fungerar</h2>
                <p className="text-sm text-muted-foreground">
                  Öppna Terminal och kör (byt mappnamn om din mapp heter något annat):
                </p>
                <CommandBlock label="Mac" commands={`cd ~/Downloads/kundoddexusbot\nbash setup.sh\nbash run.sh`} />
              </CardContent>
            </Card>
          </div>
        )}

        {/* INTE AKTIV */}
        {!loading && !error && !active && (
          <Card className="mt-6">
            <CardContent className="space-y-2 p-6 text-sm">
              <p className="font-medium">Du har inget aktivt Argos-medlemskap</p>
              <p className="text-muted-foreground">
                Kontakta oss för att aktivera ditt månadsmedlemskap, så får du tillgång till boten direkt.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
