import { Link } from "react-router-dom";
import { ArrowRight, Compass, ShieldCheck, Trophy } from "lucide-react";
import { SourcesStatus } from "@/components/SourcesStatus";
import { useAuth } from "@/contexts/AuthContext";
import { useUserSettings } from "@/hooks/useUserSettings";
import type { TranslationKey } from "@/lib/settings/i18n";

interface SystemDef {
  titleKey: TranslationKey;   // Nytt namn (Athena, Ithaca …)
  subtitle: string;           // Gamla/funktionsnamnet (fetstil)
  shortKey: TranslationKey;   // Kort beskrivning på kortet
  emblem: string;             // /branding/emblem-*.png
  href: string;
  openToCustomers: boolean;
}

// Ordning matchar mockupen: rad 1 = Athena, Ithaca, Outis · rad 2 = Odysseus, Argos, Xenia
const systems: SystemDef[] = [
  { titleKey: "home.athena",         subtitle: "AI-assistent",       shortKey: "home.athenaShort",   emblem: "/branding/emblem-athena.png",   href: "/athena",          openToCustomers: false },
  { titleKey: "home.valuebets",      subtitle: "Valuebets",          shortKey: "home.ithacaShort",   emblem: "/branding/emblem-ithaca.png",   href: "/valuebets",       openToCustomers: false },
  { titleKey: "home.bonusFinder",    subtitle: "Bonus Finder",       shortKey: "home.outisShort",    emblem: "/branding/emblem-outis.png",    href: "/bonus-finder",    openToCustomers: false },
  { titleKey: "home.bonusOptimizer", subtitle: "Bonus optimering",   shortKey: "home.odysseusShort", emblem: "/branding/emblem-odysseus.png", href: "/bonus-optimizer", openToCustomers: false },
  { titleKey: "home.autoclicker",    subtitle: "Autoclicker",        shortKey: "home.argosShort",    emblem: "/branding/emblem-argos.png",    href: "/autoclicker",     openToCustomers: true },
  { titleKey: "home.stakeBetonline", subtitle: "Stake & Betonline",  shortKey: "home.xeniaShort",    emblem: "/branding/emblem-xenia.png",    href: "/stake-betonline", openToCustomers: false },
];

const SERIF = "'Georgia', 'Times New Roman', serif";

export default function Home() {
  const { isAdmin, canValuebets, canBonusFinder, canBonusOptimizer, canAthena } = useAuth();
  const { t } = useUserSettings();

  const headline = t("home.heroHeadline");

  return (
    <div
      className="relative min-h-screen overflow-hidden text-stone-100"
      style={{
        background:
          "radial-gradient(1100px 560px at 72% 8%, rgba(196,154,72,0.20), transparent 60%), " +
          "linear-gradient(160deg, #0c1310 0%, #0a0f0d 45%, #060907 100%)",
      }}
    >
      {/* Hjälte-konstverk (Odysseus) — text-fritt, tonas in till höger */}
      <img
        src="/branding/home-hero.webp?v=1"
        alt=""
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 hidden h-[62vh] max-h-[640px] w-auto select-none opacity-90 md:block"
        style={{ WebkitMaskImage: "linear-gradient(to left, black 60%, transparent 100%)", maskImage: "linear-gradient(to left, black 60%, transparent 100%)" }}
        draggable={false}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[62vh] max-h-[640px]"
        style={{ background: "linear-gradient(to bottom, transparent 60%, rgba(6,9,7,0.85) 100%)" }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-6xl px-5 py-8 sm:py-12">
        {/* ── Topprad: logga + plakett ── */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/favicon.png?v=3" alt="" width={48} height={48} className="rounded-lg" draggable={false} />
            <div>
              <div className="text-2xl font-bold tracking-tight" style={{ fontFamily: SERIF }}>Oddexus</div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-500/90">{t("home.tagline")}</div>
            </div>
          </div>
          <div className="hidden max-w-xs rounded-xl border border-amber-600/40 bg-black/40 px-4 py-2 text-right backdrop-blur sm:block">
            <div className="text-xs font-semibold text-amber-400">{t("home.plaqueTitle")}</div>
            <div className="text-[11px] text-stone-300">{t("home.plaqueSub")}</div>
          </div>
        </div>

        {/* ── Hero ── */}
        <div className="mt-10 grid items-end gap-8 md:mt-16 md:grid-cols-[1.4fr_1fr]">
          <div>
            <h1 className="text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl" style={{ fontFamily: SERIF }}>
              {headline.split(/(\.)/).map((part, i) =>
                part === "." ? <span key={i} className="text-amber-500">.</span> : <span key={i}>{part}</span>,
              )}
            </h1>
            <p className="mt-5 max-w-xl text-lg font-medium text-stone-200">{t("home.heroSubtitle")}</p>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-stone-400">{t("home.heroBody")}</p>
            <a
              href="#system"
              className="mt-7 inline-flex items-center gap-2 rounded-full border border-amber-600/60 bg-gradient-to-b from-amber-500/90 to-amber-700/90 px-6 py-2.5 text-sm font-semibold text-black shadow-lg transition hover:from-amber-400 hover:to-amber-600"
            >
              {t("home.heroCta")}
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>

          {/* Citat */}
          <blockquote className="border-l-2 border-amber-600/50 pl-4 md:text-right md:border-l-0 md:border-r-2 md:pl-0 md:pr-4">
            <p className="text-lg italic leading-snug text-stone-200" style={{ fontFamily: SERIF }}>
              ”{t("home.quote")}”
            </p>
            <footer className="mt-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-500/80">
              — {t("home.quoteAuthor")}
            </footer>
          </blockquote>
        </div>

        {/* ── System-kort ── */}
        <div id="system" className="mt-12 grid gap-4 scroll-mt-6 sm:grid-cols-2 lg:grid-cols-3">
          {systems.map((s) => {
            const featureAllowed =
              s.href === "/valuebets" ? canValuebets
                : s.href === "/bonus-finder" ? canBonusFinder
                  : s.href === "/bonus-optimizer" ? canBonusOptimizer
                    : s.href === "/athena" ? canAthena
                      : false;
            const open = isAdmin || s.openToCustomers || featureAllowed;
            return (
              <Link
                key={s.href}
                to={s.href}
                className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-amber-900/30 bg-[#efe7d4] p-4 text-[#241c12] shadow-[0_8px_30px_rgba(0,0,0,0.45)] transition hover:-translate-y-0.5 hover:border-amber-600/60 hover:shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
              >
                <img
                  src={s.emblem}
                  alt=""
                  width={64}
                  height={64}
                  className="h-16 w-16 shrink-0 rounded-full border-2 border-amber-800/40 object-cover shadow-inner"
                  draggable={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xl font-bold leading-tight" style={{ fontFamily: SERIF }}>{t(s.titleKey)}</div>
                  <div className="text-xs font-bold text-amber-800/90">{s.subtitle}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-[#5b4a33]">{t(s.shortKey)}</div>
                </div>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1a1208] text-amber-400 transition group-hover:bg-amber-600 group-hover:text-black">
                  {open ? <ArrowRight className="h-4 w-4" /> : <span className="text-[9px] font-bold uppercase">{t("home.soon")}</span>}
                </div>
              </Link>
            );
          })}
        </div>

        {/* ── Förtroende-rad ── */}
        <div className="mt-12 grid gap-6 rounded-2xl border border-amber-900/20 bg-black/30 p-5 backdrop-blur sm:grid-cols-3">
          {[
            { Icon: ShieldCheck, title: t("home.trust1Title"), sub: t("home.trust1Sub") },
            { Icon: Trophy,      title: t("home.trust2Title"), sub: t("home.trust2Sub") },
            { Icon: Compass,     title: t("home.trust3Title"), sub: t("home.trust3Sub") },
          ].map(({ Icon, title, sub }, i) => (
            <div key={i} className="flex items-start gap-3">
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div>
                <div className="text-sm font-semibold text-stone-100">{title}</div>
                <div className="text-xs text-stone-400">{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Källor & bookmakers (källhälsa) — kvar för admin/överblick */}
        <div className="mt-10">
          <SourcesStatus />
        </div>
      </div>
    </div>
  );
}
