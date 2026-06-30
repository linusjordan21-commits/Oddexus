import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, LogIn, Shield, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

const SERIF = "'Georgia', 'Times New Roman', serif";

type System = { name: string; fn: string; desc: string; emblem: string };

// Samma sex system som på inloggade förstasidan (Home), i samma ordning.
const systems: System[] = [
  { name: "Athena", fn: "AI-assistent", desc: "AI-assistent för frågor och strategi.", emblem: "/branding/emblem-athena.png" },
  { name: "Ithaca", fn: "Value betting", desc: "Value betting och långsiktig edge.", emblem: "/branding/emblem-ithaca.png" },
  { name: "Outis", fn: "Bonus Finder", desc: "Enkel arbitrage och bonuslägen.", emblem: "/branding/emblem-outis.png" },
  { name: "Odysseus", fn: "Bonusoptimering", desc: "Avancerad arbitrage på flera sidor.", emblem: "/branding/emblem-odysseus.png" },
  { name: "Argos", fn: "Autoclicker", desc: "Automation och desktop-bot.", emblem: "/branding/emblem-argos.png" },
  { name: "Xenia", fn: "Stake & BetOnline", desc: "Stake/BetOnline bonusar och rewards.", emblem: "/branding/emblem-xenia.png" },
];

const whyPoints = [
  { icon: BarChart3, title: "Datadriven edge", body: "Skarpa odds, value och arbitrage — uträknat åt dig, inte gissat." },
  { icon: Sparkles, title: "Allt på ett ställe", body: "Sex system, en inloggning — från AI-strategi till automation." },
  { icon: Shield, title: "Byggt för dig", body: "Gjort för spelare som vill spela smart och långsiktigt." },
];

export default function Landing() {
  return (
    <div className="relative min-h-screen text-stone-100">
      {/* Bakgrund — samma bild som förstasidan */}
      <div
        className="fixed inset-0 -z-20 bg-cover bg-center"
        style={{ backgroundImage: "url('/branding/bg-wide.webp?v=2')" }}
        aria-hidden
      />
      <div
        className="fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(1100px 560px at 72% 6%, rgba(196,154,72,0.18), transparent 60%), " +
            "linear-gradient(160deg, rgba(8,14,11,0.82) 0%, rgba(6,10,8,0.88) 45%, rgba(4,7,5,0.94) 100%)",
        }}
        aria-hidden
      />

      {/* Topprad */}
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-3">
          <img src="/favicon.png?v=3" alt="" width={40} height={40} className="rounded-lg" draggable={false} />
          <div>
            <div className="text-xl font-bold tracking-tight" style={{ fontFamily: SERIF }}>
              Oddexus
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.25em] text-amber-500/90">
              Edge · Strategi · Frihet
            </div>
          </div>
        </div>
        <Button asChild variant="outline" className="border-amber-600/50 bg-black/30 text-stone-100 hover:bg-black/50">
          <Link to="/login">
            <LogIn className="mr-2 h-4 w-4" />
            Logga in
          </Link>
        </Button>
      </header>

      {/* Hjälte */}
      <section className="relative mx-auto max-w-6xl px-5 pb-20 pt-12 sm:pt-20">
        <div className="max-w-2xl">
          <p className="mb-4 inline-block rounded-full border border-amber-600/40 bg-black/30 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">
            För dig som spelar smart
          </p>
          <h1 className="text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl" style={{ fontFamily: SERIF }}>
            Strategi. <span className="text-amber-400">Edge.</span> Frihet.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-stone-300">
            Oddexus är verktygslådan för dig som spelar smart — value betting, arbitrage, bonusoptimering och
            automation, samlat på ett ställe.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-amber-600 text-black hover:bg-amber-500">
              <Link to="/login">
                Logga in
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-stone-600 bg-black/20 text-stone-100 hover:bg-black/40">
              <a href="#system">Se systemen</a>
            </Button>
          </div>
        </div>
      </section>

      {/* System */}
      <section id="system" className="relative mx-auto max-w-6xl px-5 py-16">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold tracking-tight" style={{ fontFamily: SERIF }}>
            Sex system. En edge.
          </h2>
          <p className="mt-2 text-stone-400">Varje verktyg har sin roll — tillsammans ger de dig övertaget.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {systems.map((s) => (
            <div
              key={s.name}
              className="group rounded-2xl border border-amber-700/20 bg-black/40 p-6 backdrop-blur transition hover:border-amber-600/50 hover:bg-black/55"
            >
              <img src={s.emblem} alt="" width={56} height={56} className="mb-4 h-14 w-14 object-contain" draggable={false} />
              <h3 className="text-xl font-bold" style={{ fontFamily: SERIF }}>
                {s.name}
              </h3>
              <p className="text-xs font-semibold uppercase tracking-wider text-amber-500/90">{s.fn}</p>
              <p className="mt-3 text-sm text-stone-300">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Varför */}
      <section className="relative mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-6 sm:grid-cols-3">
          {whyPoints.map((w) => (
            <div key={w.title} className="rounded-2xl border border-stone-700/40 bg-black/30 p-6 backdrop-blur">
              <w.icon className="mb-3 h-7 w-7 text-amber-400" />
              <h3 className="text-lg font-semibold">{w.title}</h3>
              <p className="mt-2 text-sm text-stone-400">{w.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Slut-CTA */}
      <footer className="relative mx-auto max-w-6xl px-5 py-16">
        <div className="rounded-3xl border border-amber-600/30 bg-gradient-to-br from-black/60 to-black/30 p-10 text-center backdrop-blur">
          <h2 className="text-3xl font-bold tracking-tight" style={{ fontFamily: SERIF }}>
            Redo att spela smart?
          </h2>
          <p className="mx-auto mt-3 max-w-md text-stone-300">Logga in för att komma åt dina system.</p>
          <Button asChild size="lg" className="mt-6 bg-amber-600 text-black hover:bg-amber-500">
            <Link to="/login">
              Logga in
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
        <p className="mt-10 text-center text-xs text-stone-500">© Oddexus · Edge · Strategi · Frihet</p>
      </footer>
    </div>
  );
}
