"""Deal Wire fetcher.

Pulls headlines from the configured sources, tags them (category / country / sector),
and writes:
  docs/data/latest.json          last 7 days, newest first (what the app loads first)
  docs/data/archive/YYYY-MM.json every item ever seen, one file per month (search)
  docs/data/archive/index.json   list of archive months
Standard library only, so it runs unchanged on GitHub Actions or locally.
Stores headline + link + short snippet only (never full article text).
"""
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
ARCHIVE = DATA / "archive"
RULES = json.loads((Path(__file__).parent / "rules.json").read_text(encoding="utf-8"))
SOURCES = json.loads((Path(__file__).parent / "sources.json").read_text(encoding="utf-8"))

UA = os.environ.get("DEALWIRE_UA", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
SEC_UA = os.environ.get("SEC_USER_AGENT", "DealWire personal-research-reader")
LATEST_DAYS = 7
SNIPPET_MAX = 280


def gnews(query: str) -> str:
    return "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": query, "hl": "en-SG", "gl": "SG", "ceid": "SG:en"})


def fetch(url: str, sec: bool = False) -> bytes:
    headers = {"User-Agent": SEC_UA if sec else UA,
               "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*"}
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - one bad feed must not stop the run
            last = e
            time.sleep(2 + attempt * 3)
    raise last


def clean(text: str) -> str:
    text = html.unescape(html.unescape(text or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_date(s: str):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%f%z", "%a, %d %b %Y %H:%M %z"):
        try:
            d = dt.datetime.strptime(s, fmt)
            if d.tzinfo is None:
                d = d.replace(tzinfo=dt.timezone.utc)
            return d.astimezone(dt.timezone.utc)
        except ValueError:
            continue
    return None


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_feed(raw: bytes):
    """Yield dicts with title/link/summary/published from RSS 2.0 or Atom."""
    root = ET.fromstring(raw)
    for el in root.iter():
        name = local(el.tag)
        if name not in ("item", "entry"):
            continue
        rec = {"title": "", "link": "", "summary": "", "published": "", "source": ""}
        for ch in el:
            n = local(ch.tag)
            if n == "title":
                rec["title"] = clean(ch.text)
            elif n == "link":
                rec["link"] = (ch.get("href") or ch.text or "").strip() or rec["link"]
            elif n in ("description", "summary", "content") and not rec["summary"]:
                rec["summary"] = clean(ch.text)
            elif n in ("pubDate", "published", "updated") and not rec["published"]:
                rec["published"] = (ch.text or "").strip()
            elif n == "source":
                rec["source"] = clean(ch.text)
        if rec["title"] and rec["link"]:
            yield rec


def has_any(text: str, words, orig: str = "") -> bool:
    """text is lower-cased; 'cs:' words match case-sensitively against orig (acronyms like US, AI)."""
    for w in words:
        if w.startswith("cs:"):
            if re.search(r"(?<![A-Za-z])" + re.escape(w[3:]) + r"(?![A-Za-z$])", orig):
                return True
        elif w.startswith("re:"):
            if re.search(w[3:], text, re.I):
                return True
        elif re.search(r"(?<![a-z])" + re.escape(w.lower()) + r"(?![a-z])", text):
            return True
    return False


def tag(item: dict, src: dict) -> dict:
    orig = item["title"] + " " + item["summary"]
    text = orig.lower()
    # M&A / PE are judged on the headline only: snippets mention "sale" or "stake" too loosely
    title = item["title"]
    cats = [c for c, words in RULES["category"].items()
            if (has_any(title.lower(), words, title) if c in ("M&A", "PE") else has_any(text, words, orig))]
    countries = [c for c, words in RULES["country"].items() if has_any(text, words, orig)]
    if not countries:
        countries = list(src.get("country_default", []))
    if "SG" in countries and "SEA" not in countries:
        countries.append("SEA")  # Singapore is part of Southeast Asia: SEA filter includes it
    sectors = [s for s, words in RULES["sector"].items() if has_any(text, words, orig)]
    for c in src.get("category_default", []):
        if c not in cats:
            cats.append(c)
    money = bool(re.search(r"(us\$|s\$|\$|£|€)\s?\d[\d.,]*\s?(m|mn|b|bn|million|billion)\b", text)) or \
        bool(re.search(r"\d[\d.,]*\s?(million|billion)\b", text))
    deal_verb = has_any(text, RULES["deal_signals"], orig)
    core = set(cats) & {"M&A", "PE"}
    financing = set(cats) & {"Credit", "Infra"}
    ecm = has_any(title.lower(), ["ipo", "listing", "offering", "offerings", "placement", "rights issue", "float", "debut"], title) and money
    is_deal = bool(deal_verb and (core or (financing and money))) or ecm or src.get("always_deal", False)
    # Who is on the deal: a financial sponsor (PE house, activist, infra/credit fund) or a
    # corporate buyer. Headline-only detection misses some sponsors, so this axis only
    # re-orders the list in the app; it never filters anything out.
    sponsor = has_any(text, RULES.get("actor", {}).get("Sponsor", []), orig)
    # "Strategic" needs a real M&A headline with no sponsor named. Filing feeds (8-K) are deals
    # by source, not by headline, and say nothing about who is buying: those stay unlabelled.
    strategic = bool(deal_verb and core)
    actor = "Sponsor" if sponsor else ("Strategic" if strategic else "")
    return {"categories": cats, "countries": countries, "sectors": sectors[:3] or ["Other"],
            "is_deal": is_deal, "has_amount": money, "actor": actor}


def norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def item_id(link: str, title: str) -> str:
    return hashlib.sha1((norm_title(title)[:120]).encode()).hexdigest()[:14]


def sec_filter(rec: dict) -> dict | None:
    """SEC current 8-K feed: keep deal-relevant items only, rewrite into a readable headline."""
    s = rec["summary"]
    items = set(re.findall(r"Item (\d\.\d\d)", s))
    labels = {"1.01": "entry into a material definitive agreement",
              "2.01": "completion of an acquisition or disposition",
              "1.02": "termination of a material agreement",
              "2.03": "a new direct financial obligation (debt)"}
    hit = [k for k in ("2.01", "1.01", "2.03", "1.02") if k in items]
    if not hit:
        return None
    company = re.sub(r"^8-K\s*-\s*", "", rec["title"])
    company = re.sub(r"\s*\(\d{6,}\)\s*\((Filer|Subject)\)\s*$", "", company).strip()
    rec["title"] = f"{company.title() if company.isupper() else company} files 8-K: {labels[hit[0]]}"
    rec["summary"] = "SEC filing items: " + ", ".join(f"Item {k}" for k in sorted(items))
    rec["_sec_items"] = hit
    return rec


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    fresh, status = [], {}
    for src in SOURCES:
        if src.get("disabled"):
            continue
        url = gnews(src["gnews"]) if src.get("gnews") else src["url"]
        try:
            raw = fetch(url, sec=src.get("sec", False))
            recs = list(parse_feed(raw))
            kept = 0
            for rec in recs[: src.get("max", 60)]:
                if src.get("sec"):
                    rec = sec_filter(rec)
                    if not rec:
                        continue
                title = rec["title"]
                if src.get("gnews"):
                    # Google News appends " - Publisher"; keep the headline only
                    title = re.sub(r"\s+-\s+[^-]{2,60}$", "", title).strip()
                    rec["summary"] = ""  # GN summaries just repeat the headline
                if any(re.search(p, title, re.I) for p in src.get("skip_title", [])):
                    continue
                pub = parse_date(rec["published"]) or now
                if pub > now + dt.timedelta(hours=1):
                    pub = now
                if (now - pub).days > src.get("max_age_days", 10):
                    continue
                item = {
                    "id": item_id(rec["link"], title),
                    "title": title,
                    "link": rec["link"],
                    "snippet": rec["summary"][:SNIPPET_MAX] + ("…" if len(rec["summary"]) > SNIPPET_MAX else ""),
                    "source": src["name"],
                    "source_id": src["id"],
                    "published": pub.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "fetched": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                item.update(tag({"title": title, "summary": rec["summary"]}, src))
                fresh.append(item)
                kept += 1
            status[src["id"]] = {"ok": True, "items": kept}
        except Exception as e:  # noqa: BLE001
            status[src["id"]] = {"ok": False, "error": str(e)[:160]}
        time.sleep(1)

    # merge into monthly archive (first sighting wins; archive is append-only)
    months = {}
    for it in fresh:
        months.setdefault(it["published"][:7], []).append(it)
    all_seen = {}
    index = load_json(ARCHIVE / "index.json", {"months": []})
    for m in sorted(set(index["months"]) | set(months)):
        existing = load_json(ARCHIVE / f"{m}.json", [])
        by_id = {x["id"]: x for x in existing}
        added = 0
        for it in months.get(m, []):
            if it["id"] not in by_id and it["id"] not in all_seen:
                by_id[it["id"]] = it
                added += 1
        if m in months:
            rows = sorted(by_id.values(), key=lambda x: x["published"], reverse=True)
            (ARCHIVE / f"{m}.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
                                               encoding="utf-8")
        all_seen.update(by_id)
    index["months"] = sorted(set(index["months"]) | set(months), reverse=True)
    (ARCHIVE / "index.json").write_text(json.dumps(index), encoding="utf-8")

    cutoff = (now - dt.timedelta(days=LATEST_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    latest = sorted((x for x in all_seen.values() if x["published"] >= cutoff),
                    key=lambda x: x["published"], reverse=True)
    out = {"updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "sources": status, "items": latest}
    (DATA / "latest.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    ok = sum(1 for s in status.values() if s["ok"])
    print(f"sources ok {ok}/{len(status)} | fetched {len(fresh)} | latest {len(latest)} | months {index['months']}")
    for k, s in status.items():
        print(f"  {k:<22} {'ok ' + str(s['items']) if s['ok'] else 'ERR ' + s['error']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
