"""Probe: which elements carry PER / EPS / BPS / high-low share price / TSR / share counts in a yuho CSV.

Prints every row from the "key figures" (SummaryOfBusinessResults) group and anything about
share price, shares issued and treasury shares. Writes nothing. Run from the edinet-probe workflow.
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
TICKERS = [t for t in os.environ.get("PROBE_TICKERS", "7203,7974,4967,8306").split(",") if t]
WANT = re.compile(r"PerShare|PriceEarnings|SharePrice|StockPrice|ShareholderReturn|TSR|TotalNumberOfIssuedShares|"
                  r"TreasuryShares|NumberOfSharesIssued|IssuedShares|StockSplit|FiscalYearEnd|CurrentFiscalYearEndDate|"
                  r"HighestShare|LowestShare|Highest|Lowest|Dividend", re.I)
csv.field_size_limit(1 << 28)


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
        return r.read()


def main():
    idx = json.loads((ROOT / "docs" / "data" / "edinet_yuho.json").read_text(encoding="utf-8"))["by_ticker"]
    for tk in TICKERS:
        hit = idx.get(tk)
        if not hit:
            print(f"== {tk} not in index")
            continue
        raw = fetch(f"{API}/documents/{hit['doc_id']}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
        print(f"\n===== {tk} {hit['doc_id']} {hit['period_end']}")
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for n in z.namelist():
                if not (n.lower().endswith(".csv") and "jpcrp030000-asr" in n):
                    continue
                text = z.read(n).decode("utf-16", errors="replace").lstrip("\ufeff")
                rows = [r for r in csv.reader(io.StringIO(text), delimiter="\t")][1:]
                print(f"-- {n} rows={len(rows)}")
                seen = 0
                for r in rows:
                    if len(r) >= 9 and re.search(r"NumberOfSharesIssuedSharesVotingRights|NumberOfIssuedShares|NumberOfTreasury|TreasuryStock$", r[0]) and "Row" not in r[2]:
                        print(f"   [SH] {r[0].split(':')[-1][:90]} | {r[1][:30]} | {r[2][:90]} | {r[8][:20]}")
                    if len(r) >= 9 and re.search("株価|株式の価格|Price", r[1] + r[0]) and "TextBlock" not in r[0]:
                        print(f"   [PX] {r[0].split(':')[-1][:60]} | {r[1][:40]} | {r[2][:40]} | {r[8][:30]}")
                    if len(r) >= 9 and "最高株価" in r[8]:
                        i = r[8].index("最高株価")
                        print(f"   [TXT] {r[0].split(':')[-1][:60]} | {r[8][max(0,i-120):i+400]!r}")
                    if len(r) < 9 or "TextBlock" in r[0]:
                        continue
                    if re.search(r"Treasury|Row\d+Member|ShareholdingRatio|VotingRights|Interim|DividendPaid|Dilut|RatioOfOwners|EquityToAsset", r[0]):
                        continue
                    if re.search("最高|最低", r[1]) and "SummaryOfBusinessResults" not in r[0] and seen < 400:
                        print(f"   [HL] {r[0].split(':')[-1][:60]} | {r[1][:30]} | {r[2][:40]} | {r[4]} | {r[8][:20]}")
                        seen += 1
                        continue
                    if WANT.search(r[0]) or "経営指標" in r[1] and "SummaryOfBusinessResults" in r[0] and ("株" in r[1] or "利回" in r[1] or "比率" in r[1]):
                        print(f"   {r[0].split(':')[-1][:70]:<70} | {r[1][:24]:<24} | {r[2][:38]:<38} | {r[3]} | {r[4]} | {r[8][:20]}")
                        seen += 1
                        if seen > 400:
                            break


if __name__ == "__main__":
    sys.exit(main())
