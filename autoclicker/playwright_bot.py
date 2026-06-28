#!/usr/bin/env python3
"""
Oddexus autoclicker — fyra casinon samtidigt.

Öppnar GoGo, BetMGM, LeoVegas och Expekt (Big Bad Wolf) i samma bot-Chrome,
låter dig kalibrera SPIN-knappen + ditt SALDO på varje sida, och spinnar sedan
alla fyra samtidigt tills varje sidas omsättningsmål är nått.

Omsättning mäts via saldot: för varje spin dras insatsen från saldot. Boten
läser av saldots LÄGSTA punkt direkt efter ett spin (insatsen dras innan en
ev. vinst krediteras), så även vinnande spins räknar full insats. Free spins
(ingen dragning) räknas korrekt som 0.

Allt körs lokalt på din dator. Inget skickas någonstans utom licenskontrollen.
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
import json
import re
from pathlib import Path

from playwright.async_api import Page, async_playwright

from license_client import ensure_license

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
POLL_INTERVAL = 0.05        # hur ofta saldot läses (s)
MAX_WAIT_READS = 40         # ~2s: efter så lång stiltje kollar vi efter avbrott
START_READ_TRIES = 60       # försök att läsa startsaldot
EPS = 0.001                 # minsta saldoändring som räknas
RELOAD_GRACE = 3.0          # paus efter omladdning så spelet hinner ladda klart


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


_READ_BALANCE_JS = """
([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return '';
  if (el.tagName === 'IFRAME') return '__IFRAME__';
  return (el.innerText || el.textContent || '').trim();
}
"""


async def read_balance(page: Page, x: float, y: float) -> float | None:
    try:
        txt = await page.evaluate(_READ_BALANCE_JS, [x, y])
    except Exception:
        return None
    if txt == "__IFRAME__":
        return None
    return parse_amount(txt)


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
    if not texts:
        return None
    try:
        return await page.evaluate(_FIND_BUTTON_JS, [t.lower() for t in texts])
    except Exception:
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
    if not ack_texts:
        return None
    try:
        return await page.evaluate(_FIND_ACK_JS, [t.lower() for t in ack_texts])
    except Exception:
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
      • Free-spin-knappar (t.ex. "STARTA GRATISSPIN", Start/Samla/Fortsätt)
        → klicka, INGEN omladdning.
      • 1h-kontrollen ("du har spelat …") → kryssa FÖRST i "förstår"-rutan,
        klicka SEDAN Fortsätt. INGEN omladdning.
      • Fel-/OK-popup (t.ex. "wifi har slutat") → klicka OK + ladda om sidan.
    Returnerar (hanterade_något, nytt_saldo).
    """
    # 1) Fortsätt-/free spin-knappar (inkl. "STARTA GRATISSPIN")
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
            # Fortsätt-knappen kan nu ha aktiverats/flyttats — hämta den igen.
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

async def run_site(
    page: Page,
    site: dict,
    calib: dict,
    state: dict,
    continue_texts: list[str],
    reload_texts: list[str],
    ack_texts: list[str],
) -> None:
    label = site["label"]
    target = float(site["target"])
    sx, sy = calib["spin"]
    bx, by = calib["balance"]

    turnover = 0.0
    state[site["key"]] = 0.0

    # Läs startsaldo (försök en stund ifall sidan inte är klar)
    prev = None
    for _ in range(START_READ_TRIES):
        prev = await read_balance(page, bx, by)
        if prev is not None:
            break
        await asyncio.sleep(POLL_INTERVAL)
    if prev is None:
        print(f"[{label}] ⚠ Kunde inte läsa saldot — kontrollera kalibreringen. Hoppar över.")
        return

    print(f"[{label}] Start. Saldo {prev:.2f}. Mål {target:.0f} kr.")
    spins = 0
    idle_clicks = 0

    while turnover < target:
        # Klicka på spin-knappen. Ett klick är inte ett spin — det räknas först
        # när saldot faktiskt minskar.
        try:
            await page.mouse.click(sx, sy)
        except Exception as e:  # noqa: BLE001
            print(f"[{label}] ⚠ Kunde inte klicka spin: {e}")
            break

        # Läs saldot löpande tills det ändras. Första ändringen efter klicket är
        # dragningen av insatsen (minskning); en ev. vinst syns som en ökning
        # på nästa varv och räknas inte. Ingen fast väntetid — vi reagerar på
        # att saldot rör sig.
        changed = False
        for _ in range(MAX_WAIT_READS):
            await asyncio.sleep(POLL_INTERVAL)
            cur = await read_balance(page, bx, by)
            if cur is None:
                continue
            if abs(cur - prev) <= EPS:
                continue
            changed = True
            if cur < prev:  # saldot minskade => ett spin, insatsen = minskningen
                turnover += prev - cur
                spins += 1
                state[site["key"]] = turnover
                pct = min(100.0, turnover / target * 100.0)
                print(f"[{label}] omsättning {turnover:.0f}/{target:.0f} kr "
                      f"({pct:.0f}%) · spin {spins} · saldo {cur:.2f}")
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

    print(f"[{label}] ✓ KLAR — omsättning {turnover:.0f} kr (mål {target:.0f}). Spins: {spins}.")


# ---------------------------------------------------------------------------
# Orkestrering
# ---------------------------------------------------------------------------

DEFAULT_CONTINUE_BUTTONS = [
    "starta gratisspin", "starta gratis spin", "gratisspin", "starta free spins",
    "fortsätt spela", "fortsätt", "spela vidare", "ja, fortsätt", "ja tack", "ja",
    "fortsätt session", "continue", "start", "starta", "samla in", "samla",
    "collect", "stäng", "close",
]
DEFAULT_RELOAD_BUTTONS = ["ok", "okej", "ok!", "ok."]
DEFAULT_ACK_BUTTONS = [
    "jag förstår", "förstår", "jag har förstått", "förstått",
    "jag är medveten", "i understand", "understood",
]


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

    ensure_license(cfg["license_server"], cfg.get("bot_version", "2.0.0"), LICENSE_FILE)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            str(USER_DATA_DIR),
            headless=False,
            viewport=None,
            args=CHROME_ARGS,
        )

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

        print("\nLogga in på ALLA fyra sidor i bot-Chrome och öppna spelet så att")
        print("SPIN-knappen och ditt SALDO syns. Tryck sedan ENTER här.")
        await ainput("")

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

        # Vänta på € för att starta
        print("\nKalibrering klar.")
        while True:
            line = await ainput("Tryck €  och ENTER för att starta bottarna: ")
            if "€" in line:
                break
            print("  (skriv tecknet € och tryck Enter)")

        print("\n▶ Startar alla fyra sidor…\n")
        state: dict = {}
        tasks = [
            asyncio.create_task(
                run_site(
                    page, site, calib[site["key"]], state,
                    continue_texts, reload_texts, ack_texts,
                )
            )
            for site, page in zip(sites, pages)
        ]
        await asyncio.gather(*tasks)

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
