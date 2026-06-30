#!/usr/bin/env python3
"""
Oddexus autoclicker — fyra casinon samtidigt.

Öppnar GoGo, BetMGM, LeoVegas och Expekt (Big Bad Wolf) i samma bot-Chrome,
låter dig kalibrera SPIN-knappen + ditt SALDO på varje sida, och spinnar sedan
alla fyra samtidigt tills varje sidas omsättningsmål är nått.

Omsättning läses från casinots EGNA "Din omsättning: X / Y"-text (sanningen) efter
varje spin — saldot används bara för att UPPTÄCKA att ett spin skett (saldot minskar).
Skälet: en vinst nettas ofta in i samma saldo-uppdatering, så saldo-minskningen blir
mindre än insatsen och underskattar omsättningen. Kan casino-texten inte läsas just
då används saldo-minskningen som reserv. Free spins (ingen dragning) räknas som 0.

Allt körs lokalt på din dator. Inget skickas någonstans.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path as _Path

# Kör automatiskt i den lokala .venv om den finns men inte redan är aktiv, så att
# "python3 playwright_bot.py" (som instruktionerna säger) fungerar även utan att
# man aktiverat miljön manuellt.
_VENV_PY = _Path(__file__).resolve().parent / ".venv" / (
    "Scripts/python.exe" if os.name == "nt" else "bin/python"
)
if _VENV_PY.exists() and _Path(sys.executable).resolve() != _VENV_PY.resolve():
    os.execv(str(_VENV_PY), [str(_VENV_PY), str(_Path(__file__).resolve()), *sys.argv[1:]])

import asyncio
import atexit
import json
import re
import subprocess
import threading
import time
from pathlib import Path

from playwright.async_api import Page, async_playwright

# Licens-kontrollen är BORTTAGEN i den här kopian (på begäran 2026-06-29) — boten kör
# utan licensnyckel, så license_client importeras inte längre.

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "sites.json"
CALIB_FILE = BASE_DIR / "calibration.json"
LICENSE_FILE = BASE_DIR / "license.txt"
USER_DATA_DIR = BASE_DIR / "bot-chrome-profile"

CHROME_ARGS = [
    # Hindra Chrome från att strypa/pausa flikar som inte ligger i förgrunden,
    # så att alla fyra spelen kan snurra samtidigt.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "--start-maximized",
]

# Interna avläsningskonstanter (inte spin-timing — boten reagerar på att saldot
# rör sig, inte på klockan).
POLL_INTERVAL = 0.01        # hur ofta saldot läses (s) — TÄTT, för att fånga snabba
                            # vinst(UPP)→insats(NER)-sekvenser utan att missa spin
MAX_WAIT_READS = 95         # ~2,8s stiltje innan vi kollar efter avbrott (skalat mot tätare poll)
START_READ_TRIES = 60       # försök att läsa startsaldot
EPS = 0.001                 # minsta saldoändring som räknas
RELOAD_GRACE = 3.0          # paus efter omladdning så spelet hinner ladda klart

# Tillåtna insatser (kr): omsättningen kan BARA öka med ett av dessa belopp per spin (det
# är de enda insatser spelet tillåter) och ingen insats är större än 200 kr. En saldo-
# minskning snäpps till närmaste giltiga insats; den vanligaste = sessionens (konstanta)
# insats. En minskning som matchar INGEN giltig insats men är < insatsen = ett vinnande
# spin där vinsten nettats in i samma uppdatering → hela insatsen räknas ändå.
VALID_BETS = (2.5, 5.0, 7.5, 10.0, 12.5, 25.0, 40.0, 50.0, 75.0, 100.0, 125.0, 200.0)


def snap_bet(drop: float):
    """Närmaste giltiga insats om saldo-minskningen ligger nära en sådan, annars None."""
    best = min(VALID_BETS, key=lambda b: abs(b - drop))
    return best if abs(best - drop) <= max(0.5, best * 0.06) else None


# ---------------------------------------------------------------------------
# Hjälpare
# ---------------------------------------------------------------------------

def load_config() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def load_calibration() -> dict:
    if CALIB_FILE.exists():
        try:
            return json.loads(CALIB_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_calibration(calib: dict) -> None:
    CALIB_FILE.write_text(json.dumps(calib, indent=2), encoding="utf-8")


async def ainput(prompt: str = "") -> str:
    """Läs en rad från stdin utan att blockera event-loopen."""
    if prompt:
        print(prompt, end="", flush=True)
    loop = asyncio.get_event_loop()
    line = await loop.run_in_executor(None, sys.stdin.readline)
    return line.rstrip("\n")


def parse_amount(text: str) -> float | None:
    """
    Plocka ut ett belopp ur en textsträng. Hanterar svenskt format
    ("1 234,56 kr"), engelskt ("1,234.56") och rena heltal ("800").
    """
    if not text:
        return None
    t = text.replace(" ", " ").replace(" ", " ").replace(" ", " ")
    candidates = re.findall(r"\d[\d\s.,]*\d|\d", t)
    if not candidates:
        return None
    cand = max(candidates, key=len).strip().replace(" ", "")

    if "," in cand and "." in cand:
        # Vilket tecken kommer sist = decimaltecken
        if cand.rfind(",") > cand.rfind("."):
            cand = cand.replace(".", "").replace(",", ".")
        else:
            cand = cand.replace(",", "")
    elif "," in cand:
        parts = cand.split(",")
        # Sista gruppen 1–2 siffror => decimaltecken, annars tusentalsavgränsare
        if len(parts) > 1 and len(parts[-1]) in (1, 2):
            cand = "".join(parts[:-1]) + "." + parts[-1]
        else:
            cand = cand.replace(",", "")
    elif "." in cand:
        parts = cand.split(".")
        if len(parts) > 1 and len(parts[-1]) in (1, 2) and len(parts) == 2:
            pass  # redan "1234.56"
        else:
            cand = cand.replace(".", "")

    try:
        return float(cand)
    except ValueError:
        return None


def parse_turnover(text: str):
    """Ur t.ex. 'Din omsättning: 39 392,50 kr / 80 000,00 kr' → (39392.5, 80000.0).
    Returnerar (current, target|None). target = None om ingen '/' finns."""
    if not text:
        return None, None
    if "/" in text:
        left, right = text.rsplit("/", 1)
        return parse_amount(left), parse_amount(right)
    return parse_amount(text), None


_READ_BALANCE_JS = """
([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return '__NONE__';
  if (el.tagName === 'IFRAME') return '__IFRAME__';
  return (el.innerText || el.textContent || '').trim();
}
"""


def _frame_depth(frame) -> int:
    """Hur djupt nästlad en ram är (0 = huvudramen)."""
    d, f = 0, frame
    while f.parent_frame is not None:
        d += 1
        f = f.parent_frame
    return d


async def _frame_rect(frame):
    """(vänster, topp, bredd, höjd) för ramens dokument i HUVUDFÖNSTRETS koordinater.
    Huvudramen → (0, 0, None, None) (obegränsad). None om positionen ej kan läsas.
    bounding_box() är redan relativ huvudfönstret, så nästling hanteras automatiskt."""
    if frame.parent_frame is None:
        return (0.0, 0.0, None, None)
    try:
        fe = await frame.frame_element()
        box = await fe.bounding_box()
    except Exception:
        return None
    if not box:
        return None
    return (box["x"], box["y"], box["width"], box["height"])


async def _read_balance_in_frame(frame, x: float, y: float) -> float | None:
    """Läs ett belopp vid huvudfönster-punkten (x, y) inuti EN ram (punkten räknas om
    till ramens egna koordinater). None om punkten ligger utanför ramen / ej ger ett tal."""
    rect = await _frame_rect(frame)
    if rect is None:
        return None
    ox, oy, w, h = rect
    rx, ry = x - ox, y - oy
    if rx < 0 or ry < 0:
        return None
    if w is not None and (rx > w or ry > h):
        return None
    try:
        txt = await frame.evaluate(_READ_BALANCE_JS, [rx, ry])
    except Exception:
        return None
    if not txt or txt in ("__NONE__", "__IFRAME__"):
        return None
    return parse_amount(txt)


# Cache: vilken ram som senast gav saldot för en viss flik. Casinospelet ligger i en
# iframe — onödigt att skanna alla ramar varje avläsning när rätt ram väl hittats.
_balance_frame_cache: dict = {}


async def read_balance(page: Page, x: float, y: float) -> float | None:
    """Läs saldot vid punkten (x, y) i huvudfönstrets koordinater. Letar i
    huvuddokumentet OCH i alla iframes — casinospelet (och därmed SALDO/SPIN) ligger
    nästan alltid i en iframe, och elementFromPoint i toppdokumentet ser då bara
    iframe-elementet, inte texten inuti. Djupaste ramen som täcker punkten vinner."""
    # När rätt ram (där saldot ligger) väl hittats LÅSES den: därefter läses ENDAST den
    # ramen vid exakt din kalibrerade punkt — aldrig några andra ramar/overlays. Det
    # hindrar att t.ex. en free spins-overlay eller en annan ruta råkar läsas i stället
    # för saldot. Ger ramen inget tal just nu → returnera None (skanna INTE andra ramar).
    cached = _balance_frame_cache.get(id(page))
    if cached is not None and cached in page.frames:
        return await _read_balance_in_frame(cached, x, y)

    # Ingen (giltig) låst ram ännu — vid start/efter omladdning. Hitta den ram vars exakta
    # punkt ger ett tal, lås den, och läs bara den hädanefter.
    best_amt, best_depth, best_frame = None, -1, None
    for frame in page.frames:
        amt = await _read_balance_in_frame(frame, x, y)
        if amt is None:
            continue
        depth = _frame_depth(frame)
        if depth > best_depth:
            best_amt, best_depth, best_frame = amt, depth, frame
    if best_frame is not None:
        _balance_frame_cache[id(page)] = best_frame
    return best_amt


# Läs casinots egna omsättnings-text (HTML) var som helst i DOM:en. Tar förälderns
# textContent (label + värde) och kräver minst ett tal. textContent läser ÄVEN dolda
# element → panelen behöver inte vara öppen. < 160 tecken = undvik stora wrappers.
_READ_TURNOVER_JS = r"""
(keywords) => {
  const kws = keywords.map(k => k.toLowerCase());
  let best = null, bestScore = -1;
  for (const el of document.querySelectorAll('body *')) {
    const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!full || full.length > 160) continue;
    const fl = full.toLowerCase();
    if (!kws.some(k => fl.includes(k))) continue;
    if (!/\d/.test(full)) continue;
    // Poäng: 'X / Y'-format väger tyngst (riktig progress), sedan kortast text.
    const score = (full.includes('/') ? 1000 : 0) + (160 - full.length);
    if (score > bestScore) { bestScore = score; best = full; }
  }
  return best;
}
"""

# Cache: ramen som senast gav omsättningen (slipp skanna alla ramar varje gång).
_turnover_frame_cache: dict = {}


async def read_turnover(page: Page, keywords: list[str]):
    """Läs (current, target) ur casinots omsättnings-text någonstans i DOM:en — i alla
    ramar och även i dolda element (textContent), så offerts-panelen inte behöver vara
    öppen. None,None om inget hittas."""
    cached = _turnover_frame_cache.get(id(page))
    order = ([cached] if cached is not None else []) + [f for f in page.frames if f is not cached]
    for frame in order:
        try:
            txt = await frame.evaluate(_READ_TURNOVER_JS, list(keywords))
        except Exception:
            continue
        if txt:
            cur, tgt = parse_turnover(txt)
            if cur is not None:
                _turnover_frame_cache[id(page)] = frame
                return cur, tgt
    return None, None


_CAPTURE_CLICK_JS = """
(label) => new Promise((resolve) => {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.18);cursor:crosshair;';
  const tip = document.createElement('div');
  tip.textContent = label;
  tip.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);'
    + 'background:#111;color:#fff;padding:10px 18px;border-radius:10px;'
    + 'font:600 14px/1.3 -apple-system,sans-serif;z-index:2147483647;box-shadow:0 6px 24px rgba(0,0,0,.4);';
  const done = (e) => {
    e.preventDefault(); e.stopPropagation();
    const x = e.clientX, y = e.clientY;
    ov.remove(); tip.remove();
    resolve({ x, y });
  };
  ov.addEventListener('click', done, { once: true, capture: true });
  document.body.appendChild(ov);
  document.body.appendChild(tip);
})
"""


async def capture_click(page: Page, label: str) -> dict:
    await page.bring_to_front()
    return await page.evaluate(_CAPTURE_CLICK_JS, label)


# Hittar en synlig knapp vars text matchar någon av targets (gemener).
# Returnerar minsta träffen = själva knappen, inte en wrapper-ruta.
_FIND_BUTTON_JS = """
(targets) => {
  const matches = [];
  const all = document.querySelectorAll(
    'button,[role="button"],a,input[type="button"],input[type="submit"],div,span,p,h1,h2,h3'
  );
  for (const el of all) {
    const raw = el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
    const t = raw.trim().toLowerCase();
    if (!targets.includes(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    matches.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, area: r.width * r.height, text: t });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.area - b.area);
  const m = matches[0];
  return { x: m.x, y: m.y, text: m.text };
}
"""


async def find_button(page: Page, texts: list[str]) -> dict | None:
    """Hittar en synlig knapp vars text EXAKT matchar (skiftlägesokänsligt) någon av texts —
    i topp-dokumentet ELLER i någon (även cross-origin) iframe. Free-spin-knappen "STARTA
    GRATISSPINN" ritas inne i SPELETS iframe, så topp-dok-sökning hittar den inte. Använder
    Playwright-locator + bounding_box → KORREKTA huvudfönster-koordinater (hanterar iframe-
    offset + ev. skalning), som anroparen klickar med page.mouse.click. Returnerar första
    synliga träffens mitt {x, y, text}. Exakt (^...$) matchning → inga felträffar på 'start' m.m."""
    if not texts:
        return None
    pats = [(re.compile(r"^" + re.escape(t.lower()) + r"$", re.I), t.lower()) for t in texts]
    for frame in page.frames:
        for pat, t in pats:
            try:
                loc = frame.get_by_text(pat)
                if await loc.count() == 0:
                    continue
                el = loc.first
                if not await el.is_visible():
                    continue
                box = await el.bounding_box()
            except Exception:
                continue
            if box and box["width"] > 0 and box["height"] > 0:
                return {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2, "text": t}
    return None


# Hittar "förstår"-rutan i 1h-kontrollen. Letar efter texten ("jag förstår" m.m.)
# och därefter en checkbox bredvid den. Returnerar rutan att klicka i — eller
# själva texten om ingen checkbox finns intill. None om ingen sådan ruta visas.
_FIND_ACK_JS = """
(ackTexts) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    return r;
  };
  let labelRect = null;
  for (const el of document.querySelectorAll('label,span,div,p,button,a,[role="checkbox"]')) {
    const t = (el.textContent || '').trim().toLowerCase();
    if (!ackTexts.includes(t)) continue;
    const r = vis(el);
    if (!r) continue;
    if (!labelRect || r.width * r.height < labelRect.width * labelRect.height) labelRect = r;
  }
  if (!labelRect) return null;
  const lx = labelRect.left + labelRect.width / 2;
  const ly = labelRect.top + labelRect.height / 2;
  let best = null, bestD = 1e9;
  for (const cb of document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) {
    const r = vis(cb);
    if (!r) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = Math.hypot(cx - lx, cy - ly);
    if (d < bestD && d < 320) { bestD = d; best = { x: cx, y: cy }; }
  }
  if (best) return { x: best.x, y: best.y, kind: 'checkbox' };
  return { x: lx, y: ly, kind: 'label' };
}
"""


async def find_ack_box(page: Page, ack_texts: list[str]) -> dict | None:
    """Letar i huvuddokumentet OCH alla iframes. Koordinater returneras i
    huvudfönstrets system (ramens offset adderad)."""
    if not ack_texts:
        return None
    lowered = [t.lower() for t in ack_texts]
    for frame in page.frames:
        rect = await _frame_rect(frame)
        if rect is None:
            continue
        ox, oy = rect[0], rect[1]
        try:
            res = await frame.evaluate(_FIND_ACK_JS, lowered)
        except Exception:
            continue
        if res:
            return {"x": res["x"] + ox, "y": res["y"] + oy, "kind": res["kind"]}
    return None


async def reload_and_wait(page: Page, label: str, bx: float, by: float, prev: float) -> float:
    """Laddar om sidan och väntar tills saldot går att läsa igen."""
    try:
        await page.reload(wait_until="domcontentloaded", timeout=60000)
    except Exception as e:  # noqa: BLE001
        print(f"[{label}] ⚠ Kunde inte ladda om sidan: {e}")
    await asyncio.sleep(RELOAD_GRACE)
    for _ in range(START_READ_TRIES * 3):
        b = await read_balance(page, bx, by)
        if b is not None:
            print(f"[{label}] Omladdad. Fortsätter spinna (saldo {b:.2f}).")
            return b
        await asyncio.sleep(POLL_INTERVAL)
    print(f"[{label}] ⚠ Kunde inte läsa saldot efter omladdning — fortsätter ändå.")
    return prev


# Hittar matchande knapp och returnerar den KLICKBARA förälder-noden (inte bara den
# innersta text-etiketten — den har ofta inget klick-handtag). Två pass: EXAKT träff först
# (specifika knappar vinner, inga falska delsträngs-träffar), sedan delsträng för >=5 tecken.
_FIND_BUTTON_EL_JS = """
(targets) => {
  const SEL = 'button,[role="button"],a,input[type="button"],input[type="submit"],div,span,p,h1,h2,h3';
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return true;
  };
  const clickable = (el) => {
    const c = el.closest('button,[role="button"],a,input,[onclick]');
    if (c) return c;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.cursor === 'pointer' || n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') return n;
    }
    return el;
  };
  for (const exactOnly of [true, false]) {
    let best = null, bestArea = Infinity;
    for (const el of document.querySelectorAll(SEL)) {
      const raw = el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 40) continue;
      const hit = exactOnly
        ? targets.some(tg => t === tg)
        : targets.some(tg => tg.length >= 5 && t.includes(tg));
      if (!hit || !vis(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = el; }
    }
    if (best) return clickable(best);
  }
  return null;
}
"""

# Predikat: är knappen BORTA nu? (Används för att verifiera att klicket faktiskt gjorde något.)
_GONE_JS = (
    "e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); "
    "return !(r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden' "
    "&& parseFloat(s.opacity||'1')>0); }"
)

# Skickar en FULL pointer+mus-sekvens (pointerdown/up + click) på elementet och 2-3 föräldrar.
# PixiJS/slot-spel lyssnar på pointerdown/pointerup — INTE bara 'click' — så ett vanligt klick
# på en text-etikett gör inget. Detta träffar rätt händelsetyper på rätt element.
_DISPATCH_POINTER_JS = """
(el) => {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  const mk = (type, C) => new C(type, {bubbles:true, cancelable:true, composed:true, view:window,
    clientX:cx, clientY:cy, button:0, buttons:1, pointerId:1, pointerType:'mouse', isPrimary:true});
  const chain = []; for (let n=el; n && chain.length<4; n=n.parentElement) chain.push(n);
  for (const t of chain) { try {
    t.dispatchEvent(mk('pointerover',PointerEvent)); t.dispatchEvent(mk('pointerenter',PointerEvent));
    t.dispatchEvent(mk('pointerdown',PointerEvent)); t.dispatchEvent(mk('mousedown',MouseEvent));
    t.dispatchEvent(mk('pointerup',PointerEvent));   t.dispatchEvent(mk('mouseup',MouseEvent));
    t.dispatchEvent(mk('click',MouseEvent));
  } catch(e){} }
  return true;
}
"""


async def click_button_robust(page: Page, texts: list[str]):
    """Hittar den KLICKBARA knappen i den DJUPASTE ramen först och klickar den med
    UPPTRAPPNING: Playwright-klick → force-klick → full pointer-sekvens på element + föräldrar
    (PixiJS behöver pointerdown/up). Efter varje försök VERIFIERAS att knappen försvann —
    annars trappas det upp. Returnerar texten BARA om knappen faktiskt försvann (= klicket
    gjorde något), annars None. Hindrar 'rapporterar klick men inget händer'-loopen."""
    lowered = [t.lower() for t in texts if t]
    frames = sorted(page.frames, key=_frame_depth, reverse=True)  # djupaste (spelets iframe) först
    for frame in frames:
        try:
            handle = await frame.evaluate_handle(_FIND_BUTTON_EL_JS, lowered)
        except Exception:
            continue
        try:
            el = handle.as_element()
            if el is None:
                continue
            try:
                txt = await el.evaluate("e => (e.value || e.textContent || '').trim().slice(0, 30)")
            except Exception:
                txt = "?"

            async def landed() -> bool:
                await page.wait_for_timeout(250)
                try:
                    return await el.evaluate(_GONE_JS)  # True = knappen försvann = klicket tog
                except Exception:
                    return True  # elementet detached = sidan ändrades = lyckat

            # Knappens mittpunkt i huvudfönstret (Playwright räknar ut rätt läge själv —
            # ingen egen offset-matte). Ett TRUSTED mus-klick på pixeln träffar det som
            # ligger ÖVERST där; för PixiJS-spel är det spelets <canvas>, som FAKTISKT
            # startar free spins (DOM-etiketten ovanpå har inget klick-handtag).
            try:
                box = await el.bounding_box()
            except Exception:
                box = None

            async def mouse_pixel_click():
                if not box:
                    raise RuntimeError("ingen box")
                cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                await page.mouse.move(cx, cy)
                await page.mouse.down()
                await page.wait_for_timeout(60)
                await page.mouse.up()

            attempts = (
                mouse_pixel_click,                          # trusted klick på pixeln → träffar canvas
                lambda: el.evaluate(_DISPATCH_POINTER_JS),  # JS pointer-sekvens på element + föräldrar
                lambda: el.click(timeout=800),              # vanligt Playwright-klick (riktiga DOM-knappar)
            )
            for attempt in attempts:
                try:
                    await attempt()
                except Exception as e:  # noqa: BLE001
                    print(f"  (klick-försök kastade: {type(e).__name__})")
                    continue
                if await landed():
                    return txt or "?"
        finally:
            try:
                await handle.dispose()
            except Exception:
                pass
    return None


async def handle_interruption(
    page: Page,
    label: str,
    bx: float,
    by: float,
    prev: float,
    continue_texts: list[str],
    reload_texts: list[str],
    ack_texts: list[str],
) -> tuple[bool, float]:
    """
    Hanterar avbrott när saldot står stilla:
      • Free-spin-knappar ("STARTA GRATISSPINN", Start/Samla/Fortsätt) → klickas via
        Playwright (trusted element-klick — träffsäkert).
      • 1h-kontrollen → kryssa FÖRST i "förstår"-rutan, klicka SEDAN Fortsätt.
      • Fel-/OK-popup → klicka OK + ladda om sidan.
    Returnerar (hanterade_något, nytt_saldo).
    """
    # 1) Fortsätt-/free spin-knappar (inkl. "STARTA GRATISSPINN")
    pos = await find_button(page, continue_texts)
    if pos:
        # Om en "förstår"-ruta finns (1h-kontrollen) måste den kryssas i FÖRST,
        # annars är Fortsätt-knappen ofta inaktiv.
        ack = await find_ack_box(page, ack_texts)
        if ack:
            print(f"[{label}] 1h-kontroll — kryssar i \"förstår\"-rutan först.")
            try:
                await page.mouse.click(ack["x"], ack["y"])
            except Exception:
                pass
            await asyncio.sleep(0.3)
            pos = await find_button(page, continue_texts) or pos

        print(f"[{label}] Klickar \"{pos['text']}\".")
        try:
            await page.mouse.click(pos["x"], pos["y"])
        except Exception:
            pass
        await asyncio.sleep(0.6)
        b = await read_balance(page, bx, by)
        return True, (b if b is not None else prev)

    # 2) OK-/fel-popup — klicka OK och ladda om
    pos = await find_button(page, reload_texts)
    if pos:
        print(f"[{label}] Popup upptäckt — klickar \"{pos['text']}\" och laddar om sidan.")
        try:
            await page.mouse.click(pos["x"], pos["y"])
        except Exception:
            pass
        await asyncio.sleep(0.4)
        return True, await reload_and_wait(page, label, bx, by, prev)

    return False, prev


# ---------------------------------------------------------------------------
# Spin-loop per sida
# ---------------------------------------------------------------------------

TURNOVER_POLL = 0.25       # hur ofta omsättningen läses (s) — uppdateras långsammare än saldo
TURNOVER_TRIES = 28        # ~7s att vänta på att omsättningen ökar efter ett spin


async def run_site_turnover(
    page: Page,
    site: dict,
    calib: dict,
    state: dict,
    control: dict,
    keywords: list[str],
    continue_texts: list[str],
    reload_texts: list[str],
    ack_texts: list[str],
) -> None:
    """Omsättnings-läge: läser casinots egna omsättnings-text (HTML) istället för saldot
    (som ritas på en canvas och inte går att läsa). Klickar spin tills omsättningen når
    målet. Free spins/vinster sköts av casinot själv — vi läser bara dess siffra."""
    label = site["label"]
    target = float(site["target"])
    sx, sy = calib["spin"]
    state[site["key"]] = 0.0

    cur = casino_target = None
    for _ in range(START_READ_TRIES * 2):
        cur, casino_target = await read_turnover(page, keywords)
        if cur is not None:
            break
        await asyncio.sleep(POLL_INTERVAL)
    if cur is None:
        print(f"[{label}] ⚠ Kunde inte läsa omsättningen (sökord: {', '.join(keywords)}) i DOM. "
              f"Kör Diagnos.command och skicka utskriften. Hoppar över.")
        return
    if casino_target and casino_target > 0:
        target = casino_target  # använd casinots eget mål om det visas
    start = cur
    print(f"[{label}] Start. Omsättning {cur:.0f}/{target:.0f} kr (läst direkt från sidan).")

    idle = 0
    while cur < target:
        while control.get("paused"):
            await asyncio.sleep(0.2)

        try:
            await page.mouse.click(sx, sy)
        except Exception as e:  # noqa: BLE001
            print(f"[{label}] ⚠ Kunde inte klicka spin: {e}")
            break

        progressed = False
        for _ in range(TURNOVER_TRIES):
            await asyncio.sleep(TURNOVER_POLL)
            new, ct = await read_turnover(page, keywords)
            if ct and ct > 0:
                target = ct
            if new is not None and new > cur + EPS:
                cur = new
                state[site["key"]] = cur - start
                print(f"[{label}] omsättning {cur:.0f}/{target:.0f} kr  (+{cur - start:.0f} sedan start)")
                progressed = True
                idle = 0
                break

        if progressed:
            continue

        # Free spins / popup klickas händelsestyrt av MutationObservern direkt i sidan.
        # handle_interruption är bara en backup om något missades (t.ex. en fel-popup som
        # kräver omladdning av sidan, vilket observern inte gör).
        handled, _ = await handle_interruption(
            page, label, 0, 0, 0, continue_texts, reload_texts, ack_texts
        )
        if handled:
            idle = 0
            continue
        idle += 1
        if idle % 20 == 0:
            print(f"[{label}] (klickar… omsättningen rör sig inte — slut på saldo, popup, "
                  f"eller fel spin-kalibrering?)")

    print(f"[{label}] ✓ KLAR — omsättning {cur:.0f} kr (mål {target:.0f}).")


async def read_baseline(page: Page, label: str, keywords: list[str], control: dict):
    """Läs casinots VERKLIGA omsättning (current, target) som STARTVÄRDE — exakt den
    inringade 'Din omsättning: X / Y'. Försöker tätt i ~5 s; hittas den inte FORTSÄTTER
    boten försöka (var 0,25 s) tills offerts-panelen öppnats så siffran finns i sidan.
    Returnerar (current, target) — eller (None, None) om boten stoppas under tiden."""
    tries = 0
    reminded = False
    while not control.get("stop"):
        cur, tgt = await read_turnover(page, keywords)
        if cur is not None:
            return cur, tgt
        tries += 1
        if tries >= 20 and not reminded:  # ~5 s utan träff → påminn en gång
            print(f"[{label}] ⚠ Hittar inte omsättningen ännu — ÖPPNA offerts-panelen "
                  f"(gåvo-ikonen uppe till höger) så 'Din omsättning' syns. Försöker vidare…")
            reminded = True
        await asyncio.sleep(0.25)
    return None, None


async def run_site(
    page: Page,
    site: dict,
    calib: dict,
    state: dict,
    continue_texts: list[str],
    reload_texts: list[str],
    ack_texts: list[str],
    control: dict,
) -> None:
    label = site["label"]
    target = float(site["target"])
    sx, sy = calib["spin"]
    bx, by = calib["balance"]
    # Största rimliga insats per spin. En "minskning" större än detta = felavläsning
    # (t.ex. under free spins flyttar layouten sig och punkten hamnar på en annan siffra
    # som VINST/VINSTSUMMA) → den räknas INTE. Justera "max_bet" i sites.json vid behov.
    max_wager = float(site.get("max_bet", 210.0))  # >200 kr finns inga insatser → felavläsning

    # Läs casinots VERKLIGA omsättning EN gång som STARTVÄRDE — exakt den inringade
    # "Din omsättning: X / Y". Tar ~5 s; hittas den inte fortsätter boten försöka tills
    # offerts-panelen öppnats. När den lästs (även om den är 0/X) körs allt som vanligt:
    # saldo-minskningar adderas ovanpå startvärdet, och boten stannar vid casinots mål (Y).
    kw = site.get("turnover_keywords") or ["omsättning"]
    base_cur, base_target = await read_baseline(page, label, kw, control)
    if base_cur is None:
        return  # boten stoppades innan omsättningen kunde läsas
    if base_target and base_target > 0:
        target = float(base_target)
    turnover = float(base_cur)
    state[site["key"]] = turnover
    print(f"[{label}] ✓ Läste omsättning {turnover:.2f}/{target:.2f} kr — kör som vanligt nu.")

    # Läs startsaldo (försök en stund ifall sidan inte är klar)
    prev = None
    for _ in range(START_READ_TRIES):
        prev = await read_balance(page, bx, by)
        if prev is not None:
            break
        await asyncio.sleep(POLL_INTERVAL)
    if prev is None:
        try:
            info = await page.main_frame.evaluate(
                "([x,y])=>{const e=document.elementFromPoint(x,y);"
                "return e?(e.tagName+' \"'+((e.innerText||'').trim().slice(0,40))+'\"'):'inget element';}",
                [bx, by],
            )
        except Exception:
            info = "?"
        print(f"[{label}] ⚠ Kunde inte läsa saldot vid ({bx:.0f},{by:.0f}). "
              f"Toppdokument där: {info}. Antal ramar: {len(page.frames)}. "
              f"Kör om med  --recalibrate  och klicka mitt på saldo-siffran om det kvarstår. Hoppar över.")
        return

    print(f"[{label}] Start. Saldo {prev:.2f}. Mål {target:.0f} kr.")
    spins = 0
    idle_clicks = 0
    bet = None           # sessionens (konstanta) insats — låses till den vanligaste giltiga
    bet_votes = {}       # röster per giltig insats (snäppt saldo-minskning)

    while turnover < target:
        # Paus: vänta här (utan att klicka) så länge användaren har pausat med €.
        while control.get("paused"):
            await asyncio.sleep(0.2)

        # Säkerhets-ankare: saldo-räkningen nedan DRIVER siffran (jämnt per spin), men läs
        # även casinots egna "Din omsättning" — ligger den HÖGRE har vi missat ett spin →
        # synka UPP (aldrig ner). Så totalen blir aldrig fel även om en avläsning missas.
        syn_cur, syn_tgt = await read_turnover(page, kw)
        if syn_cur is not None:
            if syn_tgt and syn_tgt > 0:
                target = float(syn_tgt)
            if syn_cur > turnover + EPS:
                turnover = syn_cur
                state[site["key"]] = turnover
            if turnover >= target:
                break

        # Klicka på spin-knappen. Ett klick är inte ett spin — det räknas först
        # när saldot faktiskt minskar.
        try:
            await page.mouse.click(sx, sy)
        except Exception as e:  # noqa: BLE001
            print(f"[{label}] ⚠ Kunde inte klicka spin: {e}")
            break

        # Läs saldot MYCKET tätt tills det ändras. En vinst krediteras (saldo UPP) och
        # nästa insats dras (saldo NER) snabbt efter varann — läser vi för sällan ser de
        # ut som ingen ändring och spinet missas. Vid en ÖKNING uppdaterar vi prev (toppen)
        # och bryter (klickar nästa) så nästa minskning mäts från rätt nivå. Läs FÖRST,
        # sov bara när inget hänt — så fångas ändringen direkt.
        changed = False
        misread_warned = False
        for _ in range(MAX_WAIT_READS):
            cur = await read_balance(page, bx, by)
            if cur is None:
                await asyncio.sleep(POLL_INTERVAL)
                continue
            if abs(cur - prev) <= EPS:
                await asyncio.sleep(POLL_INTERVAL)
                continue
            if cur < prev:  # saldot minskade => insatsen dragen => ETT spin
                drop = prev - cur
                if drop > max_wager:
                    # Orimligt stor minskning (t.ex. 1838 → 59) = felavläsning, INTE ett spin.
                    # Ignorera, behåll prev (så nästa jämförelse blir rätt), räkna inte.
                    if not misread_warned:
                        print(f"[{label}] ⚠ ignorerar orimlig saldo-minskning "
                              f"({prev:.0f}→{cur:.0f}, {drop:.0f} kr) — trolig felavläsning "
                              f"(free spins/layoutbyte).")
                        misread_warned = True
                    await asyncio.sleep(POLL_INTERVAL)
                    continue
                # Omsättningen kan bara öka med en GILTIG insats (VALID_BETS, ≤200 kr).
                # Snäpp minskningen till närmaste giltiga insats:
                snapped = snap_bet(drop)
                add = None
                if snapped is not None:
                    bet_votes[snapped] = bet_votes.get(snapped, 0) + 1
                    bet = max(bet_votes, key=bet_votes.get)  # vanligaste = sessionens insats
                    add = snapped
                elif bet is not None and EPS < drop < bet:
                    add = bet  # vinnande spin: netto < insats → räkna ändå HELA insatsen
                if add is not None:
                    spins += 1
                    turnover += add
                    state[site["key"]] = turnover
                    pct = min(100.0, turnover / target * 100.0)
                    print(f"[{label}] omsättning {turnover:.2f}/{target:.2f} kr "
                          f"({pct:.0f}%) · spin {spins} · insats {add:.2f} · saldo {cur:.2f}")
                # add is None → minskningen matchar ingen giltig insats → räkna inte spinet
                # (casino-ankaret synkar upp om ett spin ändå missats).
            changed = True
            prev = cur
            break

        if changed:
            idle_clicks = 0
            continue

        # Inget rörde sig. Det beror oftast på ett avbrott: free-spin-knapp,
        # "Fortsätt spela"-rutan efter 1h, eller en fel-popup. Hantera det.
        handled, prev = await handle_interruption(
            page, label, bx, by, prev, continue_texts, reload_texts, ack_texts
        )
        if handled:
            idle_clicks = 0
            continue

        # Inget avbrott hittades — klicka bara igen. Säg till då och då.
        idle_clicks += 1
        if idle_clicks % 25 == 0:
            print(f"[{label}] (klickar… saldot har inte ändrats på ett tag — "
                  f"slut på saldo eller fel kalibrering?)")

    print(f"[{label}] ✓ KLAR — omsättning {turnover:.2f} kr (mål {target:.2f}). Spins: {spins}.")


# ---------------------------------------------------------------------------
# Orkestrering
# ---------------------------------------------------------------------------

DEFAULT_CONTINUE_BUTTONS = [
    "starta gratisspinn", "starta gratisspin", "starta gratis spinn", "gratisspinn",
    "gratisspin", "starta free spins", "free spins", "fortsätt spela", "fortsätt",
    "spela vidare", "ja, fortsätt", "ja tack", "ja", "fortsätt session", "continue",
    "start", "starta", "samla in", "samla", "collect", "stäng", "close",
]
DEFAULT_RELOAD_BUTTONS = ["ok", "okej", "ok!", "ok."]
DEFAULT_ACK_BUTTONS = [
    "jag förstår", "förstår", "jag har förstått", "förstått",
    "jag är medveten", "i understand", "understood",
]

# Händelsestyrd auto-klickare som injiceras i varje ram via context.add_init_script.
# En MutationObserver bevakar DOM:en och klickar en matchande knapp (free spins/Fortsätt/OK)
# i samma stund den dyker upp. __TARGETS__ ersätts med en JSON-lista av knapptexter (gemener).
# Throttlad (max var 200 ms) + ett 1 s backup-svep. Klickar BARA knappar (inte spin).
AUTO_CLICK_JS = """
(() => {
  if (window.__oddexusAuto) return; window.__oddexusAuto = true;
  const TG = __TARGETS__;
  let last = 0;
  const scan = () => {
    const now = Date.now(); if (now - last < 200) return; last = now;
    const els = document.querySelectorAll(
      'button,[role="button"],a,input[type="button"],input[type="submit"],div,span,p,h1,h2,h3'
    );
    for (const el of els) {
      const raw = el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
      const t = raw.trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (!TG.some(g => t === g || (g.length >= 5 && t.includes(g)))) continue;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden'
          || s.display === 'none' || parseFloat(s.opacity || '1') === 0) continue;
      // Klicka den KLICKBARA föräldern med en full pointer-sekvens (PixiJS lyssnar på
      // pointerdown/pointerup, inte bara 'click'; text-etiketten saknar ofta handtag).
      const target = el.closest('button,[role="button"],a,input,[onclick]') || el;
      const br = target.getBoundingClientRect();
      const cx = br.left + br.width/2, cy = br.top + br.height/2;
      const mk = (type, C) => new C(type, {bubbles:true, cancelable:true, composed:true, view:window,
        clientX:cx, clientY:cy, button:0, buttons:1, pointerId:1, pointerType:'mouse', isPrimary:true});
      const chain = []; for (let n=target; n && chain.length<4; n=n.parentElement) chain.push(n);
      for (const c of chain) { try {
        c.dispatchEvent(mk('pointerover',PointerEvent)); c.dispatchEvent(mk('pointerdown',PointerEvent));
        c.dispatchEvent(mk('mousedown',MouseEvent)); c.dispatchEvent(mk('pointerup',PointerEvent));
        c.dispatchEvent(mk('mouseup',MouseEvent)); c.dispatchEvent(mk('click',MouseEvent));
      } catch(e){} }
      return;
    }
  };
  const obs = new MutationObserver(scan);
  const go = () => { try { obs.observe(document.documentElement || document, {childList: true, subtree: true}); scan(); } catch (e) {} };
  if (document.documentElement) go(); else addEventListener('DOMContentLoaded', go);
  setInterval(scan, 1000);
})();
"""


# ---------------------------------------------------------------------------
# Håll datorn + skärmen vaken under körningen (macOS: caffeinate) så den inte
# slocknar/går i viloläge medan boten spinnar.
# ---------------------------------------------------------------------------

_caffeinate_proc = None


def _keep_awake_start() -> None:
    """Starta caffeinate (macOS) som hindrar skärm-/idle-/disk-/systemsömn. '-w <pid>'
    gör att den dör automatiskt när boten avslutas, även vid krasch."""
    global _caffeinate_proc
    if sys.platform != "darwin":
        return  # caffeinate finns bara på macOS
    try:
        _caffeinate_proc = subprocess.Popen(
            ["caffeinate", "-dims", "-w", str(os.getpid())],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("☕ Håller datorn + skärmen vaken under körningen.")
    except Exception:
        _caffeinate_proc = None


def _keep_awake_stop() -> None:
    global _caffeinate_proc
    if _caffeinate_proc is not None:
        try:
            _caffeinate_proc.terminate()
        except Exception:
            pass
        _caffeinate_proc = None


atexit.register(_keep_awake_stop)


# ---------------------------------------------------------------------------
# Tangentstyrning: € som ETT tangenttryck (ingen ENTER). Första € = starta,
# nästa € = pausa, nästa = fortsätt. Läses i en bakgrundstråd.
# ---------------------------------------------------------------------------

_TERMIOS_OLD = None


def _restore_terminal() -> None:
    """Återställ terminalen från cbreak-läge (annars beter den sig konstigt efteråt)."""
    global _TERMIOS_OLD
    if _TERMIOS_OLD is not None:
        try:
            import termios
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _TERMIOS_OLD)
        except Exception:
            pass
        _TERMIOS_OLD = None


atexit.register(_restore_terminal)


def _toggle_control(control: dict) -> None:
    if not control["started"]:
        control["started"] = True
        print("\n▶  Startar…   (tryck €  för paus, €  igen för att fortsätta)")
    else:
        control["paused"] = not control["paused"]
        print("⏸  PAUSAD — tryck €  för att fortsätta."
              if control["paused"] else "▶  Fortsätter.")


def _key_listener(control: dict) -> None:
    """Bakgrundstråd som läser ENSTAKA tangenttryck (ingen ENTER). € styr start/paus."""
    if os.name == "nt":
        try:
            import msvcrt
        except Exception:
            return
        while not control["stop"]:
            if msvcrt.kbhit():
                try:
                    ch = msvcrt.getwch()
                except Exception:
                    continue
                if ch == "€":
                    _toggle_control(control)
            else:
                time.sleep(0.05)
        return

    # Unix/macOS: cbreak-läge så tangenttryck kommer direkt, utan ENTER.
    global _TERMIOS_OLD
    try:
        import termios, tty, select  # noqa: E401
    except Exception:
        return
    fd = sys.stdin.fileno()
    try:
        _TERMIOS_OLD = termios.tcgetattr(fd)
        tty.setcbreak(fd)
    except Exception:
        _TERMIOS_OLD = None
    buf = b""
    while not control["stop"]:
        try:
            r, _, _ = select.select([sys.stdin], [], [], 0.2)
        except Exception:
            break
        if not r:
            continue
        try:
            chunk = os.read(fd, 8)
        except Exception:
            break
        if not chunk:
            continue
        buf += chunk
        if len(buf) > 16:
            buf = buf[-4:]
        try:
            s = buf.decode("utf-8")
            buf = b""
        except UnicodeDecodeError:
            continue  # € är 3 byte i UTF-8 — vänta in resten om det delats upp
        if "€" in s:
            _toggle_control(control)
    _restore_terminal()


async def diagnose_site(page: Page, label: str) -> None:
    """Skriver ut DOM-struktur för felsökning: antal ramar, antal <canvas> per ram
    (slot-spel ritas ofta på en canvas → SALDO finns då inte som läsbar text, bara
    pixlar), och var text om 'omsättning' finns (synlig eller dold) — så vi vet om vi
    kan läsa casinots egna omsättning direkt istället för saldot."""
    print(f"\n===== DIAGNOS: {label} =====")
    frames = page.frames
    print(f"Antal ramar (frames): {len(frames)}")
    js = """
    () => {
      const canvases = document.querySelectorAll('canvas').length;
      const kw = ['omsättning','wager','krav','progress','/ 80','/ 60','/ 40'];
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (!t || t.length > 90) continue;
        const tl = t.toLowerCase();
        if (kw.some(k => tl.includes(k))) {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          const vis = r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
            && s.display !== 'none' && parseFloat(s.opacity || '1') > 0;
          hits.push({ text: t.slice(0, 70), vis });
          if (hits.length >= 6) break;
        }
      }
      return { canvases, hits };
    }
    """
    for i, fr in enumerate(frames):
        depth = _frame_depth(fr)
        try:
            url = (fr.url or "")[:60]
        except Exception:
            url = "?"
        try:
            info = await fr.evaluate(js)
        except Exception as e:  # noqa: BLE001
            print(f"  [ram {i}] djup={depth} (kunde ej läsas: {str(e)[:50]}) url={url}")
            continue
        print(f"  [ram {i}] djup={depth} canvas={info['canvases']} url={url}")
        for h in info["hits"]:
            print(f"       omsättnings-text: \"{h['text']}\"  synlig={h['vis']}")


async def main() -> None:
    # Svälj Playwrights kända iframe-race (ValueError: x not in list i
    # _on_frame_detached) så casinospelets iframes inte kraschar boten.
    def _ignore_frame_detach(loop, context):
        exc = context.get("exception")
        if isinstance(exc, ValueError) and "not in list" in str(exc):
            return
        loop.default_exception_handler(context)

    try:
        asyncio.get_running_loop().set_exception_handler(_ignore_frame_detach)
    except Exception:
        pass

    cfg = load_config()
    sites = cfg["sites"]
    continue_texts = cfg.get("continue_buttons", DEFAULT_CONTINUE_BUTTONS)
    reload_texts = cfg.get("reload_buttons", DEFAULT_RELOAD_BUTTONS)
    ack_texts = cfg.get("ack_buttons", DEFAULT_ACK_BUTTONS)

    print("=" * 60)
    print("  Oddexus autoclicker — 4 casinon samtidigt")
    print("=" * 60)

    # ── Licens-kontroll AVSTÄNGD ────────────────────────────────────────────────
    # Den här lokala kopian kör UTAN licensnyckel (borttagen på begäran 2026-06-29).
    # Vill du återaktivera den: lägg tillbaka importen högst upp
    #   from license_client import ensure_license
    # och avkommentera raden nedan.
    # ensure_license(cfg["license_server"], cfg.get("bot_version", "2.0.0"), LICENSE_FILE)
    print("⚙  Licens-kontroll avstängd — kör utan nyckel.\n")
    _keep_awake_start()

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            str(USER_DATA_DIR),
            headless=False,
            viewport=None,
            args=CHROME_ARGS,
        )

        # (Händelsestyrd MutationObserver-auto-klick BORTTAGEN 2026-06-30 — den var opålitlig
        # för canvas/overlay-knappar. Free-spin-knappen ("STARTA GRATISSPINN") klickas nu av
        # den BEPRÖVADE poll-baserade handle_interruption: find_button (exakt text i topp-
        # dokumentet) + page.mouse.click(x,y) — exakt samma som originalet som fungerade.)

        # Auto-acceptera inbyggda webbläsardialoger (alert/confirm) — de blockerar
        # annars allt. Verkliga popup-rutor med OK-knapp hanteras i spin-loopen.
        def _on_dialog(dialog) -> None:
            try:
                asyncio.create_task(dialog.accept())
            except Exception:
                pass

        # Öppna en flik per casino
        pages: list[Page] = []
        for i, site in enumerate(sites):
            page = context.pages[i] if i < len(context.pages) else await context.new_page()
            page.on("dialog", _on_dialog)
            try:
                await page.goto(site["url"], wait_until="domcontentloaded", timeout=60000)
            except Exception as e:  # noqa: BLE001
                print(f"[{site['label']}] Kunde inte öppna sidan direkt ({e}). Öppna den manuellt i fliken.")
            pages.append(page)

        # Tangentstyrning: € (ett tryck, ingen ENTER) startar, och pausar/fortsätter sedan.
        control = {"started": False, "paused": False, "stop": False}
        threading.Thread(target=_key_listener, args=(control,), daemon=True).start()

        print("\nLogga in på ALLA fyra sidor + öppna spelet så att SPIN + SALDO syns.")
        print("Tryck sedan  €  för att STARTA.  (€ pausar/fortsätter sedan under körningen.)")
        while not control["started"]:
            await asyncio.sleep(0.1)

        # Diagnos-läge: skanna DOM (canvas + var 'omsättning' finns) och avsluta.
        if "--diagnose" in sys.argv:
            for site, page in zip(sites, pages):
                await diagnose_site(page, site["label"])
            print("\n===== DIAGNOS KLAR — skicka en skärmdump av detta fönster. =====")
            print("Stänger om 20 sekunder.")
            try:
                await asyncio.sleep(20)
            except (KeyboardInterrupt, asyncio.CancelledError):
                pass
            await context.close()
            return

        # Kalibrering (sparas, hoppas över nästa gång om den finns)
        calib = load_calibration()
        recalibrate = "--recalibrate" in sys.argv
        for site, page in zip(sites, pages):
            key = site["key"]
            if key in calib and not recalibrate:
                print(f"[{site['label']}] Använder sparad kalibrering.")
                continue
            print(f"\n[{site['label']}] Kalibrering — klicka på SPIN-knappen i fliken.")
            spin = await capture_click(page, f"{site['label']}: klicka på SPIN-knappen")
            print(f"[{site['label']}] Klicka nu på ditt SALDO (siffran).")
            bal = await capture_click(page, f"{site['label']}: klicka på ditt SALDO")
            calib[key] = {"spin": [spin["x"], spin["y"]], "balance": [bal["x"], bal["y"]]}
            save_calibration(calib)
            print(f"[{site['label']}] ✓ Kalibrerad.")

        print("\n▶ Startar alla fyra sidor…   (tryck €  för paus/fortsätt)\n")
        state: dict = {}
        tasks = [
            asyncio.create_task(
                run_site(
                    page, site, calib[site["key"]], state,
                    continue_texts, reload_texts, ack_texts, control,
                )
            )
            for site, page in zip(sites, pages)
        ]
        await asyncio.gather(*tasks)
        control["stop"] = True

        print("\n✓ Alla sidor klara.")
        for site in sites:
            print(f"   {site['label']}: {state.get(site['key'], 0):.0f} / {site['target']} kr")
        print("\nStänger om 30 sekunder (Ctrl+C för att stänga direkt).")
        try:
            await asyncio.sleep(30)
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        await context.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAvbruten.")
    except SystemExit as e:
        print(e)
