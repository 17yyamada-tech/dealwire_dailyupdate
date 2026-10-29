"""EDINET deal cards.

Japan's statutory filings say who is buying what, in a way news coverage often does not.
This reads the filings index for the last few days, keeps the ones that describe a deal,
resolves the EDINET codes to company names, and writes docs/data/edinet.json.

What it does NOT do yet: read inside a filing for the offer price, the premium or the
offer period. Those live in the document itself (PDF, with XBRL/CSV alongside), which is
the next stage.

Needs the repository secret EDINET_API_KEY. Standard library only, like fetch.py.
"""
import csv
import datetime as dt
import html
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
OUT = ROOT / "docs" / "data" / "edinet.json"
CODES = Path(__file__).parent / "edinet_codes.json"
RULES = json.loads((Path(__file__).parent / "rules.json").read_text(encoding="utf-8"))

API = "https://api.edinet-fsa.go.jp/api/v2"
CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"
PDF = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/{}.pdf"
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
KEY = os.environ.get("EDINET_API_KEY", "")
DAYS = int(os.environ.get("EDINET_DAYS") or 6)
TOB_ONLY = os.environ.get("EDINET_TOB_ONLY") == "1"   # backfill: read tender offers only, keep the stake cards as they are
RETAIN_DAYS = 14        # a tender offer stays on the board this long after its result (or, with none, its close)
MAX_BACKFILL = 8        # earlier documents of a running offer fetched by id per run
CODES_MAX_AGE_DAYS = 7
SEEN = ROOT / "docs" / "data" / "edinet_seen.json"
MAX_NEW_DOCS = int(os.environ.get("EDINET_MAX_NEW_DOCS", "350"))   # 5% reports opened per run
PAUSE_S = 0.4                                                     # between document downloads

# The filing types that describe a deal. Everything else in the index is routine reporting.
KINDS = {
    "250": ("tob", "Tender offer filing"),
    "260": ("tob", "Tender offer filing"),
    "270": ("tob_result", "Tender offer result"),
    "280": ("tob_result", "Tender offer result"),
    "290": ("tob_result", "Tender offer result"),
    "300": ("opinion", "Target's response"),
    "310": ("opinion", "Target's response"),
    "320": ("opinion", "Target's response"),
    "350": ("stake", "5% stake report"),
    "360": ("stake", "5% stake report"),
}
# 5% reports run to a couple of hundred a day, nearly all of them custody and index desks.
# Only the ones filed by an investor we already recognise are worth a card.
SPONSORS = RULES.get("actor", {}).get("Sponsor", [])


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def api(path: str, **params) -> dict:
    params["Subscription-Key"] = KEY
    return json.loads(fetch(f"{API}/{path}?" + urllib.parse.urlencode(params)))


def is_sponsor(name: str) -> bool:
    low = (name or "").lower()
    for w in SPONSORS:
        if w.startswith(("cs:", "re:")):
            continue
        if not w.isascii():
            if w in name:
                return True
        elif re.search(r"(?<![a-z])" + re.escape(w.lower()) + r"(?![a-z])", low):
            return True
    return False


def load_codes() -> dict:
    """EDINET code -> [ja, en, ticker, industry, listed]. Refreshed weekly; the file is committed
    so the scheduled run does not pull 570KB from the FSA on every pass. The Companies page's
    search list (company_index.py) is built from it too."""
    cur = {}
    if CODES.exists():
        cur = json.loads(CODES.read_text(encoding="utf-8"))
        age = (dt.date.today() - dt.date.fromisoformat(cur.get("generated", "2000-01-01"))).days
        rows_ok = all(len(v) >= 5 for v in list(cur.get("codes", {}).values())[:50])
        if age < CODES_MAX_AGE_DAYS and rows_ok:
            return cur
    raw = fetch(CODELIST)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        text = z.read(z.namelist()[0]).decode("cp932", errors="replace")
    rows = list(csv.reader(io.StringIO(text)))
    header = rows[1]
    idx = {name: i for i, name in enumerate(header)}
    out = {}
    for r in rows[2:]:
        if len(r) < len(header):
            continue
        code = r[idx["ＥＤＩＮＥＴコード"]].strip()
        if not code:
            continue
        out[code] = [r[idx["提出者名"]].strip(),
                     r[idx["提出者名（英字）"]].strip(),
                     r[idx["証券コード"]].strip()[:4],
                     r[idx["提出者業種"]].strip() if "提出者業種" in idx else "",
                     r[idx["上場区分"]].strip() if "上場区分" in idx else ""]
    data = {"generated": dt.date.today().isoformat(), "codes": out}
    CODES.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"code list refreshed: {len(out)} companies")
    return data


ZEN = str.maketrans("０１２３４５６７８９（）／％，－", "0123456789()/%,-")


def csv_rows(doc_id: str) -> list:
    """The filing's tagged values as (label, value) pairs, in order. One request per document.
    A label can repeat: a 5% report lists each joint holder with the same labels."""
    raw = fetch(f"{API}/documents/{doc_id}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
    out = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for name in z.namelist():
            if not name.lower().endswith(".csv"):
                continue
            text = z.read(name).decode("utf-16", errors="replace")
            for r in csv.reader(io.StringIO(text), delimiter="\t"):
                if len(r) >= 9 and r[8].strip() not in ("", "－", "-"):
                    out.append((r[1], r[8].strip()))
    return out


def csv_values(doc_id: str) -> dict:
    """The filing's tagged values, label -> first value."""
    out = {}
    for label, value in csv_rows(doc_id):
        out.setdefault(label, value)
    return out


def pct(value: str):
    """A holding ratio as a percentage. The filings tag it as a fraction (0.1374) or, now and
    then, as a percentage already (13.74)."""
    try:
        x = float(value.translate(ZEN).replace(",", "").replace("%", "").strip())
    except ValueError:
        return None
    return round(x * 100 if x <= 1 else x, 2)


def stake_details(rows: list):
    """What a 5% report says: the holding now and in the previous report, and why it is held.

    Joint holders repeat the ratio labels, one per holder plus the group total, so the largest
    value is the group's. "重要提案行為等" in the purpose means the holder may make proposals
    to the company: the activist signal, whoever the filer is."""
    now, prev, purpose, issuer = [], [], "", ""
    for label, value in rows:
        if "株券等保有割合" in label:
            p = pct(value)
            if p is not None:
                (prev if "直前" in label else now).append(p)
        elif "保有目的" in label and not purpose:
            purpose = re.sub(r"\s+", " ", value.translate(ZEN)).strip()
        elif not issuer and ("発行者" in label or "発行会社" in label) and "名" in label:
            issuer = value
    t = {}
    if now:
        t["stake_now"] = max(now)
    if prev:
        t["stake_prev"] = max(prev)
    if purpose:
        t["purpose"] = purpose[:160]
    denied = re.search(r"重要提案行為等?を?(行う|行なう)(こと|予定)?(は|も)?(ない|ありません)|重要提案行為等?を?行わない", purpose)
    t["proposal"] = bool("重要提案行為" in purpose and not denied)
    return t, issuer


def find(values: dict, needle: str) -> str:
    for label, v in values.items():
        if needle in label:
            return v.translate(ZEN)
    return ""


def terms_of_offer(values: dict) -> dict:
    """Price, period, floor and settlement date, read out of a tender offer filing.

    The premium is deliberately absent: it is not a tagged value, and working it out needs
    the share price before the announcement, which this site does not collect. A number we
    cannot stand behind is worse than no number.
    """
    t = {}
    # the price sits in a text block: "株券普通株式１株につき　金3,683円 新株予約権証券…". The gap after
    # につき is an ideographic space or a comma, and the same label also names the price-cut clause.
    block = next((v for k, v in values.items() if "買付け等の価格" in k and "引下げ" not in k and "につき" in v), "")
    price = re.search(r"につき[\s、,]*金\s*([\d,]+)\s*円", block.translate(ZEN))
    if price:
        t["price"] = price.group(1)

    period = find(values, "買付け等の期間") or find(values, "公開買付期間")
    span = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日.{0,12}?から(\d{4})年(\d{1,2})月(\d{1,2})日.{0,12}?まで", period)
    if span:
        a, b, c, d, e, f = span.groups()
        t["opens"] = f"{a}-{int(b):02d}-{int(c):02d}"
        t["closes"] = f"{d}-{int(e):02d}-{int(f):02d}"
    days = re.search(r"\((\d+)営業日\)", period)
    if days:
        t["business_days"] = int(days.group(1))

    shares = find(values, "買付予定の株券等の数")
    nums = re.findall(r"([\d,]+)\(株\)", shares)
    if nums:
        t["shares"] = nums[0]
        if len(nums) > 1:
            t["floor"] = nums[1]

    ratio = find(values, "議決権の数の総株主等の議決権の数に占める割合")
    try:
        if ratio:
            t["stake_pct"] = round(float(ratio.replace(",", "")) * 100, 2)
    except ValueError:
        pass

    settle = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", find(values, "決済の開始日"))
    if settle:
        a, b, c = settle.groups()
        t["settles"] = f"{a}-{int(b):02d}-{int(c):02d}"

    # who is behind the bid vehicle: the filing lists its shareholders, and a name we already
    # recognise as a sponsor is exactly what the news coverage tends to leave as "a fund"
    blob = " ".join(values.values())
    # a house's name is the point; "投資ファンド" is what the news already said
    generic = {"投資ファンド", "買収ファンド", "プライベートエクイティ", "プライベート・エクイティ",
               "アクティビスト", "物言う株主", "官民ファンド", "ベンチャーキャピタル"}
    for w in SPONSORS:
        if w.startswith(("cs:", "re:")) or w.isascii() or w in generic:
            continue
        if w in blob:
            t["backer"] = w
            break
    return t


def clean_en(name: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", html.unescape(name or ""))).strip()


def filer_en(rows) -> str:
    """The filer's English name as the filing itself gives it (DEI: 提出者名（英語表記）). Often the only
    English name there is: the FSA code list leaves it empty for most funds and vehicles."""
    for label, value in rows:
        if "提出者名（英語表記）" in label:
            return clean_en(value)
    return ""


def terms_of_result(values: dict) -> dict:
    """What a tender offer report (公開買付報告書) says: whether the offer succeeded, how many shares
    came in and were bought, and the bidder's stake afterwards."""
    t = {}
    period = find(values, "公開買付期間")
    span = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日.{0,12}?から(\d{4})年(\d{1,2})月(\d{1,2})日.{0,12}?まで", period)
    if span:
        a, b, c, d, e, f = span.groups()
        t["opens"] = f"{a}-{int(b):02d}-{int(c):02d}"
        t["closes"] = f"{d}-{int(e):02d}-{int(f):02d}"
    days = re.search(r"\((\d+)営業日\)", period)
    if days:
        t["business_days"] = int(days.group(1))
    verdict = find(values, "公開買付けの成否")
    if verdict:
        if re.search(r"以上となりました|以上でありました|以上であったため|以上となったため", verdict):
            t["outcome"] = "success"
        elif re.search(r"満たなかった|満たないこととなり|満たないため|行わないこととなり|買付け等を行いません", verdict):
            t["outcome"] = "failed"
        total = re.search(r"総数\(([\d,]+)株\)", verdict)
        if total:
            t["tendered"] = total.group(1)
    counts = find(values, "買付け等を行った株券等の数")
    m = re.search(r"株券([\d,]+)\(株\)([\d,]+)\(株\)", counts)
    if m:
        t["tendered"], t["bought"] = m.group(1), m.group(2)
    for label, v in values.items():
        if "買付け等後における株券等所有割合" in label and "テキストブロック" not in label:
            p = pct(v)
            if p is not None:
                t["stake_after"] = p
            break
    return t


def issuer_from_document(doc_id: str) -> str:
    """A 5% stake report names its target inside the document, not in the index. The filing
    ships a CSV of its tagged values, so pull the issuer from there. Best effort: a card
    without a target is still a card, but a stake report without one says very little."""
    try:
        raw = fetch(f"{API}/documents/{doc_id}?" + urllib.parse.urlencode({"type": 5, "Subscription-Key": KEY}))
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for name in z.namelist():
                if not name.lower().endswith(".csv"):
                    continue
                text = z.read(name).decode("utf-16", errors="replace")
                for row in csv.reader(io.StringIO(text), delimiter="\t"):
                    if len(row) < 9:
                        continue
                    label, value = row[1], row[8].strip()
                    if value and value != "－" and ("発行者" in label or "発行会社" in label) and "名" in label:
                        return value
    except Exception as e:  # noqa: BLE001 - enrichment only
        print(f"      issuer lookup failed for {doc_id}: {str(e)[:90]}")
    return ""


def party(codes: dict, code: str, fallback_name: str = "") -> dict:
    row = codes.get(code or "")
    if not row:
        return {"code": code or "", "name": fallback_name, "name_en": "", "ticker": ""}
    return {"code": code, "name": row[0] or fallback_name, "name_en": row[1], "ticker": row[2]}


def previous_cards() -> dict:
    """The cards of the last run, by id. A running tender offer is carried over from here, and a
    document already read is not read again."""
    try:
        return {c["id"]: c for c in json.loads(OUT.read_text(encoding="utf-8")).get("cards", [])}
    except Exception:  # noqa: BLE001 - first run, or a file we cannot read
        return {}


def load_seen() -> dict:
    """Every 5% report already opened, with what it said. About two hundred arrive each business
    day and nearly all are custody desks, so each is read once and remembered, not re-read on
    every run. Pruned to the window this script looks at."""
    try:
        docs = json.loads(SEEN.read_text(encoding="utf-8")).get("docs", {})
    except Exception:  # noqa: BLE001 - first run
        docs = {}
    cutoff = (dt.date.today() - dt.timedelta(days=DAYS + 8)).isoformat()
    return {k: v for k, v in docs.items() if v.get("d", "") >= cutoff}


def offer_card(r: dict, codes: dict, prev: dict) -> dict:
    """A card for a tender offer filing, tender offer result or the target's response. The terms
    are read from the filing's own CSV once; a card that already has them keeps them."""
    kind, label_en = KINDS[r["docTypeCode"]]
    doc_id, desc = r["docID"], r.get("docDescription") or ""
    buyer_name = r.get("filerName") or ""
    old = prev.get(doc_id)
    terms, en = {}, ""
    done = old and old.get("terms") and (old["terms"].get("price") or kind != "tob") \
        and (kind != "tob_result" or old["terms"].get("outcome"))
    if done:
        terms, en = old["terms"], old["buyer"].get("name_en", "")
    elif kind in ("tob", "tob_result"):
        try:
            values = csv_values(doc_id)
            terms = terms_of_offer(values) if kind == "tob" else terms_of_result(values)
            en = filer_en(values.items())
        except Exception as e:  # noqa: BLE001 - the card is worth having without them
            print(f"      terms lookup failed for {doc_id}: {str(e)[:90]}")
        time.sleep(PAUSE_S)
    buyer = party(codes, r.get("edinetCode"), buyer_name)
    if not buyer["name_en"] and en:
        buyer["name_en"] = en
    return {
        "id": doc_id,
        "filed": (r.get("submitDateTime") or "").replace(" ", "T") + "+09:00",
        "kind": kind,
        "type_ja": desc,
        "type_en": label_en + (" (amended)" if desc.startswith("訂正") else ""),
        "buyer": buyer,
        "target": party(codes, r.get("subjectEdinetCode") or ""),
        "sponsor": is_sponsor(buyer_name),
        "parent": r.get("parentDocID") or "",
        "terms": terms,
        "link": PDF.format(doc_id),
        "filings": 1,
    }


def keep_offers(offers: list, today: dt.date) -> list:
    """Tender offer documents are grouped by case (a document and its parent are the same case)
    and a case stays while it is running or for RETAIN_DAYS after its result (or, with no
    result, its close). The board shows one case once, so its history must not be pushed out."""
    uf = {}

    def root(x):
        while uf.setdefault(x, x) != x:
            uf[x] = uf[uf[x]]
            x = uf[x]
        return x

    for c in offers:
        if c["parent"]:
            uf[root(c["id"])] = root(c["parent"])
        else:
            root(c["id"])
    cases = {}
    for c in offers:
        cases.setdefault(root(c["id"]), []).append(c)
    cutoff = (today - dt.timedelta(days=RETAIN_DAYS)).isoformat()
    out = []
    for docs in cases.values():
        results = [c["filed"][:10] for c in docs if c["kind"] == "tob_result"]
        closes = [c["terms"].get("closes", "") for c in docs]
        ref = max(results) if results else (max(closes) or max(c["filed"][:10] for c in docs))
        if ref >= cutoff:
            out.extend(docs)
    return out


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set; nothing written")
        return 1
    codes = load_codes()["codes"]
    prev = previous_cards()
    seen = load_seen()
    opened = waiting = 0
    today = dt.date.today()
    cards, offers, days_ok = [], [], 0
    index = {}      # day -> that day's index rows, for finding an earlier document by id
    for back in range(DAYS):
        day = today - dt.timedelta(days=back)
        try:
            res = api("documents.json", date=day.isoformat(), type=2)
        except Exception as e:  # noqa: BLE001 - one bad day must not stop the run
            print(f"  {day}  ERROR {str(e)[:120]}")
            continue
        days_ok += 1
        rows = index[day.isoformat()] = res.get("results") or []
        kept = 0
        for r in rows:
            kind_label = KINDS.get(r.get("docTypeCode") or "")
            if not kind_label:
                continue
            kind, label_en = kind_label
            if r.get("withdrawalStatus") != "0" or r.get("disclosureStatus") != "0":
                continue
            if kind != "stake":
                offers.append(offer_card(r, codes, prev))
                kept += 1
                continue
            if TOB_ONLY:
                continue
            buyer_name = r.get("filerName") or ""
            sponsor = is_sponsor(buyer_name)
            doc_id = r.get("docID")
            desc = r.get("docDescription") or ""
            target = party(codes, r.get("subjectEdinetCode") or "")
            # Kept when the filer is a house we know, or when the filing itself says it may
            # make proposals: that catches activists nobody has put on the list yet.
            doc = seen.get(doc_id)
            if doc is None or (doc["keep"] and "b" not in doc):
                if opened >= MAX_NEW_DOCS:
                    waiting += 1          # the next run picks these up
                    if doc is None:
                        continue
                else:
                    try:
                        rows5 = csv_rows(doc_id)
                        t, issuer = stake_details(rows5)
                    except Exception as e:  # noqa: BLE001 - not remembered, so retried next run
                        print(f"      stake lookup failed for {doc_id}: {str(e)[:90]}")
                        if doc is None:
                            continue
                    else:
                        opened += 1
                        time.sleep(PAUSE_S)
                        if doc is None:
                            doc = seen[doc_id] = {"d": day.isoformat(), "keep": bool(sponsor or t.get("proposal")), "t": t, "i": issuer}
                        doc["b"] = filer_en(rows5)       # the filer's English name, as the filing gives it
            if not doc["keep"]:
                continue
            terms = doc["t"]
            if not target["name"] and doc.get("i"):
                hit = next((c for c, v in codes.items() if v[0] == doc["i"]), "")
                target = party(codes, hit, doc["i"])
            buyer = party(codes, r.get("edinetCode"), buyer_name)
            if not buyer["name_en"] and doc.get("b"):
                buyer["name_en"] = doc["b"]
            cards.append({
                "id": doc_id,
                "filed": (r.get("submitDateTime") or "").replace(" ", "T") + "+09:00",
                "kind": kind,
                "type_ja": desc,
                "type_en": label_en + (" (amended)" if desc.startswith("訂正") else ""),
                "buyer": buyer,
                "target": target,
                "sponsor": sponsor,
                "parent": r.get("parentDocID") or "",
                "terms": terms,
                "link": PDF.format(doc_id),
            })
            kept += 1
        print(f"  {day}  docs {len(rows):>4}  kept {kept}")

    if not days_ok:
        print("every day failed; leaving the existing file alone")
        return 1
    SEEN.write_text(json.dumps({"docs": seen}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"5% reports: opened {opened} new, {waiting} left for the next run, {len(seen)} remembered")

    # One stake campaign files repeatedly (a stake plus its changes): keep the newest filing per
    # holder/company and say how many there were. Tender offers are not merged: their documents
    # are the history the page shows (original, amendments, result).
    cards.sort(key=lambda c: c["filed"], reverse=True)
    merged, firsts = [], {}
    for c in cards:
        k = (c["buyer"]["code"], c["target"]["code"] or c["target"]["name"], c["kind"])
        if k in firsts:
            firsts[k]["filings"] += 1
            if not firsts[k]["terms"] and c["terms"]:
                firsts[k]["terms"] = c["terms"]
            continue
        c["filings"] = 1
        firsts[k] = c
        merged.append(c)
    cards = merged
    if TOB_ONLY:
        cards = [c for c in prev.values() if c["kind"] == "stake"]

    # Running offers outlive the few days this run looks at: carry them over, then fetch the
    # earlier documents of a case (the original behind an amendment) that the index no longer shows.
    have = {c["id"] for c in offers}
    offers += [c for c in prev.values() if c["kind"] != "stake" and c["id"] not in have]
    have = {c["id"] for c in offers}
    fetched = 0
    for c in list(offers):
        pid = c["parent"]
        if not pid or pid in have or fetched >= MAX_BACKFILL:
            continue
        fetched += 1
        have.add(pid)
        try:
            values = csv_values(pid)
            day = find(values, "提出日、表紙")[:10]
            if day not in index:
                index[day] = api("documents.json", date=day, type=2).get("results") or []
            row = next((r for r in index[day] if r.get("docID") == pid and KINDS.get(r.get("docTypeCode") or "")), None)
            if row and row.get("withdrawalStatus") == "0":
                offers.append(offer_card(row, codes, prev))
                print(f"      fetched earlier document {pid} ({day})")
        except Exception as e:  # noqa: BLE001 - history is a bonus
            print(f"      earlier document {pid} not fetched: {str(e)[:90]}")
    offers = keep_offers(offers, today)
    cards = cards + offers
    cards.sort(key=lambda c: c["filed"], reverse=True)
    OUT.write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "cards": cards}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    by_kind = {}
    for c in cards:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    priced = sum(1 for c in cards if c["terms"].get("price"))
    outcomes = sum(1 for c in cards if c["terms"].get("outcome"))
    english = sum(1 for c in cards if c["buyer"].get("name_en"))
    print(f"wrote {len(cards)} cards over {days_ok} days: {by_kind} | offer price {priced}, result outcome {outcomes}, filer English name {english}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
