"""Stage 2 probe: what is actually inside a tender offer filing?

The index gives who and when. The offer price, the premium and the offer period are inside
the document. This opens the CSV that ships with each filing we already have a card for and
prints the labelled values, so the extraction can be written against what is really there.

Run from the edinet-probe workflow, which holds the key.
"""
import csv
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.edinet-fsa.go.jp/api/v2"
KEY = os.environ.get("EDINET_API_KEY", "")
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}

# what a card would want to show, and the wording the filings use for it
WANTED = ("買付価格", "買付け価格", "対価", "プレミアム", "買付期間", "買付け期間",
          "公開買付期間", "買付予定", "買付予定数", "下限", "上限", "応募", "決済の開始日",
          "公開買付者", "対象者", "買付け等の価格", "買付け等の期間", "所有株券等の数",
          "株券等保有割合", "保有目的", "発行者")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def rows_of(doc_id: str):
    raw = fetch(f"{API}/documents/{doc_id}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = z.namelist()
        print(f"    files in package: {names}")
        for name in names:
            if not name.lower().endswith(".csv"):
                continue
            text = z.read(name).decode("utf-16", errors="replace")
            yield name, list(csv.reader(io.StringIO(text), delimiter="\t"))


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set")
        return 1
    cards = json.loads((ROOT / "docs" / "data" / "edinet.json").read_text(encoding="utf-8"))["cards"]
    picks = [c for c in cards if c["kind"] in ("tob", "tob_result")][:3]
    if not picks:
        print("no tender offer cards to probe")
        return 0
    for c in picks:
        print(f"\n=== {c['id']}  {c['type_ja']}  {c['buyer']['name']} -> {c['target']['name']}")
        try:
            for name, rows in rows_of(c["id"]):
                print(f"  -- {name}: {len(rows)} rows, header {rows[0][:9] if rows else '(empty)'}")
                shown = 0
                for r in rows[1:]:
                    if len(r) < 9:
                        continue
                    element, label, value = r[0], r[1], r[8].strip()
                    if not value or value in ("－", "-"):
                        continue
                    if any(w in label for w in WANTED):
                        print(f"     {label[:44]:<44} = {value[:80]}")
                        shown += 1
                    if shown > 40:
                        print("     ...")
                        break
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR {str(e)[:160]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
