"""
Licens-klient för Oddexus autoclicker.

Validerar licensnyckeln mot servern (POST /api/bot-license) och binder den till
den här datorn (device_id). Nyckeln sparas lokalt i license.txt efter första
lyckade kontroll.
"""

from __future__ import annotations

import hashlib
import json
import platform
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def device_id() -> str:
    """Stabilt, anonymt maskin-id (samma så länge datorn är densamma)."""
    raw = f"{platform.node()}|{uuid.getnode()}|{platform.machine()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _validate(server_url: str, license_key: str, dev: str, version: str) -> dict:
    payload = json.dumps(
        {"license_key": license_key, "device_id": dev, "bot_version": version}
    ).encode("utf-8")
    req = urllib.request.Request(
        server_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "message": f"Serverfel (HTTP {e.code})"}
    except urllib.error.URLError as e:
        return {"ok": False, "message": f"Kunde inte nå licensservern: {e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": f"Oväntat fel: {e}"}


def ensure_license(server_url: str, version: str, license_file: Path) -> None:
    """
    Säkerställer en giltig licens. Frågar efter nyckel om den saknas/ogiltig.
    Kastar SystemExit om användaren avbryter.
    """
    dev = device_id()
    key = license_file.read_text(encoding="utf-8").strip() if license_file.exists() else ""

    while True:
        if not key:
            print("\nFörsta gången: klistra in din licensnyckel (eller tomt + Enter för att avbryta).")
            key = input("Licensnyckel: ").strip()
            if not key:
                raise SystemExit("Avbruten — ingen licensnyckel angiven.")

        print("Kontrollerar licens…")
        res = _validate(server_url, key, dev, version)
        if res.get("ok"):
            license_file.write_text(key, encoding="utf-8")
            exp = res.get("expires_at", "okänt")
            print(f"✓ Licens aktiv (giltig till {exp}).")
            return

        print(f"✗ Licens nekad: {res.get('message', 'okänt fel')}")
        key = ""  # fråga igen
