import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, Copy, Download } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type StatusResponse =
  | { ok: true; active: false }
  | { ok: true; active: true; license_key: string; expires_at: string };

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
      <motionlessCommandBlockHeader label={label} copied={copied} onCopy={() => void copy()} />
      <pre className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {commands}
      </pre>
    </div>
  );
}

function motionlessCommandBlockHeader({
  label,
  copied,
  onCopy,
}: {
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCopy}>
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
  );
}

function RequirementStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-2">
      <h3 className="text-sm font-semibold">
        {n}. {title}
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">
        Steg {n} — {title}
      </h3>
      <div className="text-sm text-muted-foreground">{children}</div>
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

        {loading && <p className="mt-4 text-sm text-muted-foreground">Laddar…</p>}
        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        {!loading && !error && active && status.active && (
          <div className="mt-6 space-y-6">
            <Card>
              <CardContent className="space-y-4 p-6">
                <p className="font-medium text-green-700 dark:text-green-400">
                  Din autoclicker-licens är aktiv
                </p>
                <div className="space-y-2 text-sm">
                  <p>
                    <span className="text-muted-foreground">Licensnyckel:</span>{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{status.license_key}</code>
                  </p>
                  <p>
                    <span className="text-muted-foreground">Giltig till:</span>{" "}
                    {status.expires_at.slice(0, 10)}
                  </p>
                </div>
                <Button asChild className="w-full sm:w-auto">
                  <a href="/autoclicker/download">
                    <Download className="mr-2 h-4 w-4" />
                    Ladda ner botten
                  </a>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-6">
                <h2 className="text-lg font-semibold">Inställningar som behövs</h2>
                <p className="text-sm text-muted-foreground">
                  Kontrollera detta innan du laddar ner och startar botten.
                </p>

                <RequirementStep n={1} title="Internet">
                  <p>Botten behöver internet för att kunna kontrollera att licensen är aktiv.</p>
                  <p>Om du saknar internet kan botten inte starta.</p>
                </RequirementStep>

                <RequirementStep n={2} title="Python 3.11 installerat (Mac)">
                  <p>Botten kräver minst <strong>Python 3.11</strong>. Testa först vilken version du har i Terminal:</p>
                  <CommandBlock label="Kontrollera Python" commands="python3 --version" />
                  <p>
                    Om den visar <code className="rounded bg-muted px-1 font-mono">Python 3.11</code> eller högre är
                    du klar — hoppa till &quot;Så kommer du igång&quot;.
                  </p>
                  <p className="pt-1">
                    Visar den en lägre version (t.ex.{" "}
                    <code className="rounded bg-muted px-1 font-mono">Python 3.9.6</code>) eller säger{" "}
                    <code className="rounded bg-muted px-1 font-mono">Python 3.11 saknas</code> när du kör{" "}
                    <code className="rounded bg-muted px-1 font-mono">setup.sh</code>, måste du installera Python 3.11.
                    Kör dessa två kommandon, ett i taget:
                  </p>
                  <CommandBlock
                    label="1. Installera Homebrew (om det saknas)"
                    commands={`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`}
                  />
                  <p>
                    Detta tar 1–2 minuter och kan fråga efter ditt Mac-lösenord. Är Homebrew redan installerat kan du
                    hoppa över detta steg.
                  </p>
                  <CommandBlock label="2. Installera Python 3.11" commands="brew install python@3.11" />
                  <p>
                    När båda är klara kan du gå vidare till &quot;Så kommer du igång&quot; och köra{" "}
                    <code className="rounded bg-muted px-1 font-mono">bash setup.sh</code> igen.
                  </p>
                  <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                    Tips: om Homebrew efter installationen säger att du ska köra ett par{" "}
                    <code className="font-mono">eval</code>-rader (för att lägga till{" "}
                    <code className="font-mono">brew</code> i din PATH), kopiera och kör dem — annars hittar Terminal
                    inte <code className="font-mono">brew</code>.
                  </p>
                </RequirementStep>

                <RequirementStep n={3} title="Terminal får köra filer">
                  <p>På Mac kan du få en säkerhetsvarning första gången.</p>
                  <p>Gå då till:</p>
                  <p className="font-medium text-foreground">Systeminställningar → Integritet och säkerhet</p>
                  <p>Om Mac blockerar något, välj:</p>
                  <p className="font-medium text-foreground">Tillåt ändå</p>
                </RequirementStep>

                <RequirementStep n={4} title="Bot-Chrome används, inte vanlig Chrome">
                  <p>När botten startar öppnas ett eget Chrome-fönster.</p>
                  <p>
                    Logga in i det Chrome-fönstret som botten öppnar. Logga inte bara in i din vanliga Chrome.
                  </p>
                </RequirementStep>

                <RequirementStep n={5} title="Första gången: licensnyckel">
                  <p>Första gången botten startar frågar den efter din licensnyckel.</p>
                  <p>Kopiera licensnyckeln från denna sida och klistra in den i Terminal.</p>
                  <p>
                    Exempel på licensnyckel:{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{status.license_key}</code>
                  </p>
                </RequirementStep>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-6 p-6">
                <h2 className="text-lg font-semibold">Så kommer du igång</h2>

                <Step n={1} title="Ladda ner">
                  <p>
                    Klicka på &quot;Ladda ner botten&quot;. Filen hamnar normalt i{" "}
                    <strong>Hämtade filer</strong> / <strong>Downloads</strong>.
                  </p>
                </Step>

                <Step n={2} title="Packa upp">
                  <p>
                    Dubbelklicka på <code className="rounded bg-muted px-1">autoclicker-share.zip</code>.
                    Då skapas en mapp som oftast heter <code className="rounded bg-muted px-1">autoclicker</code>.
                  </p>
                </Step>

                <Step n={3} title="Öppna Terminal / Command Prompt">
                  <p className="mb-3 font-medium text-foreground">Mac</p>
                  <p className="mb-2">Öppna Terminal och kör:</p>
                  <CommandBlock
                    label="Mac — första gången"
                    commands={`cd ~/Downloads/autoclicker\nbash setup.sh\npython3 playwright_bot.py`}
                  />
                  <p className="mt-4 mb-3 font-medium text-foreground">Windows</p>
                  <p className="mb-2">Öppna Command Prompt eller PowerShell i mappen och kör:</p>
                  <CommandBlock
                    label="Windows — första gången"
                    commands={`setup-windows.bat\npython playwright_bot.py`}
                  />
                </Step>

                <Step n={4} title="Licensnyckel">
                  <p>
                    Första gången botten startar frågar den efter licensnyckel. Kopiera licensnyckeln från denna
                    sida och klistra in den i terminalen.
                  </p>
                </Step>

                <Step n={5} title="Logga in i bot-Chrome">
                  <p>
                    När botten öppnar Chrome, logga in där. Det är viktigt att du loggar in i{" "}
                    <strong>bot-Chrome</strong>, inte vanlig Chrome. Inloggningen sparas lokalt.
                  </p>
                </Step>

                <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Om mappen heter något annat än <code className="font-mono">autoclicker</code>, byt{" "}
                  <code className="font-mono">autoclicker</code> i kommandot till mappens namn.
                  <br />
                  På Mac kan du även högerklicka i mappen och välja <strong>Öppna Terminal här</strong> om
                  alternativet finns.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-6">
                <h2 className="text-lg font-semibold">Nästa gång du startar botten</h2>
                <CommandBlock
                  label="Mac"
                  commands={`cd ~/Downloads/autoclicker\npython3 playwright_bot.py`}
                />
                <CommandBlock
                  label="Windows — öppna bot-mappen och kör"
                  commands="python playwright_bot.py"
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-6">
                <h2 className="text-lg font-semibold">Snabbkommandon</h2>
                <CommandBlock
                  label="Mac — första gången"
                  commands={`cd ~/Downloads/autoclicker\nbash setup.sh\npython3 playwright_bot.py`}
                />
                <CommandBlock
                  label="Mac — nästa gång"
                  commands={`cd ~/Downloads/autoclicker\npython3 playwright_bot.py`}
                />
                <CommandBlock
                  label="Windows — första gången"
                  commands={`setup-windows.bat\npython playwright_bot.py`}
                />
                <CommandBlock label="Windows — nästa gång" commands="python playwright_bot.py" />
              </CardContent>
            </Card>
          </div>
        )}

        {!loading && !error && !active && (
          <Card className="mt-6">
            <CardContent className="p-6 text-sm">
              <p className="font-medium">Du har ingen aktiv autoclicker-licens</p>
              <p className="mt-2 text-muted-foreground">Kontakta mig för att aktivera månadsmedlemskap.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
