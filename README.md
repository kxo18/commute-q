# Commute Queue

A personal iPhone home-screen app: daily podcast and article picks for the capstone
(Nigerian diaspora health investment and financing) and career tracks, plus running
checklists of books, films, talks, and episodes.

## What's where

| File | What it is |
|---|---|
| `data/library.json` | The one-time list (books, films, talks, episodes), topic tags, and Stories to follow |
| `data/sources.json` | Recurring sources the daily job reads, and the keywords behind each topic |
| `data/daily.json` | Picks the daily job writes each morning (don't edit by hand) |
| `data/seen.json` | Everything already picked, so nothing repeats (don't edit by hand) |
| `scripts/daily.py` | The daily job |
| `.github/workflows/daily.yml` | Runs the job around 6 AM Eastern and publishes the site |
| `index.html`, `css/`, `js/` | The app itself |
| `manifest.webmanifest`, `sw.js`, `icons/` | Home-screen app name, icon, and offline support |

## Common tasks

- **Get picks right now:** on GitHub, open **Actions → Daily picks → Run workflow**. Tick
  "Pick again" to replace today's picks.
- **Add a book or film:** add an entry to `items` in `data/library.json` (copy an existing one).
- **Add a source:** add an entry to `sources` in `data/sources.json`. Use `feed` for a site's
  RSS address, or `news` for a Google News search like `site:example.org when:7d`.
- **Progress backup:** in the app, tap the gear icon → **Back up progress**.
