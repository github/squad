/*
 * Squad dashboard page (#2460): the team's Claude Code activity as a GitHub Projects-style board,
 * a roadmap of who worked when, and the conversation as an issue timeline.
 *
 * Every event field is transcript data. It reaches the page only through textContent, or through
 * esc() where markup is built; the server also sends a CSP that allows no inline script.
 */
'use strict';
// ── icons (GitHub Octicons) ──────────────────────────────────────────────────────────────────────
const ICON = {
  open: '<svg class="open" width="16" height="16" viewBox="0 0 16 16"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>',
  closed: '<svg class="closed" width="16" height="16" viewBox="0 0 16 16"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>',
  person: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>',
  zap: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.123c1.57 0 2.346 1.909 1.22 3.004l-7.34 7.142a1.249 1.249 0 0 1-.871.354h-.302a1.25 1.25 0 0 1-1.157-1.723L5.633 10.5H3.462c-1.57 0-2.346-1.909-1.22-3.004L9.503.429Zm1.047 1.074L3.286 8.571A.25.25 0 0 0 3.462 9H6.75a.75.75 0 0 1 .694 1.034l-1.713 4.188 6.982-6.793A.25.25 0 0 0 12.538 7H9.25a.75.75 0 0 1-.683-1.06l2.008-4.418.003-.006a.036.036 0 0 0-.004-.009l-.006-.006-.008-.001c-.003 0-.006.002-.009.004Z"/></svg>',
  terminal: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L5.44 8 3.72 6.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/></svg>',
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const palette = ['#0969da', '#8250df', '#bf3989', '#1a7f37', '#bc4c00', '#0550ae', '#6639ba', '#953800'];
const colorFor = (n) => palette[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length];
const cap = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const display = (n) => (n === 'coordinator' ? 'squad' : n === 'member' || n == null || n === 'undefined' ? 'general-purpose' : String(n));
function avatar(name, lg) {
  const a = el('span', 'avatar' + (lg ? ' lg' : ''), name === 'coordinator' ? 'S' : cap(name)[0] ?? '?');
  a.style.background = name === 'coordinator' ? '#1f2328' : colorFor(name);
  a.title = display(name);
  return a;
}
const labelPalette = ['#0e8a16', '#5319e7', '#d93f0b', '#1d76db', '#6e7781', '#b60205', '#bf8700', '#006b75'];
// Repository name and member roles, from /meta (the roster in .squad/).
const META = { repo: '', owner: '', roles: {}, source: '' };
function roleLabel(member) {
  const role = META.roles[member] ?? META.roles[String(member).replace(/^[^:]+:/, '')];
  if (!role) return null;
  const color = labelPalette[[...role].reduce((a, c) => a + c.charCodeAt(0), 0) % labelPalette.length];
  return [color, role.toLowerCase()];
}
function issueLabel(text, color) {
  const l = el('span', 'IssueLabel', text);
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  l.style.setProperty('--lr', r); l.style.setProperty('--lg', g); l.style.setProperty('--lb', b);
  return l;
}
let t0 = null;
const clock = (t) => { if (t0 == null) return ''; const s = Math.max(0, Math.round((t - t0) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? `${s} seconds ago` : `${Math.floor(s / 60)} minutes ago`; };
const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

// ── theme ────────────────────────────────────────────────────────────────────────────────────────
const themeBtn = document.getElementById('theme');
const sysDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const mode = localStorage.getItem('squad-dashboard-theme') ?? (sysDark.matches ? 'dark' : 'light');
  document.documentElement.dataset.colorMode = mode;
  themeBtn.innerHTML = mode === 'dark'
    ? '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5.657-8.157a.75.75 0 0 1 0 1.061l-1.061 1.06a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.06-1.06a.75.75 0 0 1 1.06 0Zm-9.193 9.193a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 1 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm13 0a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8Zm-8 5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13Zm3.536-1.464a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-1.06-1.06a.75.75 0 0 1 0-1.06Z"/></svg> Light'
    : '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg> Dark';
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.colorMode === 'dark' ? 'light' : 'dark';
  localStorage.setItem('squad-dashboard-theme', next);
  applyTheme();
});
sysDark.addEventListener('change', applyTheme);
applyTheme();

// ── views ────────────────────────────────────────────────────────────────────────────────────────
for (const tab of document.querySelectorAll('.UnderlineNav-item')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.UnderlineNav-item')) t.toggleAttribute('aria-current', t === tab);
    for (const v of ['board', 'roadmap', 'conversation']) document.getElementById(`view-${v}`).classList.toggle('hidden', tab.dataset.view !== v);
    renderRoadmap();
    if (tab.dataset.view === 'conversation') { follow = true; window.scrollTo({ top: document.documentElement.scrollHeight }); }
  });
}

// ── board ────────────────────────────────────────────────────────────────────────────────────────
const tasks = new Map(); // lane id -> task
let nextNumber = 1;
function task(id, member) {
  if (tasks.has(id)) return tasks.get(id);
  const T = { id, member, number: nextNumber++, status: 'queued', start: null, end: null, bg: false, title: '', now: '', summary: null, result: null };
  T.card = el('article', 'card');
  tasks.set(id, T);
  renderCard(T);
  return T;
}
function renderCard(T) {
  const c = T.card;
  c.textContent = '';
  const ref = el('div', 'ref');
  ref.innerHTML = (T.status === 'done' ? ICON.closed : ICON.open);
  ref.append(el('span', null, `${META.repo || 'squad'} #${T.number}`));
  const as = el('span', 'assignees'); as.append(avatar(T.member)); ref.append(as);
  const title = el('a', 'title', T.title || `${cap(T.member)}`); title.href = '#';
  c.append(ref, title);
  if (T.status === 'working' && T.now) c.append(el('div', 'now mono', T.now));
  const labels = el('div', 'labels');
  const role = roleLabel(T.member);
  if (role) labels.append(issueLabel(role[1], role[0]));
  if (T.bg) labels.append(issueLabel('background', '#0969da'));
  if (T.start != null) labels.append(issueLabel(T.status === 'done' ? `took ${dur(T.end - T.start)}` : `running ${dur(Math.max(Date.now(), latest) - T.start)}`, '#6e7781'));
  c.append(labels);
  if (T.summary) { const d = el('details'); d.append(el('summary', null, 'Report'), el('div', null, T.summary)); c.append(d); }
  const col = document.getElementById(`col-${T.status}`);
  if (c.parentElement !== col) col.prepend(c);
  for (const s of ['queued', 'working', 'done']) document.getElementById(`n-${s}`).textContent = document.getElementById(`col-${s}`).children.length;
  document.getElementById('count-board').textContent = tasks.size;
}

// ── roadmap (who's working when) ────────────────────────────────────────────────────────────────
function renderRoadmap() {
  if (document.getElementById('view-roadmap').classList.contains('hidden') || t0 == null) return;
  const nowT = Math.max(Date.now(), latest);
  const span = Math.max(60_000, nowT - t0);
  const stepMin = [1, 2, 5, 10, 15, 30][[1, 2, 5, 10, 15, 30].findIndex((m) => span / 60_000 / m <= 12)] ?? 60;
  const scale = document.getElementById('rm-scale');
  scale.textContent = '';
  const tickPct = (stepMin * 60_000 / span) * 100;
  for (let m = 0; m * 60_000 <= span; m += stepMin) {
    const t = el('span', 'tick', `${m}m`); t.style.left = `${(m * 60_000 / span) * 100}%`; scale.append(t);
  }
  const body = document.getElementById('rm-body');
  body.textContent = '';
  const rows = [...tasks.values()].filter((T) => T.start != null).sort((a, b) => a.start - b.start);
  for (const T of rows) {
    const row = el('div', 'rm-row');
    const item = el('div', 'item');
    item.innerHTML = T.status === 'done' ? ICON.closed : ICON.open;
    item.append(avatar(T.member), el('span', 't', `${cap(display(T.member))} · ${T.title}`));
    const lane = el('div', 'lane');
    lane.style.setProperty('--tick', `${tickPct}%`);
    const bar = el('div', `rm-bar ${T.status === 'done' ? 'done' : 'working'}`);
    const end = T.end ?? nowT;
    bar.style.left = `${((T.start - t0) / span) * 100}%`;
    bar.style.width = `${Math.max(0.8, ((end - T.start) / span) * 100)}%`;
    bar.append(avatar(T.member), el('span', null, `${cap(display(T.member))} · ${dur(end - T.start)}`));
    lane.append(bar);
    row.append(item, lane);
    body.append(row);
  }
  const now = el('div', 'rm-now');
  now.style.left = `calc(360px + (100% - 360px) * ${(nowT - t0) / span})`;
  body.append(now);
}

// ── conversation (issue timeline) ───────────────────────────────────────────────────────────────
const convo = document.getElementById('convo');
const pill = document.getElementById('new-activity');
const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
let follow = true;
window.addEventListener('scroll', () => { follow = nearBottom(); if (follow) pill.classList.add('hidden'); });
pill.addEventListener('click', () => { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); pill.classList.add('hidden'); });
function landed(node) {
  node.classList.add('arrived');
  if (document.getElementById('view-conversation').classList.contains('hidden')) return;
  if (follow) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  else pill.classList.remove('hidden');
}
let commentCount = 0;
let toolItem = null;
function comment(who, verb, body, t, member) {
  toolItem = null;
  const row = el('div', 'comment-row');
  const box = el('div', 'timeline-comment' + (member ? ' member' : ''));
  const head = el('div', 'timeline-comment-header');
  head.append(el('b', null, display(who)), document.createTextNode(` ${verb} · ${clock(t)}`));
  head.append(el('span', 'Label--secondary', who === 'coordinator' ? 'Coordinator' : 'Member'));
  box.append(head, el('div', 'comment-body', body));
  row.append(avatar(who, true), box);
  convo.append(row);
  landed(row);
  document.getElementById('count-convo').textContent = ++commentCount;
}
function item(icon, badgeCls, inner, t) {
  toolItem = null;
  const it = el('div', 'TimelineItem');
  const badge = el('div', 'TimelineItem-badge' + (badgeCls ? ` ${badgeCls}` : ''));
  badge.innerHTML = ICON[icon];
  const body = el('div', 'TimelineItem-body');
  body.innerHTML = `${inner} <span>· ${clock(t)}</span>`;
  it.append(badge, body);
  convo.append(it);
  landed(it);
}
function tool(lane, who, text) {
  if (!toolItem || toolItem.lane !== lane) {
    const it = el('div', 'TimelineItem');
    const badge = el('div', 'TimelineItem-badge');
    badge.innerHTML = ICON.terminal;
    const body = el('div', 'TimelineItem-body');
    const d = el('details'); const s = el('summary'); const ol = el('ol');
    d.append(s, ol); body.append(d); it.append(badge, body);
    convo.append(it);
    toolItem = { lane, who, s, ol, n: 0 };
  }
  toolItem.ol.append(el('li', 'mono', text));
  toolItem.n++;
  toolItem.s.innerHTML = `<b>${esc(display(who))}</b> ran ${toolItem.n} command${toolItem.n === 1 ? '' : 's'}`;
}

// ── stream ───────────────────────────────────────────────────────────────────────────────────────
const laneMember = new Map([['coordinator', 'coordinator']]);
let latest = 0;
const state = document.getElementById('state');
const setState = (cls, text) => { state.className = `State ${cls}`; state.innerHTML = (cls === 'done' ? ICON.check : ICON.play) + ' ' + esc(text); };
fetch('/meta').then((r) => r.json()).then((m) => {
  Object.assign(META, m);
  document.getElementById('repo').textContent = META.repo || 'Squad';
  document.getElementById('owner').textContent = META.owner || '';
  document.getElementById('owner-sep').classList.toggle('hidden', !META.owner);
  document.getElementById('source').textContent = META.source || 'Dashboard';
  document.title = `Squad team activity · ${META.repo || 'Squad'}`;
  for (const T of tasks.values()) renderCard(T);
}).catch(() => {});
const es = new EventSource('/events');
// The dashboard moved to a newer Claude Code session: start the page over.
es.addEventListener('reset', () => location.reload());
let opened = false;
es.onopen = () => {
  if (opened) {
    es.close();
    location.reload();
    return;
  }
  opened = true;
  setState('', 'Live');
};
es.onerror = () => setState('', 'Reconnecting');
es.onmessage = (msg) => {
  const ev = JSON.parse(msg.data);
  t0 = t0 == null ? ev.t : Math.min(t0, ev.t);
  latest = Math.max(latest, ev.t);
  // A dispatch carries the target member but belongs to the coordinator lane: never relabel the coordinator.
  if (ev.extra?.member && ev.lane !== "coordinator") laneMember.set(ev.lane, ev.extra.member);
  const who = laneMember.get(ev.lane) ?? 'member';
  switch (ev.kind) {
    case 'session':
      setState('', `Prompt ${ev.extra?.run} running`);
      item('play', 'open', `<b>squad</b> started prompt ${esc(ev.extra?.run ?? '')} on <span class="mono">${esc(ev.text.split('·').pop().trim())}</span>`, ev.t);
      break;
    case 'dispatch': {
      const T = task(ev.extra.target, ev.extra.member);
      T.title = ev.text.replace(/^→ [^:]+: /, '').replace(/ \(background\)$/, '').replace(/^[A-Za-z-]+: /, '');
      renderCard(T);
      item('person', '', `<b>squad</b> assigned <b>${esc(display(ev.extra.member))}</b> to <b>#${T.number}</b> ${esc(T.title)}`, ev.t);
      break;
    }
    case 'start': {
      const T = task(ev.lane, ev.extra?.member ?? who);
      T.title ||= ev.text.replace(/^[A-Za-z-]+: /, '');
      T.bg = !!ev.extra?.background; T.start = ev.t; T.status = 'working'; T.now = 'Starting…';
      renderCard(T);
      break;
    }
    case 'progress': case 'tool': {
      const T = tasks.get(ev.lane);
      if (T && T.status === 'working') { T.now = ev.text; renderCard(T); }
      if (ev.kind === 'tool') tool(ev.lane, who, ev.text);
      break;
    }
    case 'end': {
      const T = tasks.get(ev.lane);
      if (T) { T.status = 'done'; T.end = ev.t; T.result = ev.extra?.status; renderCard(T); }
      item('check', 'done', `<b>${esc(display(who))}</b> closed <b>#${T?.number ?? ''}</b> as ${esc(ev.extra?.status ?? 'completed')}`, ev.t);
      break;
    }
    case 'summary': {
      const T = tasks.get(ev.lane);
      if (T) { T.summary = ev.text; renderCard(T); }
      comment(who, 'reported', ev.text, ev.t, true);
      break;
    }
    case 'say':
      comment(who, ev.lane === 'coordinator' ? 'commented' : 'said', ev.text, ev.t, ev.lane !== 'coordinator');
      break;
    case 'hook':
      item('zap', '', `Hook <b>${esc(ev.text.replace(/^hook\s*/, '') || 'event')}</b> ran`, ev.t);
      break;
    case 'idle':
      setState('done', `Prompt ${ev.extra?.run} done`);
      if (lastResult !== `Prompt ${ev.extra?.run} finished`) item('check', 'done', `<b>squad</b> finished prompt ${esc(ev.extra?.run ?? '')} and is waiting for input`, ev.t);
      lastResult = `Prompt ${ev.extra?.run} finished`;
      break;
    case 'result':
      setState(ev.extra?.error ? 'failed' : 'done', ev.extra?.error ? 'Failed' : `Prompt ${ev.extra?.run} done`);
      item('check', 'done', `<b>squad</b> finished prompt ${esc(ev.extra?.run ?? '')}: ${esc(ev.text)}`, ev.t);
      lastResult = `Prompt ${ev.extra?.run} finished · ${ev.text}`;
      break;
  }
};
let lastResult = null;
function renderLive(nowT) {
  const working = [...tasks.values()].filter((t) => t.status === 'working');
  const icon = document.getElementById('live-icon');
  const rows = document.getElementById('live-rows');
  rows.textContent = '';
  if (working.length) {
    icon.className = 'icon'; icon.innerHTML = '<span class="pending-dot"></span>';
    document.getElementById('live-title').textContent = `${working.length} member${working.length === 1 ? ' is' : 's are'} working`;
    document.getElementById('live-sub').textContent = `Updated ${ago(latest, nowT)}`;
    for (const T of working) {
      const r = el('div', 'MergeBox-row');
      r.append(el('span', 'pending-dot'), avatar(T.member), el('span', 'who', cap(display(T.member))), el('span', 'what mono', T.now || T.title), el('span', 'elapsed', T.start ? dur(nowT - T.start) : ''));
      rows.append(r);
    }
  } else if (t0 != null) {
    icon.className = 'icon idle'; icon.innerHTML = ICON.check;
    document.getElementById('live-title').textContent = lastResult ?? 'No member is working right now';
    document.getElementById('live-sub').textContent = state.textContent.includes('running') ? 'The coordinator is planning the next step' : '';
  }
}
setInterval(() => {
  const nowT = Math.max(Date.now(), latest);
  renderLive(nowT);
  for (const T of tasks.values()) if (T.status === 'working') renderCard(T);
  renderRoadmap();
  if (t0 != null) {
    const working = [...tasks.values()].filter((t) => t.status === 'working').length;
    document.getElementById('meta').textContent = `${tasks.size} items · ${working} in progress · ${ago(t0, nowT).replace(' ago', '')} of team activity · updated ${ago(latest, nowT)}`;
  }
}, 1000);
