"""Profile data for Japanese listed companies, read from each one's latest annual securities report.

For every ticker in docs/data/edinet_yuho.json this opens the report's CSV (EDINET type=5) and
writes docs/data/jp_profiles/<ticker>.json: revenue / operating profit / net profit for the
last five years (operating profit also from older reports), the ten largest shareholders, and a hint on whether a takeover defence plan
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
import calendar
import csv
import datetime as dt
import io
import json
import math
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
FIN_V = 3      # bump to read the financials again: 2 = five years (summary table + older reports for operating profit), 3 = + owners (holder categories) and prior-year holder changes
FIN_YEARS = 5
FIN_SPAN_DAYS = 45   # an older report counts as the same fiscal year if its year end is this close
MAX_OLD_READS = 3
PRICE_V = 2    # bump to read the filings again: 2 = high/low rows cut apart by a search (dashes, footnote marks, 6 columns)
OWNDEBUG = os.environ.get("JP_OWNDEBUG") == "1"   # print the rows that look like the holder-category table
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


REL = {"CurrentYearDuration": 0, "Prior1YearDuration": 1, "Prior2YearDuration": 2, "Prior3YearDuration": 3, "Prior4YearDuration": 4}
OPERATING_RE = re.compile(r"^(OperatingIncomeLoss|OperatingIncome|OperatingProfitLoss)(IFRS|USGAAP)?SummaryOfBusinessResults$")


def shift_end(end: str, k: int) -> str:
    """The same fiscal year end k years earlier; a month-end stays a month-end (29 Feb to 28 Feb)."""
    y0, m, d = int(end[:4]), int(end[5:7]), int(end[8:10])
    y = y0 - k
    last = calendar.monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-{(last if d == calendar.monthrange(y0, m)[1] else min(d, last)):02d}"


def days_apart(a: str, b: str) -> int:
    return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days)


def by_rel(rows) -> dict:
    """element id -> {relative year (0 = current): (value, 連結/個別)}; the first row of a slot wins, plain contexts only."""
    out = {}
    for r in rows:
        rel = REL.get(r[2])
        if rel is None:
            continue
        v = num(r[8])
        if v is not None:
            out.setdefault(r[0], {}).setdefault(rel, (v, r[4]))
    return out


def measure(rows, names, fuzzy, end, last=(), em=None):
    """One figure over up to five years: {relative year: value}, with the basis and element used.
    The first element found for the current year is the base (statements first, then the
    five-year summary table); later elements only fill years the base lacks, and only when they
    agree with the base for the current year (same figure, different table)."""
    em = em if em is not None else by_rel(rows)
    pool = [n for n in names if 0 in em.get(n, {})]
    if fuzzy:
        pool += [k for k in em if 0 in em[k] and fuzzy.match(k.split(":")[-1]) and k not in pool]
    if not pool:
        pool = [n for n in last if 0 in em.get(n, {})]
    if not pool:
        return None
    base = pool[0]
    vals = {rel: v for rel, (v, bs) in em[base].items() if bs == em[base][0][1]}
    basis = em[base][0][1]
    for other in pool[1:]:
        o = em[other]
        if o[0][1] != basis or abs(o[0][0] - vals[0]) > 0.01 * max(abs(vals[0]), 1):
            continue
        for rel, (v, bs) in o.items():
            if rel not in vals and bs == basis:
                vals[rel] = v
    return {"vals": {k: int(v) for k, v in vals.items()}, "basis": basis, "element": base}


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


DASHES = "―－-–—ー"
MARKS = "※■□▲△◆◇●○*＊†‡"
NUM_RE = re.compile(r"^(?!0\d)(?:\d{1,3}(?:,\d{3})+|\d{1,4})(?:\.\d{1,2})?$")
HI_LABEL = re.compile(r"最高(?:株価|価格)?\s*(?:[(（]\s*(?:円|ドル)\s*[)）]|円|〃)?\s*(?=[\d" + re.escape(DASHES + MARKS) + r"(（])")
LO_LABEL = re.compile(r"最低(?:株価|価格)?\s*(?:[(（]\s*(?:円|ドル)\s*[)）]|円|〃)?\s*(?=[\d" + re.escape(DASHES + MARKS) + r"(（])")


def _clean_segment(seg: str) -> str:
    """Keep what is left of a price row once the row label is gone: digits, commas, points, dashes (no price
    that year) and the footnote marks that sit next to a restated figure. Brackets hold the figure as first
    reported (before a split) and are dropped."""
    seg = nfkc(seg)
    cut = len(seg)
    for m in ("(注", "注)", "（注", "(※注", "【注"):
        i = seg.find(m)
        if 0 <= i < cut:
            cut = i
    seg = seg[:cut]
    seg = re.sub(r"\([^)]*\)", "", seg)
    seg = re.sub(r"\s+", "", seg)
    m = re.match(r"^[\d,." + re.escape(DASHES + MARKS) + r"]*", seg)
    return m.group(0)


def decompose(seg: str, n_slots: int, cap: int = 3000):
    """All ways to read the glued text as n_slots columns (a number or None for a dash). A footnote mark drops
    the figure just before it (that figure is the unrestated value of the column that follows)."""
    out = []

    def rec(i, vals):
        if len(out) >= cap:
            return
        live = [v for v in vals if not v[1]]
        if len(live) > n_slots:
            return
        if i == len(seg):
            if len(live) == n_slots:
                out.append([v[0] for v in live])
            return
        ch = seg[i]
        if ch in DASHES:
            rec(i + 1, vals + [(None, False)])
        elif ch in MARKS:
            if vals and vals[-1][0] is not None and not vals[-1][1]:
                rec(i + 1, vals[:-1] + [(vals[-1][0], True)])
            else:
                rec(i + 1, vals)
        elif ch.isdigit():
            for j in range(i + 1, min(len(seg), i + 11) + 1):
                sub = seg[i:j]
                if NUM_RE.match(sub) and float(sub.replace(",", "")) > 0:
                    rec(j, vals + [(float(sub.replace(",", "")), False)])
        elif ch in ",.":
            return

    rec(0, [])
    return out


def hl_candidates(rows):
    """({n_columns: (readings of the high row, readings of the low row)}, text). The high / low rows exist only
    as text inside the company-only key figures block, so the number cells are glued together and have to be
    cut apart; the reading is chosen later (smooth over the years, and against PER x EPS)."""
    for r in rows:
        if not (r[0].endswith("TextBlock") and "最高" in r[8] and "最低" in r[8]):
            continue
        t = nfkc(r[8])
        hm = HI_LABEL.search(t)
        lm = LO_LABEL.search(t, hm.end()) if hm else None
        if not lm:
            continue
        hs, ls = _clean_segment(t[hm.end():lm.start()]), _clean_segment(t[lm.end():])
        if not hs or not ls:
            continue
        out = {}
        for n_slots in (5, 6, 4, 3, 2, 1):
            his, los = decompose(hs, n_slots), decompose(ls, n_slots)
            if his and los:
                out[n_slots] = (his, los)
        return out, t
    return {}, ""


def _rough(v):
    """How jumpy a row of prices is: adjacent years rarely differ by a factor of ten, a wrong cut does."""
    xs = [x for x in v if x]
    return sum(abs(math.log(a / b)) for a, b in zip(xs, xs[1:]))


def pick_reading(cands_by_n, est_by_k, ratios):
    """Best (n, hi, lo): columns whose range holds the PER x EPS price (after a split ratio) score, a low above
    its high is rejected, and among equal readings the smoothest wins; five columns win ties."""
    scales = sorted({1, *ratios, *[x * y for x in ratios for y in ratios]})
    best, best_s = None, -1e9
    for n, (his, los) in cands_by_n.items():
        est = [est_by_k.get(n - 1 - j) for j in range(n)]
        for h in sorted(his, key=_rough)[:40]:
            for l in sorted(los, key=_rough)[:40]:
                s = -3 * _rough(h) - 3 * _rough(l) - (0 if n == 5 else 12)
                for j in range(n):
                    a, b = h[j], l[j]
                    if a is None or b is None:
                        if (a is None) != (b is None):
                            s -= 20
                        continue
                    if b > a:
                        s -= 50
                        continue
                    s -= math.log(a / b)
                    e = est[j]
                    if e is not None and any(b / c * 0.88 <= e <= a / c * 1.12 for c in scales):
                        s += 10
                if s > best_s:
                    best, best_s = (n, h, l), s
    return best


def split_events(text: str):
    ev = []
    for sent in re.split(r"(?<=。)", text):
        if "株式分割" not in sent:
            continue
        m = re.search(r"1株につき(\d+)株", sent) or re.search(r"1株を(\d+)株", sent)
        if not m:
            continue
        d = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", sent)
        rw = re.search(r"令和(\d{1,2}|元)年(\d{1,2})月(\d{1,2})日", sent)
        if d:
            date = f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}"
        elif rw:
            date = f"{2018 + (1 if rw.group(1) == '元' else int(rw.group(1)))}-{int(rw.group(2)):02d}-{int(rw.group(3)):02d}"
        else:
            date = ""
        ev.append({"ratio": int(m.group(1)), "date": date})
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

    cbn, text = hl_candidates(rows)
    events = split_events(text)
    ratios = [e["ratio"] for e in events]
    cands = sorted({1, *ratios, *[x * y for x in ratios for y in ratios]})
    est_by_k = {}
    for k in range(5):
        e_, p_ = get("eps", k), get("per", k)
        est_by_k[k] = e_ * p_ if e_ and p_ and e_ > 0 and p_ > 0 else None
    hi = lo = None
    n = 0
    if cbn:
        n, hi, lo = pick_reading(cbn, est_by_k, ratios)
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
    if not resolved and any(y.get("bad") for y in years):
        # nothing fits: PER x EPS itself is probably on a different basis, so the filing's own high/low are kept as printed
        for y in years:
            y.pop("bad", None)
        notes.append("High/low are as printed in the filing; they could not be checked against PER x EPS.")
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
    return {"kind": "jp_fy", "v": PRICE_V, "as_of": end, "basis": basis, "currency": "JPY", "est_price": est_price, "est_mcap": est_mcap,
            "per": cur["per"], "pbr": pbr, "bps": cur["bps"], "eps": cur["eps"],
            "tsr": round(tsr * 100, 1) if tsr is not None else None,
            "tsr_index": round(tsr_i * 100, 1) if tsr_i is not None else None,
            "shares_issued": issued, "shares_treasury": treas, "shares_out": shares_out,
            "years": out_years, "notes": notes, "source": "EDINET", "url": url}


def needs_price(pr) -> bool:
    """No price block yet, or one made by an older reading that left high/low holes or gave up on them."""
    if not isinstance(pr, dict):
        return True
    if pr.get("v") == PRICE_V:
        return False
    ys = pr.get("years") or []
    return not ys or any(y.get("high") is None for y in ys)         or any("did not fit" in n or "could not" in n for n in pr.get("notes", []))


_RC = {}


def cached_rows(doc_id: str) -> list:
    """A report is downloaded once per company build, even if both the financials and the prior-year holders need it."""
    if doc_id not in _RC:
        _RC[doc_id] = edinet_rows(doc_id)
    return _RC[doc_id]


def top_holders(rows) -> list:
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
    return [by_no[k] for k in sorted(by_no) if by_no[k]["name"]][:10]


def hkey(name: str) -> str:
    """Same holder across two years: NFKC, no standing-proxy bracket, no spaces."""
    t = unicodedata.normalize("NFKC", name or "")
    i = t.find("(常任代理人")
    if i >= 0:
        t = t[:i]
    return re.sub(r"\s+", "", t).lower()


# the holder-category table (所有者別状況): PercentageOfShareholdings* in the plain ordinary-share context, fractions of 1
OWN_KEYS = [("gov", "Government & municipalities"), ("financial", "Financial institutions"), ("broker", "Securities firms"),
            ("corporate", "Other corporations"), ("foreign", "Foreign investors"), ("individual", "Individuals & other (incl. treasury shares)"),
            ("treasury", "Treasury shares")]
OWN_RULES = [("treasury", re.compile(r"Treasury")), ("foreign", re.compile(r"Foreign")), ("broker", re.compile(r"FinancialInstrument|FinancialService|Securities|Broker")),
             ("financial", re.compile(r"FinancialInstitution")), ("individual", re.compile(r"IndividualsAndOthers")),
             ("gov", re.compile(r"Government|LocalPublic|PublicBod|Municipal")), ("corporate", re.compile(r"Corporation"))]


def owners_block(rows, as_of: str, url: str):
    """Shareholding by holder category, or None when the table is not readable (nothing is guessed)."""
    by_ctx = {}
    for r in rows:
        if not re.fullmatch(r"CurrentYearInstant(_OrdinaryShareMember)?", r[2]):
            continue
        name = r[0].split(":")[-1]
        if not name.startswith("PercentageOfShareholdings"):
            continue
        v = num(r[8])
        if v is None:
            continue
        key = next((k for k, rx in OWN_RULES if rx.search(name[len("PercentageOfShareholdings"):])), None)
        if key is None:
            return None                    # an element we do not know: better no band than a wrong one
        d = by_ctx.setdefault(r[2], {})
        d[key] = d.get(key, 0) + v * 100
    best = max(by_ctx.values(), key=lambda d: sum(d.values()), default=None)
    if not best or not 95 <= sum(best.values()) <= 101.5:
        return None
    cats = [{"key": k, "label_en": lab, "pct": round(best[k], 2)} for k, lab in OWN_KEYS if best.get(k, 0) > 0]
    return {"as_of": as_of, "cats": cats, "source": "EDINET", "url": url}


def fam(element: str) -> str:
    """The figure an element stands for, whether it is the statement line or its summary-table twin."""
    return element.split(":")[-1].replace("SummaryOfBusinessResults", "")


def financials(tk: str, hit: dict, rows, end: str, url: str):
    """fin block with up to FIN_YEARS years, newest first. Revenue and net profit come from the latest
    report (statements, then the five-year summary table). Operating profit is rarely in that table, so the
    statements of older reports (hit["hist"], from the index) fill the years it lacks. A year already
    filled by a newer report is never replaced by an older one."""
    em = by_rel(rows)
    metrics = {"revenue": measure(rows, REVENUE, REVENUE_RE, end, REVENUE_LAST, em),
               "operating_income": measure(rows, OPERATING, OPERATING_RE, end, (), em),
               "net_income": measure(rows, NET, None, end, (), em)}
    metrics = {k: v for k, v in metrics.items() if v}
    if not metrics:
        return None, "no figures"
    hist = [h for h in hit.get("hist", []) if h[0] != hit["doc_id"] and h[1] < end]
    # the year ends: the latest report's, then one year back at a time; where an older report in the index
    # has a year end close to it, that report's real date is used (29 Feb, a changed fiscal year end)
    targets = []
    for k in range(FIN_YEARS):
        t = shift_end(end, k)
        near = [h[1] for h in hist if days_apart(h[1], t) <= FIN_SPAN_DAYS]
        targets.append(t if k == 0 else (min(near, key=lambda x: days_apart(x, t)) if near else t))
    def slot(e):
        return next((t for t in targets if days_apart(t, e) <= FIN_SPAN_DAYS), None)
    got = {m: {targets[rel]: v for rel, v in x["vals"].items() if rel < FIN_YEARS} for m, x in metrics.items()}
    basis = {m: x["basis"] for m, x in metrics.items()}
    first = next(iter(metrics.values()))
    reads, done_docs, notes = 0, set(), []
    while reads < MAX_OLD_READS:
        miss = [t for t in targets if any(t not in got[m] for m in got)]
        pick = next((h for t in miss for h in hist if h[0] not in done_docs and days_apart(h[1], t) <= FIN_SPAN_DAYS), None)
        if not pick:
            break
        done_docs.add(pick[0])
        reads += 1
        try:
            old_rows = cached_rows(pick[0])
        except Exception as e:  # noqa: BLE001 - an older report that cannot be read just leaves gaps
            notes.append(f"{pick[1][:4]} report unreadable: {str(e)[:40]}")
            continue
        oem = by_rel(old_rows)
        for m, names, fuzzy, last in (("revenue", REVENUE, REVENUE_RE, REVENUE_LAST), ("operating_income", OPERATING, OPERATING_RE, ()),
                                      ("net_income", NET, None, ())):
            if m not in got:
                continue
            x = measure(old_rows, names, fuzzy, pick[1], last, oem)
            if not x or x["basis"] != basis[m] or fam(x["element"]) != fam(metrics[m]["element"]):
                continue
            for rel, v in x["vals"].items():
                if rel > 1:
                    continue
                t = slot(shift_end(pick[1], rel))
                if t and t not in got[m]:
                    got[m][t] = v
        time.sleep(PAUSE_S)
    fin = {"currency": "JPY", "basis": "standalone" if first["basis"] == "個別" else "consolidated"}
    for m in ("revenue", "operating_income", "net_income"):
        fin[m] = [{"end": t, "val": got[m][t]} for t in sorted(got.get(m, {}), reverse=True)][:FIN_YEARS]
    fin["source"], fin["url"] = "EDINET", url
    info = f"older reports read {reads}" + ("; " + "; ".join(notes) if notes else "")
    return fin, info


def build(tk: str, hit: dict, sector: str, hist_done: bool = False) -> dict:
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
    _RC.clear()
    _RC[hit["doc_id"]] = rows
    fin, fin_info = financials(tk, hit, rows, end, url)
    if OWNDEBUG:
        pat = re.compile(r"PercentageOfShareholdings|ShareholderCategory")
        n = 0
        for r in rows:
            if pat.search(r[0]) or pat.search(r[2]) or pat.search(r[1]):
                n += 1
                if n <= 70:
                    print(f"OWN {tk} {r[0].split(':')[-1][:70]} | {r[1][:24]} | {r[2][:60]} | {r[8][:60]!r}")
        print(f"OWN {tk} matching rows {n} of {len(rows)}")
    lst = top_holders(rows)
    holders = {"kind": "top10", "as_of": end, "list": lst, "source": "EDINET", "url": url} if lst else None
    owners = owners_block(rows, end, url)
    prev_hit = next((h for h in hit.get("hist", []) if h[0] != hit["doc_id"] and days_apart(h[1], shift_end(end, 1)) <= FIN_SPAN_DAYS), None)
    if prev_hit and (holders or owners):
        try:
            prows = cached_rows(prev_hit[0])
            plst = top_holders(prows)
            if holders and plst:
                pm = {hkey(x["name"]): x["pct"] for x in plst}
                cur_keys = {hkey(x["name"]) for x in lst}
                for x in lst:
                    x["prev_pct"] = pm.get(hkey(x["name"]))      # null = not in last year's top ten (New)
                holders["prev_as_of"] = prev_hit[1]
                holders["dropped"] = [{"name": x["name"], "prev_pct": x["pct"]} for x in plst if hkey(x["name"]) not in cur_keys]
            po = owners_block(prows, prev_hit[1], PDF.format(prev_hit[0]))
            if owners and po:
                owners["prior"] = {"as_of": po["as_of"], "cats": po["cats"], "url": po["url"]}
        except Exception as e:  # noqa: BLE001 - last year's report is a bonus
            print(f"  {tk} prior-year report: {str(e)[:60]}")
    try:
        price = price_block(rows, end, url)
    except Exception as e:  # noqa: BLE001 - the rest of the profile is still worth keeping
        price = {"kind": "jp_fy", "as_of": end, "years": [], "notes": [f"Price block failed: {str(e)[:80]}"], "source": "EDINET", "url": url}
    if DRY:
        print(f"PRICE {tk} " + json.dumps(price, ensure_ascii=False))
        if os.environ.get("JP_HLDEBUG") == "1" and not any(y.get("high") for y in price.get("years", [])):
            for r in rows:
                if "最高" in r[8] and len(r[8]) > 40:
                    i = r[8].index("最高")
                    print(f"HLDBG {tk} {r[0].split(':')[-1]} {nfkc(r[8][max(0, i - 60):i + 330])!r}")
                    break
            else:
                print(f"HLDBG {tk} no text with 最高; text blocks: " + ",".join(sorted({r[0].split(':')[-1] for r in rows if 'BusinessResults' in r[0] and 'TextBlock' in r[0]})))
    return {"market": "JP", "ticker": tk, "tv_symbol": "TSE:" + tk, "sector": sector, "fin": fin, "holders": holders,
            "defense": defense(rows, end, url), "price": price, "owners": owners, "fin_v": FIN_V, "fin_hd": bool(hist_done), "fin_info": fin_info, "doc_id": hit["doc_id"], "period_end": end, "filer": hit.get("filer", ""),
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set; nothing written")
        return 1
    idx = json.loads((DATA / "edinet_yuho.json").read_text(encoding="utf-8"))
    index, hist_done = idx["by_ticker"], bool(idx.get("hist_done"))
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
            # the five-year financials are redone once the index holds the older reports (hist_done)
            old_fin = old.get("fin_v") != FIN_V or (hist_done and not old.get("fin_hd"))
        except Exception:  # noqa: BLE001
            have, old_price, old_fin = None, None, False
        if have != hit["doc_id"] or needs_price(old_price) or DRY or bool(ONLY) or (hist_done and old_fin):
            todo.append((tk, hit))
    print(f"{len(index)} companies in the index, {len(todo)} to read")
    start, done, failed = time.time(), 0, 0
    for tk, hit in todo:
        if time.time() - start > BUDGET_S:
            print("time budget reached; the next run continues")
            break
        try:
            prof = build(tk, hit, sectors.get(tk, ""), hist_done)
            if DRY or DEBUG:
                print(f"FIN {tk} {prof.get('fin_info')} " + json.dumps(prof.get("fin"), ensure_ascii=False))
                print(f"OWNERS {tk} " + json.dumps(prof.get("owners"), ensure_ascii=False))
                print(f"HOLDERS {tk} " + json.dumps(prof.get("holders"), ensure_ascii=False))
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
