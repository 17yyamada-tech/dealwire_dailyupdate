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
| Followed stories (Deals page) | Browsers send their ☆ list to the Apps Script; `fetcher/follows.py` (in fetch.yml) copies the combined list to `docs/data/follow/queue.json`; a second cloud Routine (`routine/follow_prompt.md`) writes `docs/data/follow/<id>.json` | List every 30 min, research at 08:45, 12:45 and 15:45 SGT |
| Companies page | The Apps Script keeps each browser's companies and fetches their Google News headlines itself. Nothing about companies reaches this repository. | Every 30 min |
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

## Pages
Three pages, in the header line on wide screens and in the bottom tab bar on phones.
- **Home**: the deal board, the digest, Japan filings and the contact box. Phones show the digest with the board below it.
- **Deals**: every story this browser follows (☆). One row each, left to right: the story, its
  background (up to 12 months before) and what has happened since. Rows share one height and each
  column scrolls inside it. The research is public, in `docs/data/follow/`; which browser follows
  what is not: the Apps Script only publishes the combined list, without ids.
- **Companies**: a company name (other names after a comma) and optional keywords. The Apps Script
  searches Google News for `(names) (keywords)` in English and Japanese, adds the name in the other
  language when only one is given (LanguageApp), keeps 45 days, and returns the list only to the
  browser that registered it. This stays private because a company someone is watching can itself be
  sensitive.
  Each company is marked Fund (blue) or Corporate (amber): a guess from `data/sponsors.json` (the
  Sponsor list, written by fetch.py) and names such as "... Capital", which the reader can flip on the
  card. The same colour frames the card and boxes the company's keywords found in each headline.

Each browser has a random id (`dw.vid`) that names no one. Limits: 20 follows and 15 companies per
browser, 30 stories researched in total. A browser not seen for 60 days stops counting.
Apps Script replies are read as JSONP (`callback=`), since a script tag loads across origins.

## The board
One list, cut three ways from its header. Each control is remembered per viewer.

- **Deals only / All stories**: the board holds the items tagged `is_deal` by default. Of the
  last seven days' 1,228 stories, 442 are deals; the rest are market and macro pieces that
  "All stories" brings in.
- **Newest first / By interest**: chronological by default. By interest reorders by recency,
  deal relevance and what this viewer has been opening.
- **Today only / Last 7 days**: on a busy day the week buries the morning.

There used to be a second list, Top stories, ranked by interest across everything. Measured on
a fresh browser it repeated five of the board's top eight, and its two distinguishing features
were mostly invisible: the "for you" reasons need a reading history, and only 59% of items
carry a snippet at all. Three controls on one list say the same thing without the repetition.

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

## Contact box
Under the filings, set apart as a footnote rather than a section: a dashed rule, no panel chrome,
muted type and a narrower form in every skin. The free-text box posts to the same Apps Script as the mail sign-up, which
forwards the message to whoever owns the script (`Session.getEffectiveUser()`, so no address is
written into this public repository). An optional address becomes the Reply-To. There is a
hidden honeypot field and a cap of 40 messages a day.

Apps Script sends no CORS headers, so the page cannot read the reply: it says the message was
sent and cannot prove it. Changing `Code.gs` needs a redeploy as a new version, or the endpoint
keeps running the old code and silently answers "unknown action".

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

A story can carry several types (a fund's take-private is M&A and PE): the board row shows every
one, and each Type chip finds it. `infrastructure` counts for Infra only when it is not cloud, IT,
software or network infrastructure, and the Federal Home Loan Banks' routine debt notices on the
SEC feed are skipped (`skip_title` in `sources.json`).

In English mode (the header button reads JP) stories whose headline is in Japanese are hidden on the
board, in search and on the Companies page; followed stories stay. When "Today only" has nothing,
the board shows the last seven days and says so.

Focus is the odd one out. `rules.json` → `actor.Sponsor` lists PE houses, activists, infra and credit funds and sovereign investors; a story naming one is tagged `Sponsor`, a plain M&A headline naming none is `Strategic`, and anything with no evidence either way (filing feeds such as SEC 8-K) stays unlabelled. A Focus chip **shows only that side on the deal board**, like the other filters; it does not touch the digest. The test reads only the headline and snippet, so a deal that names no known house can land in Strategic or stay unlabelled. Japanese houses are listed as the press writes them (アパックス, 日本成長投資アライアンス), plus phrases such as ファンドが / ファンド連合 that name no house but leave no doubt.

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
