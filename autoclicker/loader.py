#!/usr/bin/env python3
"""
Oddexus bot — KUND-version (loader).

Den här filen innehåller INGEN bot-logik. Den:
  1) loggar in på oddexus.com (samma konto du betalar med),
  2) kontrollerar att ditt medlemskap är AKTIVT denna månad,
  3) hämtar själva boten från servern och kör den i minnet.

Är du inte aktiv medlem — eller saknar internet — finns ingen bot att köra.
Att försöka ändra i den här filen är meningslöst: bot-koden finns inte lokalt.
Den skickas bara till aktiva medlemmar och körs i minnet (sparas aldrig på disk).
"""
from __future__ import annotations

import getpass
import json
from pathlib import Path
import urllib.error
import urllib.request

BASE_DIR = Path(__file__).resolve().parent
SERVER = "https://oddexus.com"
SESSION_FILE = BASE_DIR / "session.txt"   # sparar inloggningen så du slipper logga in varje gång


def _read_saved_session() -> str | None:
    try:
        v = SESSION_FILE.read_text(encoding="utf-8").strip()
        return v or None
    except Exception:
        return None


def _save_session(cookie: str) -> None:
    try:
        SESSION_FILE.write_text(cookie, encoding="utf-8")
        try:
            SESSION_FILE.chmod(0o600)
        except Exception:
            pass
    except Exception:
        pass


def _clear_session() -> None:
    try:
        SESSION_FILE.unlink()
    except Exception:
        pass


def _login() -> str | None:
    """Loggar in på oddexus.com. Returnerar pp_session-cookien, eller None vid fel."""
    print("\n=== Logga in på Oddexus ===")
    print("Använd samma användarnamn + lösenord som på oddexus.com.")
    username = input("Användarnamn/e-post: ").strip()
    password = getpass.getpass("Lösenord (syns inte när du skriver): ").strip()
    if not username or not password:
        print("✗ Tomt användarnamn eller lösenord.")
        return None
    data = json.dumps({"username": username, "password": password}).encode("utf-8")
    req = urllib.request.Request(
        f"{SERVER}/api/auth/login",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            for c in resp.headers.get_all("Set-Cookie") or []:
                if c.startswith("pp_session="):
                    return c.split(";", 1)[0]  # "pp_session=...."
        print("✗ Inloggningen gav ingen session. Försök igen.")
        return None
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403):
            print("✗ Fel användarnamn eller lösenord.")
        else:
            print(f"✗ Inloggning misslyckades (serverfel {e.code}).")
        return None
    except urllib.error.URLError as e:
        print(f"✗ Kan inte nå oddexus.com: {e.reason}")
        print("  Kontrollera din internetanslutning och försök igen.")
        raise SystemExit(1)


def _fetch_bot(cookie: str):
    """Hämtar bot-koden från servern. Returnerar (kod|None, http-status)."""
    req = urllib.request.Request(
        f"{SERVER}/api/bot/code",
        headers={"Cookie": cookie},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8"), 200
    except urllib.error.HTTPError as e:
        return None, e.code
    except urllib.error.URLError as e:
        print(f"✗ Kan inte nå oddexus.com: {e.reason}")
        print("  Kontrollera din internetanslutning och försök igen.")
        raise SystemExit(1)


def main() -> None:
    cookie = _read_saved_session()
    code = None
    for _ in range(3):
        if not cookie:
            cookie = _login()
            if not cookie:
                continue
        code, status = _fetch_bot(cookie)
        if status == 200 and code:
            _save_session(cookie)
            break
        if status == 401:
            print("Sessionen har gått ut — logga in igen.")
            _clear_session()
            cookie = None
            continue
        if status == 403:
            print("\n✗ Ditt medlemskap är inte aktivt.")
            print("  Förnya ditt medlemskap på oddexus.com och starta sedan om boten.")
            raise SystemExit(1)
        print(f"✗ Oväntat svar från servern ({status}). Försök igen om en stund.")
        raise SystemExit(1)

    if not code:
        print("\n✗ Kunde inte hämta boten. Är du aktiv medlem på oddexus.com?")
        raise SystemExit(1)

    print("✓ Medlemskap aktivt — startar boten.\n")
    # Kör bot-koden i minnet. Den sparas ALDRIG på disken. __name__/__file__ sätts så att
    # botens egen "if __name__ == '__main__'" körs och BASE_DIR pekar på den här mappen
    # (där sites.json + calibration.json ligger).
    g = {"__name__": "__main__", "__file__": str(BASE_DIR / "playwright_bot.py")}
    exec(compile(code, "oddexus_bot", "exec"), g)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAvbruten.")
