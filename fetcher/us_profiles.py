"""Profile data for US listed companies, from the SEC.

Writes docs/data/us_profiles/<ticker>.json for every US ticker in docs/data/company_index.json:
  fin      revenue / operating income / net income, last two fiscal years. Taken from the XBRL
           "frames" API, which returns one value per company for a whole period in a single request,
           so all ~7,700 companies need a few dozen requests, not thousands.
  holders  holders of 5% or more, from Schedule 13D / 13G filings of the last three years
  defense  a shareholder rights plan hint: a Form 8-A for rights, or an 8-K item 3.03 that describes them
Holders and defence cost several requests per company, so they are filled over several runs:
companies never analysed go first, then the oldest. A company whose relevant filings have not changed
since the last look is skipped (one submissions request). State is kept in us_profiles/_state.json.

SEC fair access: the User-Agent (secret SEC_USER_AGENT) names a contact, requests stay well under
10 a second, and 403/429/5xx are waited out and retried.
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "us_profiles"
STATE = OUT / "_state.json"
UA = os.environ.get("SEC_USER_AGENT", "").strip()
BUDGET_S = int(os.environ.get("US_BUDGET_MIN", "40") or "40") * 60
ONLY = [t for t in os.environ.get("US_TICKERS", "").split(",") if t]
GAP_S = 0.16                      # about 6 requests a second
REANALYSE_DAYS = 60
TV = {"Nasdaq": "NASDAQ", "NYSE": "NYSE", "NYSE American": "AMEX", "NYSE MKT": "AMEX", "NYSE Arca": "NYSEARCA", "CBOE": "CBOE"}
REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
                "RevenuesNetOfInterestExpense", "TotalRevenuesAndOtherIncome"]
RIGHTS = re.compile(r"rights (agreement|plan)|preferred (share|stock) purchase rights|poison pill", re.I)
SKIP_WORDS = {"the", "inc", "corp", "corporation", "co", "company", "llc", "lp", "ltd", "plc", "group"}

# Windows cannot hold a file called CON.json, and this folder is checked out there too
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}


def fname(tk: str) -> str:
    return tk + "_.json" if tk.upper() in RESERVED else tk + ".json"


_last = [0.0]


def get(url: str, as_json: bool = False):
    """One polite GET. Returns text/JSON, or None for a 404."""
    for attempt in range(5):
        wait = GAP_S - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                body = r.read().decode("utf-8", "replace")
            return json.loads(body) if as_json else body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (403, 429, 500, 502, 503, 504):
                time.sleep((10, 30, 60, 120, 120)[attempt])
                continue
            raise
        except Exception:  # noqa: BLE001 - timeouts and resets
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("SEC did not answer: " + url.split("?")[0][-60:])


def plain(html: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html or "")).replace("\xa0", " "))


def holder_key(name: str) -> str:
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", name.lower()).split() if len(w) > 1 and w not in SKIP_WORDS]
    return " ".join(sorted(words))


# ---------------------------------------------------------------- financials from frames

def fiscal_series(frames: dict) -> dict:
    """cik -> list of {end, val}, newest first, at most two. A frame for a calendar year holds each
    company's fiscal year that falls mostly inside it, so a September year end shows up under the
    calendar year it ends in; the entry's own end date is what is reported."""
    out = {}
    for cik, rows in frames.items():
        byend = {}
        for r in rows:
            byend.setdefault(r["end"], r["val"])
        out[cik] = [{"end": e, "val": byend[e]} for e in sorted(byend, reverse=True)][:2]
    return out


def load_financials() -> dict:
    year = dt.date.today().year
    years = [year, year - 1, year - 2, year - 3]
    per_tag = {}
    for tag in REVENUE_TAGS + ["OperatingIncomeLoss", "NetIncomeLoss"]:
        rows_by_cik = {}
        for y in years:
            j = get(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/CY{y}.json", True)
            for r in (j or {}).get("data", []):
                if r.get("val") is None or not r.get("end"):
                    continue
                rows_by_cik.setdefault(r["cik"], []).append({"end": r["end"], "val": r["val"]})
        per_tag[tag] = fiscal_series(rows_by_cik)
        print(f"  frames {tag}: {len(rows_by_cik)} companies")
    fin = {}
    ciks = set().union(*[set(v) for v in per_tag.values()])
    for cik in ciks:
        # revenue: the tag that has the most recent year; ties go to the earlier tag in the list
        best = None
        for tag in REVENUE_TAGS:
            s = per_tag[tag].get(cik)
            if s and (best is None or s[0]["end"] > best[0]["end"]):
                best = s
        entry = {"revenue": best or [], "operating_income": per_tag["OperatingIncomeLoss"].get(cik, []),
                 "net_income": per_tag["NetIncomeLoss"].get(cik, [])}
        if entry["revenue"] or entry["operating_income"] or entry["net_income"]:
            fin[cik] = entry
    return fin


# ---------------------------------------------------------------- holders and defence

def analyse(cik: int, sub: dict) -> tuple:
    rc = (sub.get("filings") or {}).get("recent") or {}
    cutoff = (dt.date.today() - dt.timedelta(days=3 * 365)).isoformat()
    rows = []
    for i, form in enumerate(rc.get("form", [])):
        if rc["filingDate"][i] >= cutoff:
            rows.append({"form": form, "date": rc["filingDate"][i], "acc": rc["accessionNumber"][i],
                         "doc": rc["primaryDocument"][i], "items": rc["items"][i] or ""})
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/"
    by_holder = {}
    for x in [r for r in rows if re.match(r"^(SC |SCHEDULE )13[DG]", r["form"])][:12]:
        nd = x["acc"].replace("-", "")
        name, pct = "", None
        if x["doc"].endswith("primary_doc.xml"):
            xml = get(base + nd + "/primary_doc.xml") or ""
            m = re.search(r"<reportingPersonName>([^<]+)", xml)
            name = unescape(m.group(1)).strip() if m else ""
            ps = [float(v) for v in re.findall(r"<(?:classPercent|percentOfClass)>([\d.]+)<", xml)]
            pct = max(ps) if ps else None
        else:
            hdr = get(base + nd + "/" + x["acc"] + ".hdr.sgml") or ""
            m = re.search(r"<FILED-BY>\s*<COMPANY-DATA>\s*<CONFORMED-NAME>([^\n<]+)", hdr)
            name = unescape(m.group(1)).strip() if m else ""
            m = re.search(r"(?i)percent of class[^%]{0,200}?(\d{1,3}(?:\.\d+)?)\s*%", plain(get(base + nd + "/" + x["doc"]) or ""))
            pct = float(m.group(1)) if m else None
        k = holder_key(name) if name else ""
        if k and k not in by_holder:           # newest filing of a holder wins
            by_holder[k] = {"name": name[:80], "pct": pct, "date": x["date"]}
    lst = sorted((h for h in by_holder.values() if h["pct"] is None or h["pct"] >= 5), key=lambda h: -(h["pct"] or 0))[:10]
    pad = f"{cik:010d}"
    holders = None
    if by_holder:
        holders = {"kind": "5pct", "as_of": max([h["date"] for h in lst] or [rows[0]["date"]]),
                   "list": [{"name": h["name"], "pct": h["pct"]} for h in lst], "source": "SEC",
                   "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={pad}&type=SC+13&dateb=&owner=include&count=40"}
    found = None
    cands = [r for r in rows if re.match(r"^8-A12[BG]", r["form"]) or (r["form"].startswith("8-K") and "3.03" in r["items"].split(","))]
    for x in cands[:6]:
        if RIGHTS.search(plain(get(base + x["acc"].replace("-", "") + "/" + x["doc"]) or "")):
            found = x
            break
    if found:
        defense = {"flag": "possible", "note": f"A shareholder rights plan (poison pill) may be in place: {found['form']} filed {found['date']} "
                   "describes rights issued to shareholders. Matched by text, so read the filing.", "as_of": found["date"],
                   "source": "SEC", "url": base + found["acc"].replace("-", "") + "/" + found["doc"]}
    else:
        defense = {"flag": "none_found", "note": "No Form 8-A rights registration or item 3.03 rights-plan 8-K in the last three years. "
                   "Matched by text, so a plan could still exist.", "as_of": dt.date.today().isoformat(), "source": "SEC",
                   "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={pad}&type=8-"}
    return holders, defense


def relevant_latest(sub: dict) -> str:
    rc = (sub.get("filings") or {}).get("recent") or {}
    best = ""
    for i, form in enumerate(rc.get("form", [])):
        if re.match(r"^(SC |SCHEDULE )13[DG]|^8-A12", form) or (form.startswith("8-K") and "3.03" in (rc["items"][i] or "").split(",")):
            best = max(best, rc["filingDate"][i])
    return best


# ---------------------------------------------------------------- main

def main() -> int:
    if not UA:
        print("SEC_USER_AGENT is not set; nothing written")
        return 1
    rows = [r for r in json.loads((DATA / "company_index.json").read_text(encoding="utf-8"))["rows"]
            if r["m"] == "US" and r.get("c") and re.fullmatch(r"[A-Za-z0-9.\-]{1,10}", r["t"])]
    if ONLY:
        rows = [r for r in rows if r["t"] in ONLY]
    OUT.mkdir(parents=True, exist_ok=True)
    for t in RESERVED:                       # files written before the rename
        (OUT / f"{t}.json").unlink(missing_ok=True)
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        state = {}
    start = time.time()
    fin = load_financials()
    print(f"financials for {len(fin)} companies in {time.time() - start:.0f}s")

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    today = dt.date.today().isoformat()
    # oldest look first; never analysed first of all
    order = sorted(rows, key=lambda r: state.get(r["t"], {}).get("checked", ""))
    analysed = skipped = failed = 0
    new_files = changed = 0
    for r in order:
        tk, cik = r["t"], r["c"]
        st = state.setdefault(tk, {})
        f = OUT / fname(tk)
        try:
            old = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            old = None
        prof = {"market": "US", "ticker": tk, "tv_symbol": f"{TV[r['x']]}:{tk}" if r.get("x") in TV else "",
                "sector": (old or {}).get("sector", ""), "fin": None,
                "holders": (old or {}).get("holders"), "defense": (old or {}).get("defense"), "cik": cik,
                "detail": "done" if old and old.get("detail") == "done" else "pending"}
        e = fin.get(cik)
        if e:
            prof["fin"] = {"currency": "USD", "basis": "us-gaap", **e, "source": "SEC",
                           "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik:010d}&type=10-K"}
        if time.time() - start < BUDGET_S and not (st.get("checked", "") >= today and old and not ONLY):
            try:
                sub = get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", True)
                if sub:
                    prof["sector"] = sub.get("sicDescription") or prof["sector"]
                    rel = relevant_latest(sub)
                    stale = (dt.date.today() - dt.date.fromisoformat(st.get("analysed", "2000-01-01"))).days >= REANALYSE_DAYS
                    if prof["detail"] != "done" or rel != st.get("rel") or stale:
                        prof["holders"], prof["defense"] = analyse(cik, sub)
                        prof["detail"], st["rel"], st["analysed"] = "done", rel, today
                        analysed += 1
                    else:
                        skipped += 1
                    st["checked"] = today
            except Exception as ex:  # noqa: BLE001 - retried on a later run
                failed += 1
                print(f"  {tk} FAILED {str(ex)[:90]}")
        prof["updated"] = (old or {}).get("updated", now)
        if old is None or {k: v for k, v in old.items() if k != "updated"} != {k: v for k, v in prof.items() if k != "updated"}:
            prof["updated"] = now
            f.write_text(json.dumps(prof, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            changed += 1
            new_files += old is None
    STATE.write_text(json.dumps(state, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    pending = sum(1 for r in rows if state.get(r["t"], {}).get("analysed") is None)
    print(f"{len(rows)} tickers; files written {changed} ({new_files} new); holders/defence analysed {analysed}, "
          f"unchanged {skipped}, failed {failed}; never analysed yet {pending}; {time.time() - start:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
