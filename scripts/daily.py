#!/usr/bin/env python3
"""Daily picks for Commute Queue.

Reads every source in data/sources.json, tags items by topic keywords, and adds one
day of picks to data/daily.json: for each track (capstone, career) a new episode, an
older episode, and up to three articles. Everything picked is remembered in
data/seen.json so it never comes back. New items that mention a "Story to follow"
are attached to that story.

  python3 scripts/daily.py             normal run: skips before 6 AM Eastern or if today is done
  python3 scripts/daily.py --force     pick today again
  python3 scripts/daily.py --dry-run   print the picks, write nothing

Standard library only, so it runs anywhere Python 3.9+ does.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import random
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
EASTERN = ZoneInfo('America/New_York')
UA = 'Mozilla/5.0 (compatible; CommuteQueue/1.0; personal RSS reader)'

READS_PER_TRACK = 3
KEEP_DAYS = 60          # days of history kept in daily.json
MAX_PER_STORY = 8       # auto-attached items kept per story
ARCHIVE_AGE = 90        # an "older" episode is at least this many days old
STORY_WINDOW = 30       # only attach items published within this many days

ITUNES = '{http://www.itunes.com/dtds/podcast-1.0.dtd}'
ATOM = '{http://www.w3.org/2005/Atom}'
DC = '{http://purl.org/dc/elements/1.1/}'


def load(name, default):
    p = DATA / name
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')


def short_hash(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:10]


# ── Keyword matching ──────────────────────────────────────────

def compile_words(words):
    """ALL-CAPS words match case-sensitively; a trailing * matches any ending; plurals match."""
    pats = []
    for w in words:
        prefix = w.endswith('*')
        w = w.rstrip('*')
        body = re.escape(w).replace(r'\ ', r'[\s-]+')
        tail = r'' if prefix else r'(?:s|es)?(?![\w])'
        flags = 0 if (w.isupper() and len(w) <= 8) else re.IGNORECASE
        pats.append(re.compile(r'(?<![\w])' + body + tail, flags))
    return pats


def any_match(pats, text):
    return any(p.search(text) for p in pats)


# ── Fetching + parsing ────────────────────────────────────────

def feed_url(src):
    if 'news' in src:
        q = urllib.parse.urlencode({'q': src['news'], 'hl': 'en-US', 'gl': 'US', 'ceid': 'US:en'})
        return 'https://news.google.com/rss/search?' + q
    return src['feed']


def fetch(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


BAD_ENTITY = re.compile(rb'&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)')


def parse_xml(raw):
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        # Some feeds (Brookings) use HTML entities like &nbsp; that XML doesn't define.
        return ET.fromstring(BAD_ENTITY.sub(b'&amp;', raw))


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace('Z', '+00:00'))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def entries(root):
    items = root.findall('.//item')
    for it in items:
        yield {
            'title': it.findtext('title') or '',
            'link': (it.findtext('link') or '').strip(),
            'guid': (it.findtext('guid') or '').strip(),
            'date': parse_date(it.findtext('pubDate') or it.findtext(DC + 'date')),
            'summary': it.findtext('description') or it.findtext(ITUNES + 'summary') or '',
            'extra': ' '.join([c.text or '' for c in it.findall('category')] + [it.findtext(ITUNES + 'keywords') or '']),
            'duration': it.findtext(ITUNES + 'duration'),
        }
    if items:
        return
    for e in root.findall(ATOM + 'entry'):
        link = e.find(ATOM + "link[@rel='alternate']")
        if link is None:
            link = e.find(ATOM + 'link')
        yield {
            'title': e.findtext(ATOM + 'title') or '',
            'link': link.get('href', '').strip() if link is not None else '',
            'guid': (e.findtext(ATOM + 'id') or '').strip(),
            'date': parse_date(e.findtext(ATOM + 'published') or e.findtext(ATOM + 'updated')),
            'summary': e.findtext(ATOM + 'summary') or e.findtext(ATOM + 'content') or '',
            'extra': ' '.join(c.get('term', '') for c in e.findall(ATOM + 'category')),
            'duration': None,
        }


TAG_RE = re.compile(r'<[^>]+>')


def clean(s):
    s = html.unescape(TAG_RE.sub(' ', html.unescape(s or '')))
    return re.sub(r'\s+', ' ', s).strip()


def tidy_summary(s):
    s = re.sub(r'^Send us (?:a text|Fan Mail)\s*', '', s, flags=re.I)
    s = re.sub(r'The post .* appeared first on .*$', '', s).strip()
    return s[:240].rsplit(' ', 1)[0] + '…' if len(s) > 240 else s


def tidy_title(t, src):
    t = clean(t)
    if 'news' in src and ' - ' in t:
        t = t.rsplit(' - ', 1)[0]           # Google News appends " - Source"
    if src['kind'] == 'podcast' and ' | ' in t:
        t = t.split(' | ', 1)[0]            # "Title | A Conversation With …"
    for sep in (' | ', ' - '):              # "Title | Out-Of-Pocket"
        if t.lower().endswith((sep + src['name']).lower()):
            t = t[: -len(sep + src['name'])]
    return t.strip()


def minutes(d):
    if not d:
        return None
    try:
        parts = [int(float(x)) for x in d.strip().split(':')]
    except ValueError:
        return None
    secs = 0
    for p in parts:
        secs = secs * 60 + p
    return round(secs / 60) or None


def norm_title(t):
    return re.sub(r'[^a-z0-9]+', ' ', t.lower()).strip()


# ── Building candidates ───────────────────────────────────────

class Tagger:
    def __init__(self, tags, keywords):
        self.tags = tags
        self.order = list(tags)
        self.pats = {t: compile_words(keywords.get(t, [])) for t in tags}

    def match(self, text, tracks):
        return [t for t in self.order if self.tags[t]['track'] in tracks and any_match(self.pats[t], text)]


def build(src, e, tagger):
    kind = 'episode' if src['kind'] == 'podcast' else 'article'
    title = tidy_title(e['title'], src)
    if not title:
        return None
    if src.get('_exclude') and src['_exclude'].search(title):
        return None
    full = '' if 'news' in src else clean(e['summary'])   # Google News descriptions are just the title again
    text = ' '.join([title, full, e['extra']])
    if src.get('_require') and not any_match(src['_require'], text):
        return None
    matched = tagger.match(text, src['tracks'])
    if src['mode'] == 'filter' and not matched:
        return None
    tags = matched or list(src.get('tags', []))
    tracks = sorted({tagger.tags[t]['track'] for t in tags} & set(src['tracks'])) or list(src['tracks'])

    key = (e['guid'] or e['link']) if kind == 'episode' else (e['link'] or e['guid'])
    key = key or f"{src['id']}:{title}"
    item = {
        'id': ('e-' if kind == 'episode' else 'a-') + short_hash(key),
        'kind': kind,
        'title': title,
        'url': e['link'] or None,
        'date': e['date'].astimezone(EASTERN).date().isoformat() if e['date'] else None,
        'summary': tidy_summary(full),
        'tags': tags,
        'tracks': tracks,
    }
    if kind == 'episode':
        item['show'] = src['name']
        m = minutes(e['duration'])
        if m:
            item['minutes'] = m
    else:
        item['source'] = src['name']
    # private fields, stripped before saving
    item['_src'] = src['id']
    item['_dt'] = e['date']
    item['_score'] = len(matched)
    item['_archive'] = src.get('archive', True)
    item['_tkey'] = 't-' + short_hash(norm_title(title))
    item['_text'] = text
    return item


def public(item):
    return {k: v for k, v in item.items() if not k.startswith('_') and v not in (None, '')}


def collect(sources, tagger):
    def one(src):
        try:
            root = parse_xml(fetch(feed_url(src)))
            items = [x for x in (build(src, e, tagger) for e in entries(root)) if x]
            return src, items, None
        except Exception as err:  # one bad feed must not stop the rest
            return src, [], f'{type(err).__name__}: {err}'[:160]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(one, sources))

    items, status, titles = [], [], set()
    for src, got, err in results:
        kept = 0
        for it in got:
            if it['_tkey'] in titles:       # same story from two feeds
                continue
            titles.add(it['_tkey'])
            items.append(it)
            kept += 1
        status.append({'id': src['id'], 'name': src['name'], 'ok': err is None, 'count': kept, **({'error': err} if err else {})})
        print(f"  {'ok ' if err is None else 'ERR'} {src['name']:<36} {kept:>4} kept" + (f'  ({err})' if err else ''))
    return items, status


# ── Picking ───────────────────────────────────────────────────

def age(item, now):
    return now - item['_dt'] if item['_dt'] else None


def unseen(items, seen):
    return [i for i in items if i['id'] not in seen and i['_tkey'] not in seen]


def within(items, now, days):
    out = []
    for i in items:
        a = age(i, now)
        if a is not None and timedelta(days=-1) <= a <= timedelta(days=days):
            out.append(i)
    return out


def pick_articles(pool, n, seen, now):
    fresh = unseen(pool, seen)
    cand = []
    for days in (3, 7, 14, 30):
        cand = within(fresh, now, days)
        if len(cand) >= n:
            break
    cand.sort(key=lambda i: (i['_score'], i['_dt']), reverse=True)
    picked, sources = [], set()
    for i in cand:                          # first pass: one per source
        if len(picked) == n:
            break
        if i['_src'] not in sources:
            picked.append(i)
            sources.add(i['_src'])
    for i in cand:
        if len(picked) == n:
            break
        if i not in picked:
            picked.append(i)
    return picked


def pick_new_episode(pool, seen, now, recent_shows):
    fresh = unseen(pool, seen)
    for days in (7, 21, 45):
        cand = within(fresh, now, days)
        if cand:
            cand.sort(key=lambda i: (i['_src'] not in recent_shows, i['_score'], i['_dt']), reverse=True)
            return cand[0]
    return None


def pick_old_episode(pool, library_eps, seen, now, rng):
    for ep in library_eps:                  # your own one-time list comes first
        if ep['id'] not in seen:
            return ep
    fresh = [i for i in unseen(pool, seen) if i['_archive']]
    for min_age in (ARCHIVE_AGE, 30):
        old = [i for i in fresh if age(i, now) is not None and age(i, now) > timedelta(days=min_age)]
        if old:
            return rng.choices(old, weights=[1 + 3 * i['_score'] for i in old])[0]
    return None


def attach_stories(stories, items, radar, now, today):
    recent = within(items, now, STORY_WINDOW)
    for s in stories:
        pats = compile_words(s.get('keywords', []))
        need = compile_words(s.get('require', []))
        have = {x['id'] for x in radar.get(s['id'], [])}
        hits = [i for i in recent if i['id'] not in have and any_match(pats, i['_text'])
                and (not need or any_match(need, i['_text']))]
        hits.sort(key=lambda i: i['_dt'], reverse=True)
        if hits:
            radar[s['id']] = ([{**public(i), 'attached': today} for i in hits] + radar.get(s['id'], []))[:MAX_PER_STORY]
            print(f"  story '{s['title'][:40]}': +{len(hits[:MAX_PER_STORY])}")


# ── Main ──────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='pick today again')
    ap.add_argument('--dry-run', action='store_true', help='print picks, write nothing')
    ap.add_argument('--date', help='pretend it is this date (YYYY-MM-DD), for testing')
    args = ap.parse_args()

    now_et = datetime.now(EASTERN)
    if args.date:
        now_et = datetime.fromisoformat(args.date).replace(hour=6, minute=5, tzinfo=EASTERN)
    now = now_et.astimezone(timezone.utc)
    today = now_et.date().isoformat()

    lib = load('library.json', {})
    cfg = load('sources.json', {})
    daily = load('daily.json', {'days': [], 'radar': {}})
    seen = load('seen.json', {'ids': {}})

    if daily.get('sample'):                 # first real run replaces the Part 1 preview
        daily = {'days': [], 'radar': {}}
        seen = {'ids': {}}

    have_today = any(d['date'] == today for d in daily['days'])
    if not args.force and not args.dry_run:
        if now_et.hour < 6:
            print(f'{now_et:%H:%M} ET is before 6 AM; nothing to do.')
            return 0
        if have_today:
            print(f'Picks for {today} already exist; nothing to do.')
            return 0

    if have_today:                          # --force: forget today's picks so they can be re-chosen
        daily['days'] = [d for d in daily['days'] if d['date'] != today]
        seen['ids'] = {k: v for k, v in seen['ids'].items() if v != today}

    tags = lib['tags']
    tagger = Tagger(tags, cfg['keywords'])
    sources = cfg['sources']
    for src in sources:
        if src.get('exclude'):
            src['_exclude'] = re.compile(src['exclude'])
        if src.get('require'):
            src['_require'] = compile_words(src['require'])

    print(f'Fetching {len(sources)} sources for {today}…')
    items, status = collect(sources, tagger)
    if not any(s['ok'] for s in status):
        print('Every source failed; leaving the page unchanged.')
        return 1

    seen_ids = dict(seen['ids'])
    library_eps = [i for i in lib['items'] if i['type'] == 'episode']
    day = {'date': today}
    for track in ('capstone', 'career'):
        rng = random.Random(f'{today}:{track}')
        eps = [i for i in items if i['kind'] == 'episode' and track in i['tracks']]
        arts = [i for i in items if i['kind'] == 'article' and track in i['tracks']]
        recent_shows = {
            (d.get(track) or {}).get('listenNew', {}).get('show')
            for d in sorted(daily['days'], key=lambda d: d['date'])[-2:]
        }
        recent_shows = {s['id'] for s in sources if s['name'] in recent_shows}

        picks = {}
        new_ep = pick_new_episode(eps, seen_ids, now, recent_shows)
        if new_ep:
            picks['listenNew'] = public(new_ep)
            seen_ids[new_ep['id']] = seen_ids[new_ep['_tkey']] = today
        lib_for_track = [e for e in library_eps if track in (e.get('tracks') or [tags[t]['track'] for t in e['tags']])]
        old_ep = pick_old_episode(eps, lib_for_track, seen_ids, now, rng)
        if old_ep:
            if '_src' in old_ep:
                picks['listenOld'] = public(old_ep)
                seen_ids[old_ep['_tkey']] = today
            else:
                picks['listenOld'] = {'ref': old_ep['id']}
            seen_ids[old_ep['id']] = today
        reads = pick_articles(arts, READS_PER_TRACK, seen_ids, now)
        for a in reads:
            seen_ids[a['id']] = seen_ids[a['_tkey']] = today
        picks['read'] = [public(a) for a in reads]
        day[track] = picks

    radar = daily.get('radar', {})
    attach_stories(lib.get('stories', []), items, radar, now, today)

    for track in ('capstone', 'career'):
        p = day[track]
        print(f'\n[{track}]')
        for slot in ('listenNew', 'listenOld'):
            x = p.get(slot)
            print(f'  {slot:<10}', (x.get('ref') or f"{x['show']}: {x['title']}") if x else '(none)')
        for a in p['read']:
            print(f"  read       {a['source']}: {a['title']}  {a['tags']}")

    if args.dry_run:
        print('\nDry run: nothing written.')
        return 0

    days = sorted([day] + daily['days'], key=lambda d: d['date'], reverse=True)[:KEEP_DAYS]
    save('daily.json', {'updated': now.isoformat(timespec='seconds'), 'days': days, 'radar': radar, 'sources': status})
    save('seen.json', {'ids': seen_ids})
    print(f'\nSaved picks for {today}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
