"""Index of each listed company's latest annual securities report (有価証券報告書).

The Companies page's Profile (financials, top shareholders, takeover defence) is read out of
that report, and finding it needs its EDINET document id. EDINET can only be asked "what was
filed on this day", so this walks the daily index and keeps, per ticker, the newest report
(docTypeCode 120; amendments are not used). The first run reaches back about 1,900 days (five
years and a bit), so each ticker also keeps its older reports in "hist" ([doc_id, period_end,
submitted], newest first); the Profile's five-year operating profit is read from those. The run is
resumable: covered_from moves back every run until the horizon is reached ("hist_done"). Later
runs look at the last few days only.

Writes docs/data/edinet_yuho.json. Needs the repository secret EDINET_API_KEY.
Standard library only, like edinet.py.
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "edinet_yuho.json"
API = "https://api.edinet-fsa.go.jp/api/v2"
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
KEY = os.environ.get("EDINET_API_KEY", "")
BACKFILL_DAYS = int(os.environ.get("YUHO_BACKFILL_DAYS", "1900"))
KEEP_YEARS = 6              # older reports than this are dropped from "hist"
MAX_HIST = 8
RECENT_DAYS = int(os.environ.get("YUHO_RECENT_DAYS", "5"))
PAUSE_S = 0.3
BUDGET_S = 24 * 60          # stop scanning before the workflow timeout; the next run continues


def fetch(url: str) -> bytes:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception:  # noqa: BLE001 - retried, then raised
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set; nothing written")
        return 1
    try:
        cur = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - first run
        cur = {}
    by_ticker = cur.get("by_ticker", {})
    today = dt.date.today()
    # covered_from: the oldest day already scanned. Until it reaches the backfill horizon the
    # run keeps walking backwards from there, so an interrupted first run simply continues.
    horizon = today - dt.timedelta(days=BACKFILL_DAYS)
    covered = cur.get("covered_from")
    covered = dt.date.fromisoformat(covered) if covered else None
    days = [today - dt.timedelta(days=i) for i in range(RECENT_DAYS)]
    if covered is None:
        days = [today - dt.timedelta(days=i) for i in range(BACKFILL_DAYS + 1)]
    elif covered > horizon:
        days += [covered - dt.timedelta(days=i) for i in range(1, (covered - horizon).days + 1)]
    days = [d for d in days if d.weekday() < 5]
    start = time.time()
    scanned_oldest, new_rows, errors = covered, 0, 0
    for day in days:
        if time.time() - start > BUDGET_S:
            print("time budget reached; the next run continues from here")
            break
        try:
            res = json.loads(fetch(f"{API}/documents.json?" + urllib.parse.urlencode(
                {"date": day.isoformat(), "type": 2, "Subscription-Key": KEY})))
        except Exception as e:  # noqa: BLE001 - one bad day must not stop the run
            errors += 1
            print(f"  {day}  ERROR {str(e)[:100]}")
            if errors > 25:
                break
            continue
        for r in res.get("results") or []:
            if r.get("docTypeCode") != "120" or r.get("withdrawalStatus") != "0":
                continue
            sec = (r.get("secCode") or "").strip()
            if len(sec) < 4 or not r.get("docID") or not r.get("periodEnd"):
                continue
            tk = sec[:4]
            row = {"doc_id": r["docID"], "edinet_code": r.get("edinetCode") or "", "period_end": r["periodEnd"],
                   "submitted": (r.get("submitDateTime") or "")[:10], "filer": r.get("filerName") or ""}
            old = by_ticker.get(tk)
            seen = {h[0]: (h[1], h[2]) for h in (old or {}).get("hist", [])}
            if old:
                seen[old["doc_id"]] = (old["period_end"], old["submitted"])
            if row["doc_id"] in seen:
                continue
            seen[row["doc_id"]] = (row["period_end"], row["submitted"])
            newest = max(seen, key=lambda d: (seen[d][0], seen[d][1]))
            if newest == row["doc_id"]:
                top = row
                new_rows += 1
            else:
                top = {k: v for k, v in old.items() if k != "hist"}
            cutoff = (today - dt.timedelta(days=365 * KEEP_YEARS)).isoformat()
            top["hist"] = [[d, seen[d][0], seen[d][1]] for d in sorted(seen, key=lambda d: seen[d], reverse=True)
                           if d != top["doc_id"] and seen[d][0] >= cutoff][:MAX_HIST]
            by_ticker[tk] = top
        if scanned_oldest is None or day < scanned_oldest:
            scanned_oldest = day
        time.sleep(PAUSE_S)
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "covered_from": scanned_oldest.isoformat() if scanned_oldest else "",
           # sticky: true once the walk back has reached the horizon (give or take a week)
           "hist_done": bool(cur.get("hist_done")) or bool(scanned_oldest and scanned_oldest <= horizon + dt.timedelta(days=7)),
           "by_ticker": dict(sorted(by_ticker.items()))}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"index: {len(by_ticker)} companies ({new_rows} added or updated), covered from {out['covered_from']}, hist_done {out['hist_done']}, errors {errors}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
