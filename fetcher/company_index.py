"""The list the Companies page searches as you type: every listed Japanese company and every
US-listed ticker, with the ticker next to the name.

  Japan: fetcher/edinet_codes.json (the FSA's EDINET code list, refreshed weekly by edinet.py):
         securities code, Japanese and English name, industry.
  US:    the SEC's company_tickers_exchange.json: ticker, name, exchange, CIK. OTC names are left
         out to keep the file small; they are rarely what a reader is looking for.

Writes docs/data/company_index.json as compact rows. Rebuilt at most once a week. Standard
library only; runs in fetch.yml. The SEC asks for a contact in the User-Agent (SEC_USER_AGENT).
"""
import datetime as dt
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "company_index.json"
CODES = Path(__file__).parent / "edinet_codes.json"
SEC_LIST = "https://www.sec.gov/files/company_tickers_exchange.json"
MAX_AGE_DAYS = 7
US_EXCHANGES = {"NYSE", "Nasdaq", "NYSE American", "CBOE"}


def plain(name: str) -> str:
    """株式会社トヨタ -> トヨタ: the legal form only gets in the way of reading a list."""
    return re.sub(r"^(株式会社|（株）|\(株\))\s*|\s*(株式会社|（株）|\(株\))$", "", name).strip()


def japan() -> list:
    codes = json.loads(CODES.read_text(encoding="utf-8")).get("codes", {})
    rows = []
    for row in codes.values():
        ja, en, ticker = row[0], row[1], row[2]
        industry = row[3] if len(row) > 3 else ""
        if not re.fullmatch(r"\d{3}[0-9A-Z]", ticker or ""):
            continue                      # not listed: funds, private filers
        rows.append({"m": "JP", "t": ticker, "n": plain(ja), "e": en.title() if en.isupper() else en, "s": industry})
    return rows


def us() -> list:
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    if not ua:
        print("company_index: SEC_USER_AGENT not set; US tickers skipped")
        return []
    req = urllib.request.Request(SEC_LIST, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    fields = data["fields"]
    rows = []
    for rec in data["data"]:
        x = dict(zip(fields, rec))
        if x.get("exchange") not in US_EXCHANGES or not x.get("ticker"):
            continue
        rows.append({"m": "US", "t": x["ticker"], "n": x["name"], "x": x["exchange"], "c": x["cik"]})
    return rows


def main() -> int:
    if OUT.exists():
        try:
            built = json.loads(OUT.read_text(encoding="utf-8")).get("built", "2000-01-01")
            if (dt.date.today() - dt.date.fromisoformat(built)).days < MAX_AGE_DAYS:
                print(f"company_index: fresh ({built})")
                return 0
        except Exception:  # noqa: BLE001 - rebuild a file we cannot read
            pass
    rows = japan()
    try:
        rows += us()
    except Exception as e:  # noqa: BLE001 - keep the Japanese half rather than nothing
        print(f"company_index: US list failed ({str(e)[:100]})")
    OUT.write_text(json.dumps({"built": dt.date.today().isoformat(), "rows": rows},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"company_index: {sum(r['m'] == 'JP' for r in rows)} Japan, {sum(r['m'] == 'US' for r in rows)} US")
    return 0


if __name__ == "__main__":
    sys.exit(main())
