import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Send, Sparkles, Trash2 } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

type Source = { title: string; category: string };
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

const STORAGE_KEY = "athena.history.v1";
const GREETING: ChatMessage = {
  role: "assistant",
  content:
    "Hej! Jag är Athena, din AI-assistent. Fråga mig om value betting, arbitrage, bonusuttag, Stake/BetOnline — eller vad som helst. Jag använder communityns kunskapsbas när det är relevant, annars allmän AI-kunskap.",
};

export default function Athena() {
  const { isAdmin } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      /* ignore */
    }
    return [GREETING];
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)));
    } catch {
      /* ignore */
    }
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/athena/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (res.status === 401) {
        setError("Du måste vara inloggad för att använda Athena.");
        return;
      }
      const data = (await res.json()) as {
        ok: boolean;
        reply?: string;
        sources?: Source[];
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply || "(tomt svar)", sources: data.sources },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      taRef.current?.focus();
    }
  }, [input, loading, messages]);

  const clearChat = () => {
    setMessages([GREETING]);
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Tillbaka
            </Link>
            <BrandHeader size="sm" showText={false} />
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-emerald-500" />
              <h1 className="text-xl font-bold tracking-tight">Athena</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <Link to="/admin/athena" className="text-xs text-emerald-600 hover:underline dark:text-emerald-400">
                Kunskapsbas
              </Link>
            )}
            <button
              onClick={clearChat}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              title="Rensa chatten"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Rensa
            </button>
          </div>
        </div>

        {/* Chattfönster */}
        <div
          ref={scrollRef}
          className="flex-1 space-y-4 overflow-y-auto rounded-xl border bg-card/40 p-4"
        >
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-emerald-600 text-white"
                    : "border bg-background text-foreground"
                }`}
              >
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-border/50 pt-2">
                    <span className="text-[10px] text-muted-foreground">Baserat på:</span>
                    {m.sources.map((s, j) => (
                      <span
                        key={j}
                        className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {s.title}
                        {s.category ? ` · ${s.category}` : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl border bg-background px-4 py-3 text-sm">
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  Athena skriver
                  <span className="inline-flex gap-0.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-500 [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-500 [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-500" />
                  </span>
                </span>
              </div>
            </div>
          )}
        </div>

        {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

        {/* Inmatning */}
        <div className="mt-3 flex items-end gap-2">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Skriv din fråga till Athena…  (Enter för att skicka, Shift+Enter för ny rad)"
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          />
          <Button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            className="h-11 px-4"
            aria-label="Skicka"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          Athena kan ha fel ibland — dubbelkolla viktig information.
        </p>
      </div>
    </div>
  );
}
