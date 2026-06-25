// Minimal no-build SPA for mangas-binder.
const $ = (sel, el = document) => el.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// Auth token persisted in localStorage (only needed if server sets AUTH_TOKEN).
const token = () => localStorage.getItem('mb_token') || '';
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(`/api${path}`, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

const STATE_PILL = { imported:'ok', downloaded:'acc', downloading:'acc', queued:'', wanted:'warn', failed:'err', skipped:'' };
const countsBadges = (c = {}) => Object.entries(c).map(([s,n]) => `<span class="pill ${STATE_PILL[s]||''}">${s} ${n}</span>`).join(' ');

const TABS = ['Library', 'Add', 'Activity', 'Settings'];
let current = 'Library';

function renderNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  for (const t of TABS) {
    const b = h(`<button class="${t===current?'active':''}">${t}</button>`);
    b.onclick = () => { current = t; route(); };
    nav.appendChild(b);
  }
}

async function route() {
  renderNav();
  const v = $('#view'); v.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (current === 'Library') await viewLibrary(v);
    else if (current === 'Add') await viewAdd(v);
    else if (current === 'Activity') await viewActivity(v);
    else if (current === 'Settings') await viewSettings(v);
  } catch (e) { v.innerHTML = `<div class="card"><span class="pill err">error</span> ${esc(e.message)}</div>`; }
}

// --- Library ---------------------------------------------------------------
async function viewLibrary(v) {
  const [series, health] = await Promise.all([api('/series'), api('/health')]);
  v.innerHTML = '';
  const head = h(`<div class="card row"><div>
    <strong>${series.length}</strong> series · scheduler ${health.scheduler.running ? '<span class="pill ok">on</span>' : '<span class="pill warn">off</span>'} (${health.scheduler.intervalHours}h)
    </div></div>`);
  const scanBtn = h('<button class="btn primary" style="margin-left:auto">Scan now</button>');
  scanBtn.onclick = async () => { await api('/scan', { method:'POST' }); toast('Scan started'); };
  head.appendChild(scanBtn);
  v.appendChild(head);

  if (!series.length) { v.appendChild(h('<p class="muted">No series followed yet. Use the <b>Add</b> tab.</p>')); return; }
  const grid = h('<div class="grid"></div>');
  for (const s of series) {
    const card = h(`<div class="card">
      <div class="title-row"><strong>${esc(s.title)}</strong> <span class="pill ${s.status==='completed'?'ok':'acc'}">${esc(s.status||'?')}</span></div>
      <div class="muted" style="font-size:12px">${esc(s.authors.join(', '))} · ${esc(s.packagingMode)} · ${esc(s.monitorMode)} · ${esc(s.language)}</div>
      <div style="margin:8px 0">${countsBadges(s.counts)}</div>
    </div>`);
    const actions = h('<div class="row"></div>');
    const refresh = h('<button class="btn sm">Refresh</button>');
    refresh.onclick = async () => { await api(`/series/${s.id}/refresh`, { method:'POST' }); toast('Refreshing…'); };
    const detail = h('<button class="btn sm">Chapters</button>');
    detail.onclick = () => showDetail(s.id);
    const del = h('<button class="btn sm">Unfollow</button>');
    del.onclick = async () => { if (confirm(`Unfollow ${s.title}?`)) { await api(`/series/${s.id}`, { method:'DELETE' }); route(); } };
    actions.append(refresh, detail, del);
    card.appendChild(actions);
    grid.appendChild(card);
  }
  v.appendChild(grid);
}

async function showDetail(id) {
  const v = $('#view'); v.innerHTML = '<p class="muted">Loading…</p>';
  const s = await api(`/series/${id}`);
  v.innerHTML = '';
  const back = h('<button class="btn sm">← Library</button>'); back.onclick = route;
  v.appendChild(h(`<div class="card"><div class="title-row"><h2>${esc(s.title)}</h2></div>
    <div class="row" id="modes"></div></div>`));
  $('.card', v).prepend(back);

  // Editable modes
  const modes = $('#modes', v);
  modes.append(field('Monitor', ['all','future','none'], s.monitorMode, async val => { await api(`/series/${id}`,{method:'PATCH',body:{monitorMode:val}}); toast('Saved'); }));
  modes.append(field('Packaging', ['volume','chapter'], s.packagingMode, async val => { await api(`/series/${id}`,{method:'PATCH',body:{packagingMode:val}}); toast('Saved'); }));

  const table = h(`<div class="card"><table><thead><tr><th>Ch</th><th>Vol</th><th>Title</th><th>State</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const tb = $('tbody', table);
  for (const c of s.chapters) {
    const tr = h(`<tr><td>${esc(c.number)}</td><td>${esc(c.volume||'—')}</td><td>${esc(c.title||'')}</td>
      <td><span class="pill ${STATE_PILL[c.state]||''}">${c.state}</span>${c.error?` <span class="muted" title="${esc(c.error)}">⚠</span>`:''}</td><td></td></tr>`);
    if (c.state === 'failed' || c.state === 'skipped') {
      const btn = h('<button class="btn sm">Retry</button>');
      btn.onclick = async () => { await api(`/chapters/${c.id}/retry`,{method:'POST'}); showDetail(id); };
      $('td:last-child', tr).appendChild(btn);
    }
    tb.appendChild(tr);
  }
  v.appendChild(table);
}

function field(label, options, value, onChange) {
  const wrap = h(`<label class="field">${label}</label>`);
  const sel = h(`<select>${options.map(o=>`<option ${o===value?'selected':''}>${o}</option>`).join('')}</select>`);
  sel.onchange = () => onChange(sel.value);
  wrap.appendChild(sel);
  return wrap;
}

// --- Add -------------------------------------------------------------------
async function viewAdd(v) {
  v.innerHTML = '';
  const providers = (await api('/providers')).filter(p => p.capabilities.download && p.enabled);
  const card = h(`<div class="card"><h2>Search a source</h2><div class="row">
    <select id="prov">${providers.map(p=>`<option value="${p.name}">${esc(p.label)}</option>`).join('')}</select>
    <input id="q" placeholder="Manga title…" style="flex:1;min-width:200px" />
    <button class="btn primary" id="go">Search</button></div></div>`);
  v.appendChild(card);
  const results = h('<div id="results"></div>'); v.appendChild(results);
  const doSearch = async () => {
    const q = $('#q', card).value.trim(); if (!q) return;
    results.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const { results: rs, provider } = await api(`/search?provider=${$('#prov',card).value}&q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      if (!rs.length) { results.innerHTML = '<p class="muted">No results.</p>'; return; }
      for (const r of rs) {
        const row = h(`<div class="card row"><strong style="flex:1">${esc(r.title)}</strong>
          <select class="pk"><option value="volume">volume CBZ</option><option value="chapter">chapter CBZ</option></select>
          <select class="mm"><option value="all">all</option><option value="future">future only</option></select></div>`);
        const add = h('<button class="btn primary">Follow</button>');
        add.onclick = async () => {
          add.disabled = true; add.textContent = 'Following…';
          try { await api('/series',{method:'POST',body:{provider,providerSeriesId:r.id,packagingMode:$('.pk',row).value,monitorMode:$('.mm',row).value}}); toast('Following '+r.title); current='Library'; route(); }
          catch(e){ toast(e.message); add.disabled=false; add.textContent='Follow'; }
        };
        row.appendChild(add); results.appendChild(row);
      }
    } catch (e) { results.innerHTML = `<div class="card"><span class="pill err">error</span> ${esc(e.message)}</div>`; }
  };
  $('#go', card).onclick = doSearch;
  $('#q', card).addEventListener('keydown', e => { if (e.key==='Enter') doSearch(); });
}

// --- Activity --------------------------------------------------------------
async function viewActivity(v) {
  const [queue, history] = await Promise.all([api('/queue'), api('/history')]);
  v.innerHTML = '';
  const q = h(`<div class="card"><h2>Queue (${queue.length})</h2><table><thead><tr><th>Series</th><th>Ch</th><th>State</th><th>Att.</th></tr></thead><tbody></tbody></table></div>`);
  for (const c of queue) $('tbody', q).appendChild(h(`<tr><td>#${c.seriesId}</td><td>${esc(c.number)}</td><td><span class="pill ${STATE_PILL[c.state]||''}">${c.state}</span></td><td>${c.attempts}</td></tr>`));
  if (!queue.length) $('tbody', q).appendChild(h('<tr><td colspan="4" class="muted">Idle.</td></tr>'));
  v.appendChild(q);
  const hi = h(`<div class="card"><h2>History</h2><table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody></tbody></table></div>`);
  for (const e of history) $('tbody', hi).appendChild(h(`<tr><td class="muted">${esc(e.ts)}</td><td>${esc(e.event)}</td><td>${esc(e.message||'')}</td></tr>`));
  if (!history.length) $('tbody', hi).appendChild(h('<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'));
  v.appendChild(hi);
}

// --- Settings --------------------------------------------------------------
async function viewSettings(v) {
  const [settings, providers] = await Promise.all([api('/settings'), api('/providers')]);
  v.innerHTML = '';
  const numKeys = ['scanIntervalHours','downloadConcurrency'];
  const enumKeys = { defaultPackagingMode:['volume','chapter'], defaultMonitorMode:['all','future','none'] };
  const boolKeys = ['dataSaver','keepLoosePages'];

  const sc = h('<div class="card"><h2>Settings</h2></div>');
  const form = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:10px"></div>');
  for (const k of [...numKeys, ...Object.keys(enumKeys), ...boolKeys, 'defaultLanguage']) {
    if (!(k in settings)) continue;
    const row = h(`<label class="field">${k}</label>`);
    let inp;
    if (numKeys.includes(k)) inp = h(`<input type="number" value="${esc(settings[k])}" style="width:140px">`);
    else if (boolKeys.includes(k)) { inp = h(`<select style="width:140px"><option value="true">true</option><option value="false">false</option></select>`); inp.value = String(settings[k]); }
    else if (enumKeys[k]) inp = h(`<select style="width:140px">${enumKeys[k].map(o=>`<option ${o===settings[k]?'selected':''}>${o}</option>`).join('')}</select>`);
    else inp = h(`<input value="${esc(settings[k])}" style="width:140px">`);
    inp.dataset.key = k; row.appendChild(inp); form.appendChild(row);
  }
  const save = h('<button class="btn primary" style="align-self:flex-start">Save settings</button>');
  save.onclick = async () => {
    const body = {};
    for (const el of form.querySelectorAll('[data-key]')) {
      const k = el.dataset.key;
      body[k] = numKeys.includes(k) ? Number(el.value) : boolKeys.includes(k) ? el.value==='true' : el.value;
    }
    await api('/settings',{method:'PATCH',body}); toast('Saved');
  };
  form.appendChild(save); sc.appendChild(form); v.appendChild(sc);

  const pc = h('<div class="card"><h2>Sources</h2></div>');
  for (const p of providers) {
    const row = h(`<div class="row" style="justify-content:space-between"><div><strong>${esc(p.label)}</strong>
      <span class="pill ${p.capabilities.download?'acc':''}">${p.capabilities.download?'download':'metadata'}</span></div></div>`);
    const tg = h(`<button class="btn sm">${p.enabled?'Enabled':'Disabled'}</button>`);
    tg.classList.toggle('primary', p.enabled);
    tg.onclick = async () => { await api(`/providers/${p.name}`,{method:'PATCH',body:{enabled:!p.enabled}}); viewSettings(v); };
    row.appendChild(tg); pc.appendChild(row);
  }
  v.appendChild(pc);
}

route();
