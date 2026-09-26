"""One-off probe: does the EDINET key work, and what do TOB filings actually look like?

Run locally with the key in the environment:
    EDINET_API_KEY=... python fetcher/edinet_probe.py
This is a scratch tool for shaping the deal cards, not part of the scheduled fetch.
"""
import collections
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

KEY = os.environ.get("EDINET_API_KEY", "")
BASE = "https://api.edinet-fsa.go.jp/api/v2"


def get(path: str, **params):
    params["Subscription-Key"] = KEY
    url = f"{BASE}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "DealWire probe"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set")
        return 1
    today = dt.date.today()
    seen = collections.Counter()
    for back in range(0, 7):
        day = today - dt.timedelta(days=back)
        try:
            d = get("documents.json", date=day.isoformat(), type=2)
        except Exception as e:  # noqa: BLE001
            print(f"{day}  ERROR {e}")
            continue
        status = d.get("metadata", {}).get("status")
        results = d.get("results") or []
        print(f"{day}  status {status}  docs {len(results)}")
        for r in results:
            seen[(r.get("docTypeCode"), r.get("ordinanceCode"))] += 1
        # show anything that looks like a takeover or a large shareholding
        for r in results:
            desc = r.get("docDescription") or ""
            if any(w in desc for w in ("公開買付", "大量保有", "意見表明", "公開買付届出")):
                print(f"    [{r.get('docTypeCode')}] {r.get('filerName')} -> {desc[:70]}"
                      f"  (subject: {r.get('subjectEdinetCode')}, secCode: {r.get('secCode')})")
    print("\ndocTypeCode counts (code, ordinance):")
    for k, n in seen.most_common(18):
        print(f"   {k}  {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
