import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { Button } from "@/components/ui/button";

type Doc = {
  id: string;
  title: string;
  category: string;
  content: string;
  chunkCount: number;
  embedded: boolean;
  updatedAt: string;
};

export default function AdminAthena() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Allmänt");
  const [content, setContent] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/athena/docs", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 403) {
        setError("Endast admin kan hantera Athenas kunskapsbas.");
        return;
      }
      const data = (await res.json()) as { ok: boolean; configured?: boolean; docs?: Doc[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDocs(data.docs ?? []);
      setConfigured(data.configured !== false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setEditId(null);
    setTitle("");
    setCategory("Allmänt");
    setContent("");
  };

  const save = async () => {
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const url = editId ? `/api/admin/athena/docs/${editId}` : "/api/admin/athena/docs";
      const method = editId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ title, category, content }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const edit = (d: Doc) => {
    setEditId(d.id);
    setTitle(d.title);
    setCategory(d.category);
    setContent(d.content);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const remove = async (id: string) => {
    if (!confirm("Radera dokumentet ur kunskapsbasen?")) return;
    try {
      await fetch(`/api/admin/athena/docs/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (editId === id) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/athena/reindex", { method: "POST", credentials: "same-origin" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <Link to="/athena" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Till Athena-chatten
        </Link>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrandHeader size="sm" showText={false} />
            <h1 className="text-xl font-bold tracking-tight">Athena — kunskapsbas</h1>
          </div>
          <button
            onClick={() => void reindex()}
            disabled={reindexing}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Bygg om alla embeddings (t.ex. efter att API-nyckeln lagts till)"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reindexing ? "animate-spin" : ""}`} />
            Indexera om
          </button>
        </div>

        {!configured && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            ⚠ <b>OPENAI_API_KEY saknas</b> på servern. Du kan lägga in dokument redan nu, men Athena kan inte söka i
            dem eller svara förrän nyckeln är satt i Render → Environment. Klicka sedan <b>Indexera om</b>.
          </div>
        )}

        {/* Formulär */}
        <div className="mb-6 rounded-xl border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {editId ? "Redigera dokument" : "Lägg till dokument"}
            </h2>
            {editId && (
              <button onClick={resetForm} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" /> Avbryt
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Titel (t.ex. 'Guide: Bonusuttag på Stake')"
              className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            />
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Kategori (t.ex. Bonus, Value betting, Stake)"
              className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Klistra in guiden, FAQ:n eller instruktionen här. Athena delar automatiskt upp texten i sökbara bitar."
            rows={8}
            className="mt-3 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          />
          <div className="mt-3 flex items-center gap-3">
            <Button onClick={() => void save()} disabled={saving || !title.trim() || !content.trim()}>
              {editId ? <Pencil className="mr-1.5 h-4 w-4" /> : <Plus className="mr-1.5 h-4 w-4" />}
              {saving ? "Sparar…" : editId ? "Spara ändringar" : "Lägg till"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {content.trim().length.toLocaleString("sv-SE")} tecken
            </span>
          </div>
        </div>

        {error && <div className="mb-3 text-xs text-destructive">{error}</div>}
        {loading && <div className="mb-3 text-xs text-muted-foreground">Laddar…</div>}

        {/* Lista */}
        <h2 className="mb-2 text-sm font-semibold">Dokument ({docs.length})</h2>
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.title}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{d.category}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                      d.embedded
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {d.embedded ? `${d.chunkCount} bitar indexerade` : "ej indexerad"}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.content.slice(0, 220)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => edit(d)} className="text-muted-foreground hover:text-foreground" title="Redigera">
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => void remove(d.id)} className="text-muted-foreground hover:text-destructive" title="Radera">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {!loading && docs.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              Inga dokument än. Lägg till din första guide ovan.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
