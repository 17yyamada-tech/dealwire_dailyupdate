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


POS = re.compile(r"買収防衛策|大規模買付|買付ルール|新株予約権の無償割当|新株予約権無償割当|事前警告|大量取得行為|(買収|買付|大量取得)[^。]{0,40}対応方針|対応方針[^。]{0,40}(買収|買付|大量取得)")
NEG = re.compile(r"導入(して|し)(い)?(おりま)?せん|導入(して|し)(い)?ない|導入(する|いたす)?予定(は)?(あり|ご)?(ま)?(せん|ない)|廃止|更新(し|は行)(な|ま)|継続(し|は行)(な|ま)|定めて(い)?(おりま)?せん|予定はありません|ありません|行っておりません")


def classify(text: str):
    """yes / none_found with the sentence that decided it."""
    sentences = [t for t in re.split(r"(?<=。)", text) if t.strip()]
    pos = [t for t in sentences if POS.search(t)]
    if not pos:
        return "none_found", ""
    live = [t for t in pos if not NEG.search(t)]
    return ("yes", live[0]) if live else ("none_found", pos[0])


def scan(n: int) -> None:
    idx = json.loads((ROOT / "docs" / "data" / "edinet_yuho.json").read_text(encoding="utf-8"))["by_ticker"]
    tks = sorted(idx)
    pick = tks[:: max(1, len(tks) // n)][:n]
    for t in pick:
        try:
            rows = rows_of(idx[t]["doc_id"])
        except Exception as e:  # noqa: BLE001
            print(t, "ERROR", str(e)[:80])
            continue
        blocks = {r[0].split(":")[-1]: r[8] for r in rows[1:] if len(r) >= 9 and r[2] == "FilingDateInstant"
                  and r[0].split(":")[-1] in ("BasicPolicyRegardingControlOfCompanyTextBlock", "OverviewOfCorporateGovernanceTextBlock")}
        bp = blocks.get("BasicPolicyRegardingControlOfCompanyTextBlock")
        flag, sent = classify(bp) if bp else ("(no block)", "")
        flag2, sent2 = classify(blocks.get("OverviewOfCorporateGovernanceTextBlock", ""))
        print(f"{t} {idx[t]['filer'][:14]:<14} basic={flag:<10} len={len(bp or ''):>5} | gov={flag2} | {(sent or sent2)[:150]!r}")


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set")
        return 1
    if TICKERS and TICKERS[0].startswith("scan"):
        scan(int(TICKERS[0][4:] or 30))
        return 0
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
        print("  -- money elements (plain Current/Prior1 year contexts only)")
        for r in rows[1:]:
            if len(r) < 9 or not MONEY.search(r[0]) or r[2] not in ("CurrentYearDuration", "Prior1YearDuration"):
                continue
            if r[8].strip() in ("", "－", "-") or "TextBlock" in r[0]:
                continue
            print(f"     {r[0][:78]:<78} | {r[2][:6]} | {r[4]} | {r[6]} | {r[8][:16]}")
        print("  -- everything tagged for the No1 and No2 major shareholder")
        for r in rows[1:]:
            if len(r) >= 9 and re.search(r"No[12]MajorShareholdersMember", r[2]):
                print(f"     {r[0][:70]:<70} | {r[1][:30]:<30} | {r[2][:44]:<44} | {r[8][:40]}")
        nums = [int(m.group(1)) for r in rows[1:] if len(r) > 2 for m in [re.search(r"No(\d+)MajorShareholdersMember", r[2])] if m]
        print(f"  -- highest major shareholder number: {max(nums or [0])}; plain instant contexts: "
              f"{sorted({r[2] for r in rows[1:] if len(r) > 2 and r[2].startswith('CurrentYearInstant') and '_' not in r[2]})}")
        print("  -- rows whose VALUE mentions control / defence wording")
        shown = 0
        for r in rows[1:]:
            if len(r) >= 9 and len(r[8]) > 60 and DEFENSE.search(r[8]):
                v = r[8]
                hits = sorted(set(DEFENSE.findall(v)))
                i = DEFENSE.search(v).start()
                print(f"     {r[0][:80]} | {r[1][:34]} | {r[2][:24]} | len {len(v)} | hits {hits}")
                print(f"        ...{v[max(0, i - 40):i + 160]!r}")
                shown += 1
                if shown >= 8:
                    break
    return 0


if __name__ == "__main__":
    sys.exit(main())
