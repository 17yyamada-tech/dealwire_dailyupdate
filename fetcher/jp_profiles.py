"""Profile data for Japanese listed companies, read from each one's latest annual securities report.

For every ticker in docs/data/edinet_yuho.json this opens the report's CSV (EDINET type=5) and
writes docs/data/jp_profiles/<ticker>.json: revenue / operating profit / net profit for the
last two years, the ten largest shareholders, and a hint on whether a takeover defence plan
is in place. A company is read again only when its report id changes, so after the first fill
each run handles just the new reports. The first fill is spread over several runs by a time budget.

Element names were checked against real reports (see edinet_probe_yuho.py):
  figures      context CurrentYearDuration / Prior1YearDuration (plain context = consolidated when the
               company has consolidated statements)
  shareholders jpcrp_cor:NameMajorShareholders / ShareholdingRatio in CurrentYearInstant_No{n}MajorShareholdersMember
  control      jpcrp_cor:BasicPolicyRegardingControlOfCompanyTextBlock (+ the governance overview)
  price        the "key figures" table (SummaryOfBusinessResults): BasicEarningsLossPerShare*, PriceEarningsRatio*,
               NetAssetsPerShare* (or a per-share equity line by label), TotalShareholderReturn and
               TotalReturnOnSharePriceIndex (company-only context), five years each (Prior4Year..CurrentYear).
               High / low share price are NOT tagged separately: they only exist as plain text inside
               BusinessResultsOfReportingCompanyTextBlock, so they are read from that text and checked against
               PER x EPS. Shares: NumberOfIssuedSharesAsOfFiscalYearEnd* minus the treasury rows of
               NumberOfSharesIssuedSharesVotingRights.
The defence flag is a wording match, not a legal reading; the note says so.

Needs the repository secret EDINET_API_KEY. Standard library only.
"""
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
OUT = DATA / "jp_profiles"
API = "https://api.edinet-fsa.go.jp/api/v2"
PDF = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/{}.pdf"
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
KEY = os.environ.get("EDINET_API_KEY", "")
BUDGET_S = int(os.environ.get("JP_BUDGET_MIN", "42") or "42") * 60
PAUSE_S = 0.4
ONLY = [t for t in os.environ.get("JP_TICKERS", "").split(",") if t]
DEBUG = os.environ.get("JP_DEBUG") == "1"
DRY = os.environ.get("JP_DRY") == "1"       # print the price block, write nothing
csv.field_size_limit(1 << 28)

REVENUE = ["jppfs_cor:NetSales", "jpigp_cor:RevenueIFRS", "jpigp_cor:Revenue2IFRS", "jppfs_cor:OperatingRevenue1",
           "jppfs_cor:OperatingRevenue2", "jppfs_cor:OrdinaryIncomeBNK", "jppfs_cor:OrdinaryIncomeINS",
           "jppfs_cor:OperatingRevenueSEC", "jpcrp_cor:NetSalesSummaryOfBusinessResults",
           "jpcrp_cor:RevenueIFRSSummaryOfBusinessResults", "jpcrp_cor:OperatingRevenue1SummaryOfBusinessResults",
           "jpcrp_cor:RevenuesUSGAAPSummaryOfBusinessResults", "jpcrp_cor:OrdinaryIncomeBNKSummaryOfBusinessResults",
           "jpcrp_cor:OrdinaryIncomeINSSummaryOfBusinessResults"]
# last resort: the ordinary income (経常収益) line that insurers and banks report in the summary table
REVENUE_LAST = ["jpcrp_cor:OrdinaryIncomeSummaryOfBusinessResults"]
REVENUE_RE = re.compile(r"^(NetSales|InsuranceRevenue|Revenues?\d?|OperatingRevenues?\d?|SalesRevenues?|TotalNetRevenues?|NetRevenues?)"
                        r"(IFRS|USGAAP)?(SummaryOfBusinessResults|KeyFinancialData)?$")
OPERATING = ["jppfs_cor:OperatingIncome", "jpigp_cor:OperatingProfitLossIFRS"]
NET = ["jppfs_cor:ProfitLossAttributableToOwnersOfParent", "jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS",
       "jpcrp_cor:ProfitLossAttributableToOwnersOfParentSummaryOfBusinessResults",
       "jpcrp_cor:ProfitLossAttributableToOwnersOfParentIFRSSummaryOfBusinessResults", "jppfs_cor:ProfitLoss",
       "jppfs_cor:NetIncomeLoss", "jpcrp_cor:NetIncomeLossSummaryOfBusinessResults"]

PLAN = re.compile(r"買収防衛策|大規模買付|買付ルール|新株予約権(の)?無償割当|事前警告|大量取得行為|大量買付行為|(買収|買付|大量取得)[^。]{0,40}対応(方針|策)|対応(方針|策)[^。]{0,40}(買収|買付|大量取得)")
ENDED = re.compile(r"廃止(いたしました|しました|いたします|します|することを決議|を決議)|継続(しない|せず|いたしません|しません)|更新(しない|せず|いたしません|しません)|導入して(おり|い)ました|失効|終了いたしました|終了しました")
NEVER = re.compile(r"導入して(い|おり)(ません|ない)|導入する予定(は)?(あり|な)|定めて(い|おり)(ません|ない)|策定して(い|おり)(ません|ない)")
MACHINE = " Matched by wording in the report, so read the filing."


def fetch(url: str) -> bytes:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))


def edinet_rows(doc_id: str) -> list:
    raw = fetch(f"{API}/documents/{doc_id}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
    out = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        main = [n for n in names if "jpcrp030000-asr" in n]
        for n in main or names:
            text = z.read(n).decode("utf-16", errors="replace").lstrip("﻿")
            out += [r for r in csv.reader(io.StringIO(text), delimiter="\t")][1:]
    return [r for r in out if len(r) >= 9]


def num(s: str):
    t = s.replace(",", "").strip()
    return float(t) if re.fullmatch(r"-?\d+(\.\d+)?", t) else None


def measure(rows, names, fuzzy, end, last=()):
    cur, prev, basis = {}, {}, {}
    for r in rows:
        slot = cur if r[2] == "CurrentYearDuration" else prev if r[2] == "Prior1YearDuration" else None
        if slot is None or r[0] in slot:
            continue
        v = num(r[8])
        if v is None:
            continue
        slot[r[0]] = v
        if r[2] == "CurrentYearDuration":
            basis[r[0]] = r[4]
    eid = next((n for n in names if n in cur), None)
    if not eid and fuzzy:
        eid = next((k for k in cur if fuzzy.match(k.split(":")[-1])), None)
    if not eid:
        eid = next((n for n in last if n in cur), None)
    if not eid:
        return None
    series = [{"end": end, "val": int(cur[eid])}]
    if eid in prev:
        series.append({"end": str(int(end[:4]) - 1) + end[4:], "val": int(prev[eid])})
    return {"series": series, "basis": basis[eid], "element": eid}


def sentences(t: str):
    return [s for s in re.split(r"(?<=。)", t) if s.strip()]


def clip(s: str, n: int = 100) -> str:
    return re.sub(r"\s+", "", s)[:n]


def defense(rows, end, url):
    text = {}
    for r in rows:
        m = re.search(r":(BasicPolicyRegardingControlOfCompanyTextBlock|OverviewOfCorporateGovernanceTextBlock)$", r[0])
        if m and m.group(1) not in text and len(r[8]) > 20:
            text[m.group(1)] = r[8]
    basic = text.get("BasicPolicyRegardingControlOfCompanyTextBlock", "")
    gov = text.get("OverviewOfCorporateGovernanceTextBlock", "")
    if basic and PLAN.search(basic):
        plan = [s for s in sentences(basic) if PLAN.search(s)]
        pick = clip(next((s for s in plan if re.search(r"導入|継続|更新|承認|決議|廃止", s)), plan[0]))
        no = next((s for s in sentences(basic) if NEVER.search(s)), "")
        if ENDED.search(basic):
            d = ("unknown", f'The control-policy section mentions a takeover defence plan and also wording about ending it: "{pick}"')
        elif no:
            d = ("none_found", f'The control-policy section says no plan is adopted: "{clip(no)}"')
        else:
            d = ("yes", f'The control-policy section describes a takeover defence plan: "{pick}"')
    elif basic or gov:
        g = next((s for s in sentences(gov) if "買収防衛" in s), "")
        if not g:
            d = ("none_found", "No takeover defence plan wording in the control-policy or governance sections.")
        elif NEVER.search(g):
            d = ("none_found", f'The governance section says no plan is in place: "{clip(g)}"')
        else:
            d = ("unknown", f'The governance section mentions takeover defence: "{clip(g)}"')
    else:
        return {"flag": "unknown", "note": "The report has no control-policy or governance text that could be read.",
                "as_of": end, "source": "EDINET", "url": url}
    return {"flag": d[0], "note": d[1] + MACHINE, "as_of": end, "source": "EDINET", "url": url}


# ---------------------------------------------------------------- price block (estimated from the filing)

CTX = re.compile(r"^(CurrentYear|Prior([1-4])Year)(Duration|Instant)(_NonConsolidatedMember)?$")
EPS_EL = re.compile(r"BasicEarningsLossPerShare(IFRS|USGAAP)?SummaryOfBusinessResults")
PER_EL = re.compile(r"PriceEarningsRatio(IFRS|USGAAP)?SummaryOfBusinessResults")
BPS_EL = re.compile(r"NetAssetsPerShare(IFRS|USGAAP)?SummaryOfBusinessResults")
BPS_LABEL = re.compile(r"^1株当たり[^、]{0,12}(純資産|持分|資本)")


def nfkc(t: str) -> str:
    return unicodedata.normalize("NFKC", t)


def split_tokens(seg: str):
    """'2,475(12,375)2,2833,8913,8244,000' -> [2475, 2283, 3891, 3824, 4000]. The text keeps no cell borders,
    so numbers are cut by thousands groups; decimals (0 to 2 places) are tried one fixed width at a time."""
    seg = nfkc(seg)
    seg = re.sub(r"\([^)]*\)", "", seg)                 # (pre-split figure) in brackets
    seg = re.sub(r"^[\s円〃ドル]+", "", seg)
    cut = re.match(r"^[\d,.\s]*", seg).group(0).replace(" ", "")
    if not cut:
        return None
    for d in (0, 1, 2):
        pat = re.compile(r"\d{1,3}(?:,\d{3})*" + (r"\.\d{%d}" % d if d else ""))
        pos, out = 0, []
        while pos < len(cut):
            m = pat.match(cut, pos)
            if not m:
                out = None
                break
            out.append(float(m.group(0).replace(",", "")))
            pos = m.end()
        if out:
            return out
    return None


def high_low(rows):
    """(highs, lows, text) from the plain text of the company-only key figures table, newest last."""
    for r in rows:
        if r[0].endswith("BusinessResultsOfReportingCompanyTextBlock") and "最高株価" in r[8]:
            t = nfkc(r[8])
            i, j = t.index("最高株価"), t.find("最低株価")
            if j < i:
                continue
            hi = split_tokens(t[i + 4:j])
            rest = t[j + 4:]
            end = min([x for x in (rest.find("(注"), rest.find("注)")) if x >= 0] or [len(rest)])
            lo = split_tokens(rest[:min(end, 160)])
            return hi, lo, t
    return None, None, ""


def split_events(text: str):
    ev = []
    for sent in re.split(r"(?<=。)", text):
        if "株式分割" not in sent:
            continue
        m = re.search(r"1株につき(\d+)株の割合", sent) or re.search(r"1株を(\d+)株に", sent)
        if not m:
            continue
        d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", sent)
        ev.append({"ratio": int(m.group(1)),
                   "date": f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}" if d else ""})
    out, seen = [], set()
    for e in ev:
        if (e["ratio"], e["date"]) not in seen and e["ratio"] > 1:
            seen.add((e["ratio"], e["date"]))
            out.append(e)
    return out


def share_counts(rows):
    issued = None
    for r in rows:
        v = num(r[8])
        if v is not None and r[0].endswith(":NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc") \
                and r[2] in ("FilingDateInstant_OrdinaryShareMember", "FilingDateInstant"):
            issued = int(v)
            break
    if issued is None:
        for r in rows:
            v = num(r[8])
            if v is not None and r[0].endswith(":NumberOfSharesIssuedSharesVotingRights") and r[2] == "CurrentYearInstant":
                issued = int(v)
                break
    tre, found = 0, False
    for r in rows:
        v = num(r[8])
        if v is not None and r[0].endswith(":NumberOfSharesIssuedSharesVotingRights") and r[2].startswith("CurrentYearInstant_") \
                and "Treasury" in r[2] and not re.search(r"Restricted|NoVoting|LessThanOneUnit", r[2]):
            tre += int(v)
            found = True
    return issued, (tre if found else None)


def price_block(rows, end, url):
    vals = {}
    for r in rows:
        m = CTX.match(r[2])
        if not m:
            continue
        v = num(r[8])
        if v is None:
            continue
        k, scope = int(m.group(2) or 0), "n" if m.group(4) else "c"
        el = r[0].split(":")[-1]
        kind = None
        if EPS_EL.fullmatch(el):
            kind = "eps"
        elif PER_EL.fullmatch(el):
            kind = "per"
        elif el == "TotalShareholderReturn":
            kind = "tsr"
        elif el == "TotalReturnOnSharePriceIndex":
            kind = "tsr_idx"
        elif m.group(3) == "Instant" and "SummaryOfBusinessResults" in el and (BPS_EL.fullmatch(el) or BPS_LABEL.match(nfkc(r[1]))):
            kind = "bps"
        if kind:
            vals.setdefault((kind, scope, k), v)
    basis = "consolidated" if any(key[0] in ("eps", "per") and key[1] == "c" for key in vals) else "standalone"
    order = ("c", "n") if basis == "consolidated" else ("n", "c")

    def get(kind, k, sc=None):
        for s_ in (sc or order):
            if (kind, s_, k) in vals:
                return vals[(kind, s_, k)]
        return None

    hi, lo, text = high_low(rows)
    n = len(hi) if hi and lo and len(hi) == len(lo) and 1 <= len(hi) <= 5 else 0
    events = split_events(text)
    ratios = [e["ratio"] for e in events]
    cands = sorted({1, *ratios, *[a * b for a in ratios for b in ratios]})
    notes, years = [], []
    for k in range(4, -1, -1):
        eps, per, bps = get("eps", k), get("per", k), get("bps", k)
        est = round(eps * per, 1) if eps and per and eps > 0 and per > 0 else None
        h = l = None
        if n and k < n:
            h, l = hi[n - 1 - k], lo[n - 1 - k]
        years.append({"k": k, "fy_end": str(int(end[:4]) - k) + end[4:], "high": h, "low": l, "eps": eps, "bps": bps,
                      "per": per, "est_close": est, "scale": 1})
    resolved = {}
    for y in years:
        if y["high"] is None or y["low"] is None or y["est_close"] is None:
            continue
        sc = next((s_ for s_ in cands if y["low"] / s_ * 0.88 <= y["est_close"] <= y["high"] / s_ * 1.12), None)
        if sc is None:
            y["bad"] = True
        else:
            resolved[y["k"]] = sc
    adj = False
    for y in years:
        if y["k"] in resolved:
            y["scale"] = resolved[y["k"]]
        elif y["high"] is not None and not y.get("bad") and resolved:
            y["scale"] = resolved[min(resolved, key=lambda kk: abs(kk - y["k"]))]
        if y.get("bad"):
            y["high"] = y["low"] = None
            notes.append(f"High/low for FY{y['fy_end'][:4]} in the filing text did not fit PER x EPS, so they are left out.")
        elif y["high"] is not None and y["scale"] != 1:
            y["high"], y["low"] = round(y["high"] / y["scale"], 2), round(y["low"] / y["scale"], 2)
            adj = True
    for e in events:
        notes.append(f"Stock split {e['ratio']}-for-1" + (f" effective {e['date']}" if e["date"] else "") +
                     (": high/low before it are divided to match the restated EPS." if adj else " noted in the filing."))
    if not n:
        notes.append("High/low share prices could not be read from the filing text.")
    cur = years[-1]
    est_price = cur["est_close"]
    if est_price is None:
        notes.append("Year-end price not estimated (no PER, or a loss year).")
    issued, treas = share_counts(rows)
    shares_out = (issued - (treas or 0)) if issued else None
    est_mcap = int(est_price * shares_out) if est_price and shares_out else None
    pbr = round(est_price / cur["bps"], 2) if est_price and cur["bps"] and cur["bps"] > 0 else None
    tsr = get("tsr", 0, ("n", "c"))
    tsr_i = get("tsr_idx", 0, ("n", "c"))
    out_years = [{f: y[f] for f in ("fy_end", "high", "low", "eps", "bps", "per", "est_close")} for y in years
                 if any(y[f] is not None for f in ("high", "low", "eps", "bps", "per", "est_close"))]
    return {"kind": "jp_fy", "as_of": end, "basis": basis, "currency": "JPY", "est_price": est_price, "est_mcap": est_mcap,
            "per": cur["per"], "pbr": pbr, "bps": cur["bps"], "eps": cur["eps"],
            "tsr": round(tsr * 100, 1) if tsr is not None else None,
            "tsr_index": round(tsr_i * 100, 1) if tsr_i is not None else None,
            "shares_issued": issued, "shares_treasury": treas, "shares_out": shares_out,
            "years": out_years, "notes": notes, "source": "EDINET", "url": url}


def build(tk: str, hit: dict, sector: str) -> dict:
    url = PDF.format(hit["doc_id"])
    end = hit["period_end"]
    rows = edinet_rows(hit["doc_id"])
    if DEBUG:
        seen = set()
        for r in rows:
            if r[2] == "CurrentYearDuration" and re.search(r"Revenue|Sales|OrdinaryIncome|Operating|ProfitLoss", r[0]) \
                    and "TextBlock" not in r[0] and r[0] not in seen:
                seen.add(r[0])
                print(f"      {tk} {r[0][:80]:<80} {r[4]} {r[8][:16]}")
    rev = measure(rows, REVENUE, REVENUE_RE, end, REVENUE_LAST)
    op = measure(rows, OPERATING, None, end)
    ni = measure(rows, NET, None, end)
    fin = None
    if rev or op or ni:
        first = rev or op or ni
        fin = {"currency": "JPY", "basis": "standalone" if first["basis"] == "個別" else "consolidated",
               "revenue": rev["series"] if rev else [], "operating_income": op["series"] if op else [],
               "net_income": ni["series"] if ni else [], "source": "EDINET", "url": url}
    by_no = {}
    for r in rows:
        m = re.fullmatch(r"CurrentYearInstant_No(\d+)MajorShareholdersMember", r[2])
        if not m:
            continue
        e = by_no.setdefault(int(m.group(1)), {"name": "", "pct": None})
        if r[0].endswith(":NameMajorShareholders"):
            e["name"] = re.sub(r"\s+", " ", r[8]).strip()[:80]
        elif r[0].endswith(":ShareholdingRatio"):
            v = num(r[8])
            if v is not None:
                e["pct"] = round(v * 100 if v <= 1 else v, 2)
    lst = [by_no[k] for k in sorted(by_no) if by_no[k]["name"]][:10]
    holders = {"kind": "top10", "as_of": end, "list": lst, "source": "EDINET", "url": url} if lst else None
    try:
        price = price_block(rows, end, url)
    except Exception as e:  # noqa: BLE001 - the rest of the profile is still worth keeping
        price = {"kind": "jp_fy", "as_of": end, "years": [], "notes": [f"Price block failed: {str(e)[:80]}"], "source": "EDINET", "url": url}
    if DRY:
        print(f"PRICE {tk} " + json.dumps(price, ensure_ascii=False))
    return {"market": "JP", "ticker": tk, "tv_symbol": "TSE:" + tk, "sector": sector, "fin": fin, "holders": holders,
            "defense": defense(rows, end, url), "price": price, "doc_id": hit["doc_id"], "period_end": end, "filer": hit.get("filer", ""),
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set; nothing written")
        return 1
    index = json.loads((DATA / "edinet_yuho.json").read_text(encoding="utf-8"))["by_ticker"]
    sectors = {r["t"]: r.get("s", "") for r in json.loads((DATA / "company_index.json").read_text(encoding="utf-8"))["rows"] if r["m"] == "JP"}
    OUT.mkdir(parents=True, exist_ok=True)
    todo = []
    for tk, hit in sorted(index.items()):
        if ONLY and tk not in ONLY:
            continue
        f = OUT / f"{tk}.json"
        try:
            old = json.loads(f.read_text(encoding="utf-8"))
            have, old_price = old.get("doc_id"), old.get("price")
        except Exception:  # noqa: BLE001
            have, old_price = None, None
        if have != hit["doc_id"] or not isinstance(old_price, dict):
            todo.append((tk, hit))
    print(f"{len(index)} companies in the index, {len(todo)} to read")
    start, done, failed = time.time(), 0, 0
    for tk, hit in todo:
        if time.time() - start > BUDGET_S:
            print("time budget reached; the next run continues")
            break
        try:
            prof = build(tk, hit, sectors.get(tk, ""))
            if DRY:
                done += 1
                time.sleep(PAUSE_S)
                continue
            (OUT / f"{tk}.json").write_text(json.dumps(prof, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            done += 1
        except Exception as e:  # noqa: BLE001 - retried next run
            failed += 1
            print(f"  {tk} FAILED {str(e)[:100]}")
        time.sleep(PAUSE_S)
    print(f"wrote {done} profiles, {failed} failed, {len(todo) - done - failed} left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
