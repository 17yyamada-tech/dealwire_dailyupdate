# Deal Wire

A website that collects market and deal news for US, SEA, SG, JP and HK/CN, shared by link with friends.
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
- **Via Google News, in Japanese**: `jp_ma` (buyouts, TOB, share acquisitions), `jp_pe` (funds, take-privates, MBO, activists), `jp_disclosure` (timely disclosures, third-party allotments)

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
- `fetcher/rules.json`: keyword rules for categories, countries, sectors, deal signals and sponsors. A `cs:` prefix means case-sensitive, for acronyms like US and AI. A `re:` prefix means regex.

## The two lists
They answer different questions, and both are on the home page.

- **Live deal board**: only items tagged `is_deal`, newest first, no personal ranking. It is a
  wire: what has been reported, in the order it arrived. The head switches it between the last
  seven days and today only, and "Show all deals" opens the rest.
- **Top stories**: everything, deals and general market news alike, ranked by recency, deal
  relevance and what this viewer has been opening. It answers "what should I read", where the
  board answers "what happened".

## Japan filings
`fetcher/edinet.py` reads EDINET's filing index and writes `docs/data/edinet.json`, shown as a
shelf of cards under the deal board. A card names the target (English name and ticker, from the
FSA's own code list), the bidder and the filing type, and links to the filing PDF.

Kept: tender offers and their amendments and results, the target's response, and 5% stake
reports. The last run to a couple of hundred a day, nearly all of them custody and index desks,
so only filings by an investor already in `actor.Sponsor` earn a card. The index leaves those
reports' target empty, so it is read from the filing's own CSV.

A tender offer card also carries the filed terms, read from the CSV that ships inside the
document: the offer price, the period and its business days, the shares sought and the
minimum that must be tendered, the resulting stake and the settlement date. Where the bid
vehicle's shareholder list names a house we already treat as a sponsor, the card names the
backer too, which is usually the part the news leaves as "an investment fund".

No premium. It is not a filed figure, and calculating one needs the share price before the
announcement, which this site does not collect.

Needs the repository secret `EDINET_API_KEY` (free registration at EDINET). The filings run on
their own schedule, four times a day on JST weekdays, because that is when filings land.

## Language
The header button switches **the digest's summaries** into Japanese, and the choice is
remembered per viewer. Only two pieces change: each story's summary and its "why it matters"
line, which the Routine writes in both languages (`summary_ja`, `why_it_matters_ja`).

Everything else stays in English, on purpose. Headlines are never translated: a digest
headline is the editor's own line and stays as written, and a feed headline belongs to the
outlet that published it. Editions published before the Japanese fields existed fall back to
the English text rather than rendering empty.

Japanese text needs different handling in four places, all of them already wired: the id hash
(`norm_title`), keyword matching (`has_any` drops the ASCII letter boundaries), headline
de-duplication (`tokenSet` falls back to character pairs) and what the ranking learns
(`keywords` reads katakana runs and kanji compounds). Amounts in 億円 and 兆円 count as figures.

## Filters
Three axes, one labelled row each: **Region** (US / SEA / SG / JP / HK/CN), **Type** and **Focus**.

Focus is the odd one out. `rules.json` → `actor.Sponsor` lists PE houses, activists, infra and credit funds and sovereign investors; a story naming one is tagged `Sponsor`, a plain M&A headline naming none is `Strategic`, and anything with no evidence either way (filing feeds such as SEC 8-K) stays unlabelled. Because that test only reads the headline it misses some deals, so the Focus chips **lift matching deals to the top of the list instead of filtering the rest away**. Region, Type and Sector do filter.

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
