/* Commute Queue — renders the library + daily picks and keeps Done/Later on this device. */
(() => {
  'use strict';

  const STATE_KEY = 'cq:v1';
  const UI_KEY = 'cq:ui';
  const NEW_DAYS = 3; // auto-attached story links show "new" for this many days

  let LIB, DAILY, TAGS;
  const byId = new Map();

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICON = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };

  /* ── Storage (wrapped: private mode or blocked storage must not break the page) ── */

  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
  function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* not persisted */ } }

  const blankState = () => ({ v: 1, track: 'both', done: {}, later: {} });
  let state = (() => { const s = readJSON(STATE_KEY); return s && s.v === 1 ? { ...blankState(), ...s } : blankState(); })();
  let ui = { tab: 'today', chips: {}, readSeg: 'books', savedSeg: 'later', showDone: {}, ...(readJSON(UI_KEY) || {}) };
  const saveState = () => writeJSON(STATE_KEY, state);
  const saveUI = () => writeJSON(UI_KEY, ui);

  /* ── Item helpers ── */

  const kindOf = it => it.kind || it.type;
  const isDone = id => !!state.done[id];
  const isLater = id => !!state.later[id];
  const resolve = x => (!x ? null : x.ref ? byId.get(x.ref) || null : x);

  function tracksOf(it) {
    if (it.tracks && it.tracks.length) return it.tracks;
    const s = new Set();
    (it.tags || []).forEach(t => TAGS[t] && s.add(TAGS[t].track));
    return [...s];
  }
  const inTrack = it => state.track === 'both' || tracksOf(it).includes(state.track);

  const spotifyUrl = it => 'https://open.spotify.com/search/' + encodeURIComponent(`${it.show} ${it.title}`.slice(0, 180));
  function findUrl(it) {
    let q = `${it.title} ${it.creator || ''}`;
    if (kindOf(it) === 'book') q += it.free ? ' World Bank Open Knowledge Repository' : ' book';
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }

  function linksOf(it) {
    switch (kindOf(it)) {
      case 'episode': {
        const L = [];
        if (it.spotify !== false) L.push({ label: 'Spotify', href: spotifyUrl(it), cls: 'btn-spotify', icon: ICON.play });
        if (it.url) L.push(it.spotify === false
          ? { label: 'Listen', href: it.url, cls: 'btn-primary', icon: ICON.play }
          : { label: 'Web', href: it.url, cls: '', icon: ICON.ext });
        return L;
      }
      case 'article': return [{ label: 'Read', href: it.url, cls: 'btn-primary', icon: ICON.ext }];
      case 'book': return [{ label: it.free ? 'Free online' : 'Find it', href: it.url || findUrl(it), cls: '', icon: ICON.ext }];
      case 'film':
      case 'talk': return [{ label: 'Watch', href: it.url || findUrl(it), cls: '', icon: ICON.play }];
      case 'story': return it.url ? [{ label: 'Source', href: it.url, cls: '', icon: ICON.ext }] : [];
      default: return [];
    }
  }

  function parseYMD(d) { const [y, m, dd] = d.split('-').map(Number); return new Date(y, (m || 1) - 1, dd || 1); }
  function ymd(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function fmtDate(d) {
    if (!d) return '';
    const hasDay = d.split('-').length === 3;
    const date = parseYMD(d);
    const opts = hasDay ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' };
    if (hasDay && date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return date.toLocaleDateString('en-US', opts);
  }
  const fmtLong = d => parseYMD(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  function metaOf(it) {
    const k = kindOf(it);
    if (k === 'episode') return [it.show, it.minutes && `${it.minutes} min`, fmtDate(it.date)].filter(Boolean);
    if (k === 'article') return [it.source, fmtDate(it.date)].filter(Boolean);
    const lead = k === 'film' ? 'Documentary' : k === 'talk' ? 'Talk' : null;
    return [lead, it.creator, it.year, it.length].filter(Boolean);
  }

  const TYPE_LABEL = { book: 'Book', film: 'Documentary', talk: 'Talk', episode: 'Episode', article: 'Article', story: 'Story' };

  /* ── Daily picks ── */

  function sortedDays() { return [...(DAILY.days || [])].sort((a, b) => b.date.localeCompare(a.date)); }
  function currentDay() {
    const days = sortedDays(), today = ymd();
    return days.find(d => d.date <= today) || days[0] || null;
  }

  // Both view: alternate which track leads each day so neither dominates.
  function picksFor(day) {
    const c = day.capstone || {}, k = day.career || {};
    const listRead = d => (d.read || []).map(resolve).filter(Boolean);
    let newEp, oldEp, read;
    if (state.track !== 'both') {
      const d = state.track === 'capstone' ? c : k;
      newEp = resolve(d.listenNew); oldEp = resolve(d.listenOld); read = listRead(d);
    } else {
      const capFirst = Math.floor(Date.parse(day.date) / 864e5) % 2 === 0;
      const [A, B] = capFirst ? [c, k] : [k, c];
      newEp = resolve(A.listenNew) || resolve(B.listenNew);
      oldEp = resolve(B.listenOld) || resolve(A.listenOld);
      const ra = listRead(A), rb = listRead(B);
      read = [...ra.slice(0, 2), ...rb.slice(0, 1)];
      for (const x of [...ra.slice(2), ...rb.slice(1)]) if (read.length < 3) read.push(x);
    }
    const listen = [];
    if (newEp) listen.push({ it: newEp, slot: 'New episode' });
    if (oldEp) listen.push({ it: oldEp, slot: 'From the archive' });
    return { listen, read };
  }

  /* ── Rendering pieces ── */

  function tagsHtml(it, extra = '') {
    const tags = (it.tags || []).filter(t => TAGS[t])
      .map(t => `<span class="tag ${TAGS[t].track === 'career' ? 'car' : ''}">${esc(TAGS[t].label)}</span>`).join('');
    return tags || extra ? `<div class="tags">${extra}${tags}</div>` : '';
  }
  const linkBtn = l => `<a class="btn ${l.cls}" href="${esc(l.href)}" target="_blank" rel="noopener">${l.icon}${esc(l.label)}</a>`;

  function doneBtn(it) {
    const on = isDone(it.id);
    return `<button class="btn act-done" data-act="done" data-id="${esc(it.id)}" aria-pressed="${on}">${ICON.check}Done</button>`;
  }
  function laterBtn(it) {
    const on = isLater(it.id);
    return `<button class="btn act-later" data-act="later" data-id="${esc(it.id)}" aria-pressed="${on}">${ICON.bookmark}${on ? 'Saved' : 'Later'}</button>`;
  }
  function laterMini(it) {
    const on = isLater(it.id);
    return `<button class="mini" data-act="later" data-id="${esc(it.id)}" aria-pressed="${on}" aria-label="${on ? 'Remove from Saved' : 'Save for later'}">${ICON.bookmark}</button>`;
  }
  const accentOf = it => { const t = tracksOf(it); return t.length === 1 && t[0] === 'career' ? ' style="--accent:var(--car)"' : ''; };

  function card(it, slot) {
    const L = linksOf(it);
    if (L[0] && !L[0].cls) L[0].cls = 'btn-primary';
    const href = L[0]?.href;
    const text = it.summary || it.note;
    const meta = metaOf(it).map((b, i) => `<span class="${i || slot ? 'dot' : ''}">${esc(b)}</span>`).join('');
    return `<article class="card ${isDone(it.id) ? 'is-done' : ''}"${accentOf(it)}>
      <div class="kicker">${slot ? `<span class="slot">${esc(slot)}</span>` : ''}${meta}</div>
      ${href ? `<a class="card-title" href="${esc(href)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : `<p class="card-title">${esc(it.title)}</p>`}
      ${text ? `<p class="summary" data-act="expand">${esc(text)}</p>` : ''}
      ${tagsHtml(it)}
      <div class="actions">${L[0] ? linkBtn(L[0]) : ''}<span class="spacer"></span>${doneBtn(it)}${laterBtn(it)}</div>
    </article>`;
  }

  function row(it, extraTag = '') {
    const done = isDone(it.id);
    const L = linksOf(it);
    const meta = metaOf(it).join(' · ');
    const text = it.note || it.summary;
    return `<div class="row ${done ? 'is-done' : ''}">
      <button class="check" data-act="done" data-id="${esc(it.id)}" aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(it.title)}">${ICON.check}</button>
      <div class="row-body">
        <p class="row-title">${esc(it.title)}</p>
        ${meta ? `<div class="row-meta">${esc(meta)}</div>` : ''}
        ${text ? `<p class="row-note" data-act="expand">${esc(text)}</p>` : ''}
        ${tagsHtml(it, extraTag)}
        ${L.length ? `<div class="row-links">${L.map(linkBtn).join('')}</div>` : ''}
      </div>
      <div class="row-side">${laterMini(it)}</div>
    </div>`;
  }

  function isNewAttach(x) {
    return x.attached && (Date.now() - parseYMD(x.attached).getTime()) / 864e5 < NEW_DAYS;
  }

  function storyCard(s) {
    const attached = (DAILY.radar && DAILY.radar[s.id]) || [];
    const related = [...s.related.map(id => byId.get(id)).filter(Boolean), ...attached];
    const newCount = attached.filter(isNewAttach).length;
    const relHtml = related.map(r => {
      const href = linksOf(r)[0]?.href;
      const meta = [TYPE_LABEL[kindOf(r)], ...metaOf(r).slice(0, 2)].filter(Boolean).join(' · ');
      return `<li>
        <button class="check" data-act="done" data-id="${esc(r.id)}" aria-pressed="${isDone(r.id)}" aria-label="Mark done: ${esc(r.title)}">${ICON.check}</button>
        <div>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : `<strong>${esc(r.title)}</strong>`}
          ${isNewAttach(r) ? ' <span class="tag new">new</span>' : ''}<span class="rmeta">${esc(meta)}</span></div>
      </li>`;
    }).join('');
    const L = linksOf(s);
    return `<article class="card story ${isDone(s.id) ? 'is-done' : ''}">
      <div class="kicker"><span class="slot">Story to follow</span><span class="dot">${esc(s.date)}</span></div>
      <p class="card-title">${esc(s.title)}</p>
      <p class="summary" data-act="expand">${esc(s.summary)}</p>
      ${tagsHtml(s)}
      ${related.length ? `<details><summary>${ICON.chev}Related (${related.length})${newCount ? ` <span class="tag new">${newCount} new</span>` : ''}</summary><ul class="related">${relHtml}</ul></details>` : ''}
      <div class="actions">${L.map(linkBtn).join('')}<span class="spacer"></span>${doneBtn(s)}${laterBtn(s)}</div>
    </article>`;
  }

  const section = (title, body, count = '') =>
    `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${count ? `<span class="count">${esc(count)}</span>` : ''}</div>${body}</section>`;
  const empty = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
  const banner = text => `<div class="banner">${ICON.info}<span>${esc(text)}</span></div>`;
  const list = items => `<div class="list">${items.join('')}</div>`;

  function chipBar(key, items) {
    const present = new Set(items.flatMap(i => i.tags || []));
    const tags = Object.keys(TAGS).filter(t => present.has(t));
    let sel = ui.chips[key] || 'all';
    if (sel !== 'all' && !tags.includes(sel)) sel = 'all';
    const chip = (val, label) => `<button class="chip" data-act="chip" data-key="${key}" data-val="${val}" aria-pressed="${sel === val}">${esc(label)}</button>`;
    return {
      html: tags.length > 1 ? `<div class="chips" role="group" aria-label="Filter by topic">${chip('all', 'All')}${tags.map(t => chip(t, TAGS[t].label)).join('')}</div>` : '',
      keep: it => sel === 'all' || (it.tags || []).includes(sel),
    };
  }

  function progress(items, verb) {
    const n = items.filter(i => isDone(i.id)).length;
    const pct = items.length ? Math.round((n / items.length) * 100) : 0;
    return `<div class="progress"><span>${n} of ${items.length} ${verb}</span><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }

  function doneToggle(key, hiddenCount) {
    if (!hiddenCount && !ui.showDone[key]) return '';
    return `<button class="linkish" data-act="showdone" data-key="${key}">${ui.showDone[key] ? 'Hide finished' : `Show finished (${hiddenCount})`}</button>`;
  }
  function splitDone(key, items) {
    const hidden = items.filter(i => isDone(i.id)).length;
    return { shown: ui.showDone[key] ? items : items.filter(i => !isDone(i.id)), hidden };
  }

  const dedupe = arr => { const seen = new Set(); return arr.filter(x => x && !seen.has(x.id) && seen.add(x.id)); };
  const libOf = (...types) => LIB.items.filter(i => types.includes(i.type) && inTrack(i));

  /* ── Views ── */

  function viewToday() {
    const day = currentDay();
    let h = '';
    if (DAILY.sample) h += banner('Preview: these are real items from your feeds, but I picked them by hand. The daily job takes over in Part 2.');
    if (day && day.date !== ymd()) h += banner(`Showing picks from ${fmtLong(day.date)}. Today's update hasn't arrived yet.`);

    const p = day ? picksFor(day) : { listen: [], read: [] };
    h += section('Listen', p.listen.length
      ? `<div class="stack">${p.listen.map(x => card(x.it, x.slot)).join('')}</div>`
      : empty('No episodes today', 'New episodes arrive with the morning update.'), p.listen.length ? `${p.listen.length} for the ride` : '');

    h += section('Read', p.read.length
      ? `<div class="stack">${p.read.map(it => card(it)).join('')}</div>`
      : empty('Nothing new to read', 'Articles arrive with the morning update.'), p.read.length ? `${p.read.length} new` : '');

    const nextOf = types => libOf(...types).find(i => !isDone(i.id) && !isLater(i.id));
    const book = nextOf(['book']), watch = nextOf(['film', 'talk']);
    const upNext = [book && card(book, 'Next book'), watch && card(watch, 'Next to watch')].filter(Boolean);
    h += section('Up next', upNext.length ? `<div class="stack">${upNext.join('')}</div>` : empty('All caught up', 'You have finished every book and film on this track.'));

    const stories = (LIB.stories || []).filter(s => inTrack(s) && !isDone(s.id));
    if (stories.length) h += section('Stories to follow', `<div class="stack">${stories.map(storyCard).join('')}</div>`, `${stories.length}`);
    return h;
  }

  function pastPicks(kind) {
    const cur = currentDay();
    return sortedDays().filter(d => !cur || d.date !== cur.date).flatMap(d => {
      const p = picksFor(d);
      return kind === 'episode' ? p.listen.map(x => x.it) : p.read;
    });
  }

  function viewListen() {
    const day = currentDay();
    const today = day ? picksFor(day).listen.map(x => x.it) : [];
    const mine = libOf('episode');
    const libIds = new Set(mine.map(i => i.id));
    const todayIds = new Set(today.map(i => i.id));
    const earlier = dedupe(pastPicks('episode')).filter(i => !libIds.has(i.id) && !todayIds.has(i.id));

    const chips = chipBar('listen', [...today, ...mine, ...earlier]);
    let h = chips.html;
    const t = today.filter(chips.keep);
    if (t.length) h += section('Today', list(t.map(i => row(i))));
    const m = mine.filter(chips.keep);
    h += section('Your episode list', m.length ? progress(m, 'played') + list(m.map(i => row(i))) : empty('Nothing here', 'No episodes match this topic.'));
    const { shown, hidden } = splitDone('listen-earlier', earlier.filter(chips.keep));
    if (shown.length || hidden) h += section('Earlier picks', (shown.length ? list(shown.map(i => row(i))) : '') + doneToggle('listen-earlier', hidden));
    return h;
  }

  function viewRead() {
    const seg = ui.readSeg;
    let h = `<div class="seg tabs-inline" role="tablist">
      <button role="tab" data-act="seg" data-key="readSeg" data-val="books" aria-selected="${seg === 'books'}">Books</button>
      <button role="tab" data-act="seg" data-key="readSeg" data-val="articles" aria-selected="${seg === 'articles'}">Articles</button>
    </div>`;
    if (seg === 'books') {
      const books = libOf('book');
      const chips = chipBar('books', books);
      const b = books.filter(chips.keep);
      h += chips.html + (b.length ? progress(b, 'read') + list(b.map(i => row(i, i.free ? '<span class="tag new">Free</span>' : ''))) : empty('No books', 'Nothing on this track yet.'));
      return h;
    }
    const day = currentDay();
    const today = day ? picksFor(day).read : [];
    const todayIds = new Set(today.map(i => i.id));
    const all = [...today, ...dedupe(pastPicks('article')).filter(i => !todayIds.has(i.id))];
    const chips = chipBar('articles', all);
    const { shown, hidden } = splitDone('articles', all.filter(chips.keep));
    h += chips.html;
    if (!shown.length && !hidden) return h + empty('No articles yet', 'New articles arrive every morning.');
    const groups = new Map();
    for (const it of shown) {
      const label = todayIds.has(it.id) ? 'Today' : 'Earlier picks';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(it);
    }
    for (const [label, items] of groups) h += section(label, list(items.map(i => row(i))));
    if (!shown.length) h += empty('All read', 'Every article here is finished.');
    return h + doneToggle('articles', hidden);
  }

  function viewWatch() {
    const films = libOf('film'), talks = libOf('talk');
    const chips = chipBar('watch', [...films, ...talks]);
    const f = films.filter(chips.keep), t = talks.filter(chips.keep);
    let h = chips.html + progress([...f, ...t], 'watched');
    if (t.length) h += `<p class="subhead">Talks</p>` + list(t.map(i => row(i)));
    if (f.length) h += `<p class="subhead">Documentaries</p>` + list(f.map(i => row(i)));
    if (!f.length && !t.length) h += empty('Nothing here', 'No films or talks match this topic.');
    return h;
  }

  function viewSaved() {
    const seg = ui.savedSeg;
    let h = `<div class="seg tabs-inline" role="tablist">
      <button role="tab" data-act="seg" data-key="savedSeg" data-val="later" aria-selected="${seg === 'later'}">Saved for later</button>
      <button role="tab" data-act="seg" data-key="savedSeg" data-val="past" aria-selected="${seg === 'past'}">Past days</button>
    </div>`;
    if (seg === 'later') {
      const all = Object.entries(state.later)
        .sort((a, b) => b[1].at - a[1].at)
        .map(([id, v]) => byId.get(id) || v.item).filter(Boolean);
      const mine = all.filter(inTrack);
      const other = all.length - mine.length;
      if (!mine.length) h += empty('Nothing saved', 'Tap Later on any item and it will wait here.');
      else h += list(mine.map(i => row(i, `<span class="tag">${esc(TYPE_LABEL[kindOf(i)] || '')}</span>`)));
      if (other) h += `<p class="muted small" style="margin:10px 2px">${other} more saved in the other track. Switch to Both to see everything.</p>`;
      return h;
    }
    const cur = currentDay();
    const past = sortedDays().filter(d => !cur || d.date !== cur.date);
    if (!past.length) return h + empty('No past days yet', 'Each morning, the previous day moves here.');
    for (const d of past) {
      const p = picksFor(d);
      const items = [...p.listen.map(x => x.it), ...p.read];
      if (items.length) h += `<div class="day-group">${section(fmtLong(d.date), list(items.map(i => row(i, `<span class="tag">${esc(TYPE_LABEL[kindOf(i)])}</span>`))))}</div>`;
    }
    return h;
  }

  const VIEWS = { today: viewToday, listen: viewListen, read: viewRead, watch: viewWatch, saved: viewSaved };

  function render(keepScroll = false) {
    const y = window.scrollY;
    $('#view').innerHTML = (VIEWS[ui.tab] || viewToday)();
    document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === ui.tab));
    document.querySelectorAll('.track-seg [data-track]').forEach(b => b.setAttribute('aria-checked', b.dataset.track === state.track));
    const n = Object.keys(state.later).length;
    const badge = $('#savedBadge');
    badge.hidden = !n; badge.textContent = n;
    window.scrollTo(0, keepScroll ? y : 0);
  }

  /* ── Actions ── */

  let toastTimer;
  function toast(msg, undo) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
    t.hidden = false;
    if (undo) t.querySelector('button').onclick = () => { undo(); t.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function snapshot(id) { return { done: state.done[id], later: state.later[id] }; }
  function restore(id, s) {
    if (s.done) state.done[id] = s.done; else delete state.done[id];
    if (s.later) state.later[id] = s.later; else delete state.later[id];
    saveState(); render(true);
  }

  function toggleDone(id) {
    const before = snapshot(id);
    if (isDone(id)) delete state.done[id];
    else { state.done[id] = Date.now(); delete state.later[id]; }
    saveState(); render(true);
    toast(before.done ? 'Moved back to your queue' : 'Marked done', () => restore(id, before));
  }

  function toggleLater(id) {
    const before = snapshot(id);
    const it = byId.get(id);
    if (isLater(id)) delete state.later[id];
    else { state.later[id] = { at: Date.now(), item: it }; delete state.done[id]; }
    saveState(); render(true);
    toast(before.later ? 'Removed from Saved' : 'Saved for later', () => restore(id, before));
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const { act, id, key, val } = el.dataset;
    if (act === 'expand') el.classList.toggle('open');
    else if (act === 'done') toggleDone(id);
    else if (act === 'later') toggleLater(id);
    else if (act === 'chip') { ui.chips[key] = val; saveUI(); render(true); }
    else if (act === 'seg') { ui[key] = val; saveUI(); render(); }
    else if (act === 'showdone') { ui.showDone[key] = !ui.showDone[key]; saveUI(); render(true); }
  });

  document.querySelectorAll('.tabbar [data-tab]').forEach(b => b.addEventListener('click', () => {
    ui.tab = b.dataset.tab; saveUI(); render();
  }));
  document.querySelectorAll('.track-seg [data-track]').forEach(b => b.addEventListener('click', () => {
    state.track = b.dataset.track; saveState(); render();
  }));

  /* ── Settings: backup / restore / reset ── */

  const sheet = $('#sheet');
  function openSheet() {
    const u = DAILY && DAILY.updated ? new Date(DAILY.updated) : null;
    $('#updatedLine').textContent = u
      ? `Picks last updated ${u.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${u.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`
      : '';
    const src = (DAILY && DAILY.sources) || [];
    const down = src.filter(s => !s.ok).map(s => s.name);
    $('#sourcesLine').textContent = !src.length ? ''
      : down.length ? `${src.length - down.length} of ${src.length} sources checked in. Didn't respond: ${down.join(', ')}.`
      : `All ${src.length} sources checked in.`;
    sheet.hidden = false;
  }
  $('#openSettings').addEventListener('click', openSheet);
  $('#closeSettings').addEventListener('click', () => { sheet.hidden = true; });
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });

  $('#backupBtn').addEventListener('click', async () => {
    const name = `commute-queue-backup-${ymd()}.json`;
    const body = JSON.stringify({ app: 'commute-queue', exported: new Date().toISOString(), state }, null, 2);
    const blob = new Blob([body], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Commute Queue backup' });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $('#restoreInput').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const s = data && data.app === 'commute-queue' && data.state;
      if (!s || s.v !== 1) throw new Error('not a backup');
      if (!confirm('Replace your current progress with this backup?')) return;
      state = { ...blankState(), ...s };
      saveState(); sheet.hidden = true; render();
      toast('Progress restored');
    } catch {
      toast("That file isn't a Commute Queue backup");
    }
  });

  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear every Done and Saved mark on this phone? This cannot be undone unless you have a backup.')) return;
    state = { ...blankState(), track: state.track };
    saveState(); sheet.hidden = true; render();
    toast('Progress cleared');
  });

  /* ── Boot ── */

  function index() {
    TAGS = LIB.tags || {};
    for (const it of LIB.items) byId.set(it.id, it);
    for (const s of LIB.stories || []) byId.set(s.id, { ...s, kind: 'story' });
    LIB.stories = (LIB.stories || []).map(s => byId.get(s.id));
    const add = x => { if (x && !x.ref && x.id && !byId.has(x.id)) byId.set(x.id, x); };
    for (const d of DAILY.days || []) for (const t of ['capstone', 'career']) {
      const p = d[t]; if (!p) continue;
      add(p.listenNew); add(p.listenOld); (p.read || []).forEach(add);
    }
    for (const arr of Object.values(DAILY.radar || {})) arr.forEach(add);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  $('#todayDate').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  Promise.all([
    fetch('data/library.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch('data/daily.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : { days: [] })).catch(() => ({ days: [] })),
  ]).then(([lib, daily]) => {
    LIB = lib; DAILY = daily;
    index();
    render();
  }).catch(() => {
    $('#view').innerHTML = empty("Couldn't load your library", 'Check your connection and reopen the app.');
  });
})();
