"""Probe for the Profile feature: what is inside an annual securities report's CSV?

Prints, for a few tickers, the element ids and context ids that carry sales, operating profit,
net profit, the major shareholders table and the "basic policy on control of the company"
text, so Code.gs is written against what is really there. Writes nothing.
Run from the edinet-probe workflow (it holds the key); PROBE_TICKERS overrides the list.
"""
import csv
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.edinet-fsa.go.jp/api/v2"
KEY = os.environ.get("EDINET_API_KEY", "")
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
TICKERS = [t for t in os.environ.get("PROBE_TICKERS", "7203,4967,4502,8058").split(",") if t]

MONEY = re.compile(r"NetSales|Revenue|OperatingRevenue|OperatingIncome|OperatingProfit|ProfitLoss|"
                   r"ProfitAttributableToOwnersOfParent|NetIncome|OrdinaryIncome", re.I)
HOLDERS = re.compile(r"MajorShareholders|MajorShareholder|Shareholder|ShareholdingRatio|NumberOfSharesHeld", re.I)
DEFENSE = re.compile("買収防衛|大規模買付|対応方針|新株予約権無償割当|支配に関する基本方針|会社の支配")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
        return r.read()


def rows_of(doc_id: str):
    raw = fetch(f"{API}/documents/{doc_id}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
    out = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for name in z.namelist():
            if name.lower().endswith(".csv"):
                text = z.read(name).decode("utf-16", errors="replace")
                out += [r for r in csv.reader(io.StringIO(text), delimiter="\t")]
    return out


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set")
        return 1
    idx = json.loads((ROOT / "docs" / "data" / "edinet_yuho.json").read_text(encoding="utf-8"))
    print("index size", len(idx["by_ticker"]), "covered_from", idx.get("covered_from"))
    for t in TICKERS:
        row = idx["by_ticker"].get(t)
        print(f"\n######## {t} -> {row}")
        if not row:
            continue
        try:
            rows = rows_of(row["doc_id"])
        except Exception as e:  # noqa: BLE001
            print("  ERROR", str(e)[:160])
            continue
        print(f"  {len(rows)} rows; header: {rows[0][:9]}")
        print("  -- distinct context ids (first 40):", sorted({r[2] for r in rows[1:] if len(r) > 8})[:40])
        print("  -- money elements (value non-empty, short contexts only)")
        for r in rows[1:]:
            if len(r) < 9 or not MONEY.search(r[0]):
                continue
            if "_" in r[2] and "Member" in r[2]:
                continue                       # segment breakdowns
            if r[8].strip() in ("", "－", "-"):
                continue
            print(f"     {r[0][:70]:<70} | {r[1][:24]:<24} | {r[2][:34]:<34} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[8][:20]}")
        print("  -- holders")
        n = 0
        for r in rows[1:]:
            if len(r) >= 9 and HOLDERS.search(r[0]) and r[8].strip() and n < 40:
                print(f"     {r[0][:62]:<62} | {r[1][:20]:<20} | {r[2][:40]:<40} | {r[8][:40]}")
                n += 1
        print("  -- text blocks about control / defence")
        for r in rows[1:]:
            if len(r) >= 9 and (DEFENSE.search(r[1]) or DEFENSE.search(r[0])):
                v = r[8]
                hits = sorted(set(DEFENSE.findall(v)))
                print(f"     {r[0][:70]} | {r[1][:30]} | {r[2][:24]} | len {len(v)} | hits {hits}")
                print(f"        {v[:240]!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
