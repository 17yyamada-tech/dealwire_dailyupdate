# Deal Wire

A website that collects market and deal news for US, SEA, SG and HK/CN, shared by link with friends.
Hosting is free: GitHub Pages plus GitHub Actions.
The planned public URL is `https://<github-user>.github.io/dealwire_dailyupdate/`, set by the repository name.

## How it works
| Part | Where | When |
|---|---|---|
| Fetch headlines and tag them | `fetcher/fetch.py`, run by `.github/workflows/fetch.yml` | Every 30 min |
| Site | `docs/` served by GitHub Pages | Checks for new data every 5 min while open |
| Digest editions | Claude Code cloud Routine (`routine/digest_prompt.md`) writes `docs/data/digests/<YYYY-MM-DD-HHMM>.json` and `index.json`. Repeats are excluded and developments are marked UPDATE. | 08:30, 12:30 and 15:30 SGT |
| Email | Google Apps Script (`apps_script/Code.gs`, setup in `apps_script/SETUP_ja.md`) stores subscribers in a private Google Sheet and emails each new edition | Checks every 10 min |
| Archive for search | `docs/data/archive/YYYY-MM.json` (append-only) | With each fetch |
| Learning | Each viewer's own browser (localStorage). Nothing is sent anywhere. | Profile rebuilt once a day per viewer |

Only headlines, links and short snippets are stored. Article bodies are never stored.

## Sources
- **Direct RSS**: BBC Business, CNA Business, The Business Times (Companies & Markets, Top Stories), PR Newswire M&A, SEC EDGAR 8-K (GlobeNewswire disabled: times out)
- **Via Google News**: DealStreetAsia, Infrastructure Investor, PEI Private Credit, SGX announcements (AVCJ disabled)

Notes:
- SEC requires a contact in the User-Agent. Set the repository secret `SEC_USER_AGENT` to something like `DealWire your-name your-email`.
- AVCJ is disabled in `sources.json`: its public feed and homepage stopped updating in Nov 2023.
- Mergermarket, Infralogic and Debtwire are paid services and are not included.

## Local preview
```
python fetcher/fetch.py
cd docs && python -m http.server 8765
```
Open http://127.0.0.1:8765/

## Tuning
- `fetcher/sources.json`: add or remove feeds (`url` or `gnews` query, defaults, age limit).
- `fetcher/rules.json`: keyword rules for categories, countries, sectors and deal signals. A `cs:` prefix means case-sensitive, for acronyms like US and AI. A `re:` prefix means regex.

## Changing the look
All visual design lives in one file per skin: `docs/skins/board.css` (departure board, the default) and `docs/skins/editorial.css`.
- To change the default for everyone, set `data-skin` on `<html>` and `href` of `#skin-css` in `docs/index.html`.
- Viewers can switch the look in Settings. `?skin=editorial` also works.
- To add a new look, copy one skin file, restyle it and add its name to `SKINS` in `docs/app.js`.
  The markup in `index.html` is skin-neutral, and `base.css` holds only the layout.

## Permanent links
- A digest story: `?e=<edition-id>&i=<index>`. Emails use this, so edition files must never be deleted or rewritten.
- A whole edition: `?e=<edition-id>`.
- The list of all past digests: `?view=archive`.
