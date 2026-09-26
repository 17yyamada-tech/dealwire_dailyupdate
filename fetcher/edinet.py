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
OUT = ROOT / "docs" / "data" / "edinet.json"
CODES = Path(__file__).parent / "edinet_codes.json"
RULES = json.loads((Path(__file__).parent / "rules.json").read_text(encoding="utf-8"))

API = "https://api.edinet-fsa.go.jp/api/v2"
CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"
PDF = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/pdf/{}.pdf"
UA = {"User-Agent": "DealWire (contact: 17yyamada@gmail.com)"}
KEY = os.environ.get("EDINET_API_KEY", "")
DAYS = int(os.environ.get("EDINET_DAYS", "6"))
CODES_MAX_AGE_DAYS = 7

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
    """EDINET code -> {ja, en, ticker}. Refreshed weekly; the file is committed so the
    scheduled run does not pull 570KB from the FSA on every pass."""
    cur = {}
    if CODES.exists():
        cur = json.loads(CODES.read_text(encoding="utf-8"))
        age = (dt.date.today() - dt.date.fromisoformat(cur.get("generated", "2000-01-01"))).days
        if age < CODES_MAX_AGE_DAYS:
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
                     r[idx["証券コード"]].strip()[:4]]
    data = {"generated": dt.date.today().isoformat(), "codes": out}
    CODES.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"code list refreshed: {len(out)} companies")
    return data


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


def main() -> int:
    if not KEY:
        print("EDINET_API_KEY is not set; nothing written")
        return 1
    codes = load_codes()["codes"]
    today = dt.date.today()
    cards, days_ok = [], 0
    for back in range(DAYS):
        day = today - dt.timedelta(days=back)
        try:
            res = api("documents.json", date=day.isoformat(), type=2)
        except Exception as e:  # noqa: BLE001 - one bad day must not stop the run
            print(f"  {day}  ERROR {str(e)[:120]}")
            continue
        days_ok += 1
        rows = res.get("results") or []
        kept = 0
        for r in rows:
            kind_label = KINDS.get(r.get("docTypeCode") or "")
            if not kind_label:
                continue
            kind, label_en = kind_label
            if r.get("withdrawalStatus") != "0" or r.get("disclosureStatus") != "0":
                continue
            buyer_name = r.get("filerName") or ""
            sponsor = is_sponsor(buyer_name)
            if kind == "stake" and not sponsor:
                continue            # custody and index desks file most of these
            doc_id = r.get("docID")
            desc = r.get("docDescription") or ""
            target = party(codes, r.get("subjectEdinetCode") or "")
            if kind == "stake" and not target["name"]:
                name = issuer_from_document(doc_id)
                if name:
                    hit = next((c for c, v in codes.items() if v[0] == name), "")
                    target = party(codes, hit, name)
            cards.append({
                "id": doc_id,
                "filed": (r.get("submitDateTime") or "").replace(" ", "T") + "+09:00",
                "kind": kind,
                "type_ja": desc,
                "type_en": label_en + (" (amended)" if desc.startswith("訂正") else ""),
                "buyer": party(codes, r.get("edinetCode"), buyer_name),
                "target": target,
                "sponsor": sponsor,
                "parent": r.get("parentDocID") or "",
                "link": PDF.format(doc_id),
            })
            kept += 1
        print(f"  {day}  docs {len(rows):>4}  kept {kept}")

    if not days_ok:
        print("every day failed; leaving the existing file alone")
        return 1
    cards.sort(key=lambda c: c["filed"], reverse=True)
    OUT.write_text(json.dumps({"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "cards": cards}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    by_kind = {}
    for c in cards:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    print(f"wrote {len(cards)} cards over {days_ok} days: {by_kind}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
