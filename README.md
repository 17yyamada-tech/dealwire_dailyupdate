# Deal Wire

A website that collects market and deal news for US, SEA, SG, JP and HK/CN, shared by link with friends.
Hosting is free: Cloudflare Pages (site) plus GitHub Actions (data). The site is private to approved readers.
URL: `https://dealwire.pages.dev/` (Cloudflare Access login). The old GitHub Pages site was switched off on 2026-10-30.
The repository stays public: the data under `docs/data/` is readable by anyone who knows the raw URL, only the site is gated.

## Hosting and access
- **Cloudflare Pages** project `dealwire`: Git-connected to this repository, no build step, output directory `docs`. Build watch paths: include `*`, exclude `docs/data/*`, so the 30-minute data commits do not use the 500 builds/month of the free plan. Only code changes rebuild.
- **Data is read from GitHub, not from Cloudflare.** Because Pages is not rebuilt on data commits, `docs/app.js` reads every `data/...` file from `https://raw.githubusercontent.com/17yyamada-tech/dealwire_dailyupdate/main/docs/data/` (`DATA_BASE`). raw sends CORS headers and caches for about 5 minutes, so new data can show up to 5 minutes late. On `localhost` / `127.0.0.1` the page reads the relative `data/` instead, so a local copy tests without GitHub.
- **Who can open the site:** Cloudflare Zero Trust → Access → Policies → `Approved readers` → Emails. Add an address there to let that person in (production and preview are both protected). People log in with a 6-digit code mailed to them.
- **Asking for access (one flow with the email digest):** a friend opens the request page `https://script.google.com/macros/s/AKfycbwkLZNyFOe8UkUWMeIw-8PDnhCLW9DsDW_llufj2kGfZwWMaAw7HSTsIHoSmvpjU6DqTw/exec?action=request`, enters an email and an optional note. The owner gets an Approve / Decline email (link → confirmation page → button). Approve makes the Apps Script add the address to `Approved readers` through the Cloudflare API and mail the person; decline does nothing else. The request log is the `AccessRequests` sheet.
- **Who gets the email digest:** only approved readers can subscribe in the site form (confirmation email → `active`). Each edition goes only to `active` subscribers who are still in `Approved readers` when it is sent, so removing someone in Cloudflare stops their email too. Owner tools in the Apps Script editor: `approveReader(email)`, `revokeReader(email)`, `pauseExistingSubscribers()`, `approveExisting(email)`, `requestApprovalForPaused()`, `setupMailTrigger()`.
- **Script properties** (Apps Script → Project settings): `SHEET_ID` (setup), `OWNER_KEY` (auto), `CF_API_TOKEN` (Cloudflare API token that can edit Access policies) and `CF_ACCOUNT_ID`, `GITHUB_TOKEN` (optional).

## How it works
| Part | Where | When |
|---|---|---|
| Fetch headlines and tag them | `fetcher/fetch.py`, run by `.github/workflows/fetch.yml` | Every 30 min |
| Site | `docs/` served by Cloudflare Pages (Access-protected) | Checks for new data every 5 min while open |
| Digest editions | Claude Code cloud Routine (`routine/digest_prompt.md`) writes `docs/data/digests/<YYYY-MM-DD-HHMM>.json` and `index.json`. Repeats are excluded and developments are marked UPDATE. | 08:30, 12:30 and 15:30 SGT |
| Email | Google Apps Script (`apps_script/Code.gs`, setup in `apps_script/SETUP_ja.md`) stores subscribers in a private Google Sheet and emails each new edition | Checks every 10 min |
| Archive for search | `docs/data/archive/YYYY-MM.json` (append-only) | With each fetch |
| Followed stories (Deals page) | Browsers send their ☆ list to the Apps Script; `fetcher/follows.py` (in fetch.yml) copies the combined list to `docs/data/follow/queue.json`; a second cloud Routine (`routine/follow_prompt.md`) writes `docs/data/follow/<id>.json` | List every 30 min, research at 08:45, 12:45 and 15:45 SGT |
| Companies page | The Apps Script keeps each browser's companies and fetches their Google News headlines itself. Nothing about companies reaches this repository. | Every 30 min |
| Sources page | Static reference in `docs/index.html` (section `#reference`): where each part comes from and how far to trust it. Keep in step with `fetcher/sources.json` and the Routines. | When a source changes |
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
  column scrolls inside it. Under each story a speech bubble, "Where it stands", gives an AI-written
  status summary (`status` in the story file: stage, latest facts, open points; English and Japanese). The research is public, in `docs/data/follow/`; which browser follows
  what is not: the Apps Script only publishes the combined list, without ids.
- **Companies**: a company name (other names after a comma) and optional keywords. The Apps Script
  searches Google News for `(names) (keywords)` in English and Japanese, adds the name in the other
  language when only one is given (LanguageApp), keeps 45 days, and returns the list only to the
  browser that registered it. This stays private because a company someone is watching can itself be
  sensitive.
  The page has two views, News (the headlines above) and Profile (a table, one row per company: sector,
  revenue, operating and net income for the latest year, revenue growth, the top three shareholders and whether a
  takeover defence was found). Opening a row loads TradingView's embedded widgets for US stocks (market cap, P/E, price and
  volume, delayed; shown by TradingView, not stored here); Tokyo-listed stocks get links to TradingView, Kabutan and Yahoo! Finance Japan instead, because the embeds do not show them and the full holder list, defence note and financials,
  each with its filing link. Figures come from EDINET (Japan) and SEC (US) through the Apps Script's `profile`
  field; a company without one shows "Profile pending". Each value carries its reliability (Official, Machine,
  Vendor; see the Sources page). Up to 15 companies per browser.
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
`fetcher/edinet.py` reads EDINET's filing index and writes `docs/data/edinet.json`, shown as one table
under the deal board: a row per case, with All / Tender offers / Stake changes buttons, 25 rows at a
time ("Show more"). A row has the date, the target (English name and ticker from the FSA code list,
the Japanese name small), a one-sentence summary, the key figures and the filing links. Pressing a row
opens it: every figure, the full holding purpose, the filer and target in both languages, and the
documents of the case. The sentence is built from the filed fields by a fixed template (English, and
Japanese with the JP button), never by AI. Small ⓘ marks explain the terms (tender offer, proposal
intent, joint holders and so on) on hover or tap.

Kept: tender offers (code 240 original, 250 amended, 260 withdrawal), their reports (270, 280), the
target's response (290 to 320) and 5% stake reports. The last run to a couple of hundred a day, nearly
all of them custody and index desks, so only filings by an investor already in `actor.Sponsor` (or
stating proposal intent) earn a row. The index leaves a stake report's target empty, so it is read from
the filing's own CSV.

**Tender offers are cases, not cards.** A document and its parent (the original it amends or reports on)
are one case, shown as one row with its documents listed (Filed, Amended, Response, Result) and a status
tag: "Open · N business days left" (weekends only; holidays ignored), "Closed · result filed", "Withdrawn".
`edinet.py` keeps every document of a case while the offer runs and for 14 days after its result (or
close), carries them over from the previous `edinet.json`, and fetches an earlier document by id when the
index no longer shows it. Case documents are not merged into one card, so the page can compare the first
and the latest: "Price raised ¥3,000 to ¥3,683" and "Extended to 12 Nov" tags come from that.
The terms are read from the CSV inside each document (the tagged text blocks):
- the offer price (`につき金N円` in the price block; the gap is an ideographic space or a comma),
  the period and its business days, the shares sought and the minimum that must be tendered, the
  resulting stake and the settlement date;
- in a tender offer report (公開買付報告書): whether it succeeded (成否 block), the shares tendered
  and bought, and the bidder's stake afterwards. A result whose outcome the text does not make clear
  is shown as "result filed" without a verdict;
- where the bid vehicle's shareholder list names a house we already treat as a sponsor, the backer.

**English names.** Every filing carries its filer's English name (DEI `提出者名（英語表記）`), which is
what the page uses for the bidder or holder; the FSA code list leaves it empty for most funds and vehicles.
Without one the NFKC-normalised Japanese name is shown as it is.

No premium. It is not a filed figure, and calculating one needs the share price before the
announcement, which this site does not collect.

Needs the repository secret `EDINET_API_KEY` (free registration at EDINET). The filings run on
their own schedule, four times a day on JST weekdays, because that is when filings land. A manual run
can take `days` (default 6; for example 190 backfills running offers) and `tob_only=1` (read tender
offers only and leave the stake rows as they are). `edinet_probe_tob.py` (workflow `edinet-probe`)
prints the labels and values inside given documents when a filing's layout needs checking.

## Company search and figures
`fetcher/company_index.py` (weekly, in fetch.yml) writes `docs/data/company_index.json`: every listed Japanese
company from the EDINET code list (securities code, name, sector) and every NYSE/Nasdaq/NYSE American/Cboe
ticker from the SEC. The Companies boxes suggest from it as you type a name or a ticker; a picked company
carries its market, ticker and (US) CIK, and its card shows the ticker, the sector and links to IR BANK,
Kabutan, Yahoo and TradingView (Japan) or Yahoo, SEC filings and TradingView (US). For a US company the
Apps Script adds the last two fiscal years' revenue, operating and net income exactly as filed in the 10-K
(SEC XBRL), weekly. No market prices are collected; the Price view below estimates them from filings.

### Companies > Price (no price feed is bought)
The third Companies view, Price, shows a card per linked company. Nothing here is a market quote.

**Japan.** `fetcher/jp_profiles.py` adds `price` to each `docs/data/jp_profiles/<ticker>.json` from the annual
securities report's key-figures table (主要な経営指標等の推移, five years, consolidated when the company has
consolidated statements, otherwise stand-alone): EPS (`BasicEarningsLossPerShare*SummaryOfBusinessResults`), PER
(`PriceEarningsRatio*SummaryOfBusinessResults`), book value per share (`NetAssetsPerShareSummaryOfBusinessResults`,
or the per-share equity line found by its label for IFRS filers), total shareholder return and the index it is
compared with (`TotalShareholderReturn`, `TotalReturnOnSharePriceIndex`, company-only context). The highest and
lowest share price of each year are not tagged separately in the filing: they exist only as text inside
`BusinessResultsOfReportingCompanyTextBlock`, so they are read from that text and each year is checked against
PER × EPS (a year that does not fit is dropped, and prices from before a stock split are divided by the split ratio to
match the restated EPS; the note says so). Shares: the year-end issued shares minus the treasury rows of the
voting-rights table. Calculated and stored: estimated year-end price = PER × EPS (empty in a loss year),
estimated market cap = that × shares outstanding, P/B = that ÷ book value per share, all dated at the fiscal year
end. Shape: `price: {kind:"jp_fy", as_of, basis, est_price, est_mcap, per, pbr, bps, eps, tsr, tsr_index,
shares_issued, shares_treasury, shares_out, years:[{fy_end, high, low, eps, bps, per, est_close}], notes[], source, url}`.
A file without `price` is read again on the next run (that is how the first fill, and any change to the
extraction, rolls over every company). Workflow inputs: `dry=1` prints the block for the given tickers and writes
nothing, `budget` sets the minutes per run.

**US.** `fetcher/us_profiles.py` adds `price: {kind:"us_float", public_float, as_of, tv_symbol, source, url}` from
the SEC frames API for `dei:EntityPublicFloat` (the market value held by non-affiliates on the last business day of the
second fiscal quarter, printed on the 10-K cover). The frame is named by calendar quarter, so the nine quarters
back are read and each company keeps its newest value.

**Page.** The cards read `data/jp_profiles` and `data/us_profiles` straight from this site (the Apps Script's copy
is only a fallback, so the Apps Script needs no change). Japan: a self-drawn SVG, one bar per year from low to
high, the estimated year-end price as a line, and the estimates below with their date. US: TradingView's one-year
chart, loaded only when the card scrolls into view, and the public float below it.

## 5% stake reports
`edinet.py` opens every 5% report once (about 200 a business day, remembered in `docs/data/edinet_seen.json`,
which also keeps the filer's English name) and keeps it when the filer is on the sponsor list or the stated
purpose includes 重要提案行為等 (proposal intent, the activist signal). The row shows the holding before and
after (group total across joint holders), the change as ▲/▼ in one neutral colour (no good or bad is implied)
and the purpose. A holder's repeated reports on one company are merged into the newest, with a count.

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

## Publishing a change to the page
Browsers may keep files for several minutes. `index.html` loads `base.css`, the skin and
`app.js` with `?v=<stamp>`, so after a change bump that stamp (three places in `index.html` and
`ASSET_V` in `app.js`) and readers get the new files on their next load.

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
