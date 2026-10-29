"""Probe: every tagged value inside given EDINET documents (amended offers, offer results, 5% reports).

Used to find the element names behind the offer price, the result (成立/不成立, tendered and bought
shares) and the filer's English name. PROBE_DOCS is a comma-separated list of docIDs. Prints to the
log and writes nothing.
"""
import csv
import io
import os
import sys
import urllib.parse
import urllib.request
import zipfile

API = "https://api.edinet-fsa.go.jp/api/v2"
KEY = os.environ.get("EDINET_API_KEY", "")
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
DOCS = [d.strip() for d in os.environ.get("PROBE_DOCS", "S100Z9B5,S100Z9PM").split(",") if d.strip()]


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set")
        return 1
    for doc in DOCS:
        print(f"\n=== {doc}")
        try:
            url = f"{API}/documents/{doc}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY})
            raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                for name in z.namelist():
                    if not name.lower().endswith(".csv"):
                        continue
                    rows = list(csv.reader(io.StringIO(z.read(name).decode("utf-16", errors="replace")), delimiter="\t"))
                    print(f"  -- {name}: {len(rows)} rows")
                    n = 0
                    for r in rows[1:]:
                        if len(r) < 9 or r[8].strip() in ("", "－", "-"):
                            continue
                        full = any(w in r[1] for w in ("成否", "買付け等を行った株券等の数", "買付け等の価格", "買付予定の株券等の数", "応募", "買付予定数の下限"))
                        if not full:
                            continue
                        print(f"   {r[0][-48:]} | {r[1][:50]} | {r[8].strip()[:900].replace(chr(10), ' ')}")
                        n += 1
                        if n > 170:
                            print("   ...")
                            break
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR {str(e)[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
