"""Copy the list of followed stories from the Apps Script into docs/data/follow/queue.json.

Readers follow a story with ☆. Their browsers send the list to the Apps Script (apps_script/Code.gs),
which answers ?action=follows with every followed story and no viewer ids. The follow-up Routine
reads queue.json and writes its research next to it. Standard library only; runs in fetch.yml.
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "follow" / "queue.json"


def endpoint() -> str:
    # one place for the URL: the page's own setting
    m = re.search(r'MAIL_ENDPOINT = "([^"]+)"', (ROOT / "docs" / "app.js").read_text(encoding="utf-8"))
    return m.group(1) if m else ""


def main() -> int:
    url = endpoint()
    if not url:
        print("follows: no endpoint configured")
        return 0
    req = urllib.request.Request(url + "?action=follows", headers={"User-Agent": "Mozilla/5.0 (DealWire follow list)"})
    data, err = None, None
    for _ in range(3):   # Apps Script answers the odd request from a data centre with a 404; ask again
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except Exception as e:
            err = e
            time.sleep(5)
    if data is None:  # the news fetch must not fail because of this
        print(f"follows: could not read the list ({err})")
        return 0
    stories = data.get("stories")
    if not isinstance(stories, list):
        print("follows: unexpected reply")
        return 0
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if old.get("stories") == stories:
        print(f"follows: unchanged ({len(stories)} stories)")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated": data.get("generated_at"), "stories": stories}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"follows: {len(stories)} stories")
    return 0


if __name__ == "__main__":
    sys.exit(main())
