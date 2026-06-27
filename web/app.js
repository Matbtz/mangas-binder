// Minimal no-build SPA for mangas-binder.
const $ = (sel, el = document) => el.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

// Auth token persisted in localStorage (only needed if server sets AUTH_TOKEN).
const token = () => localStorage.getItem('mb_token') || '';
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const method = (opts.method || 'GET').toUpperCase();
  const needsBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : needsBody ? '{}' : undefined;
  const res = await fetch(`/api${path}`, { ...opts, headers, body });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

const STATE_PILL = { imported:'ok', bindery:'queued', downloaded:'acc', downloading:'acc', queued:'', wanted:'warn', failed:'err', skipped:'' };
const countsBadges = (c = {}) => Object.entries(c).map(([s,n]) => `<span class="pill ${STATE_PILL[s]||''}">${s} ${n}</span>`).join(' ');

const TABS = ['Library', 'Add', 'Activity', 'Settings'];

// --- Hash routing ----------------------------------------------------------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [seg, arg] = raw.split('/');
  return { seg: (seg || 'library').toLowerCase(), arg };
}
/** Navigate to a hash; if already there, re-render in place. */
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// --- Live updates: Server-Sent Events with a slow polling fallback ---------
// One shared EventSource pushes pipeline changes; views refresh on a message
// (debounced) instead of every view hammering the API on a fixed 2s timer. The
// fallback interval is a safety net for missed events / proxies that drop SSE.
let _es = null;
const _esListeners = new Set();
function ensureEventSource() {
  if (_es || typeof EventSource === 'undefined') return;
  const t = token();
  try {
    _es = new EventSource('/api/events' + (t ? `?token=${encodeURIComponent(t)}` : ''));
    _es.onmessage = () => { for (const l of [..._esListeners]) l(); };
    _es.onerror = () => { /* EventSource reconnects on its own */ };
  } catch { _es = null; }
}

let _stopPoll = null;
function clearPolling() { if (_stopPoll) { _stopPoll(); _stopPoll = null; } }
/**
 * Run `fn` on every live event (debounced) plus a slow fallback timer.
 * Signature is unchanged; `ms` is now the fallback interval, not the cadence.
 */
function startPolling(fn, ms = 10000) {
  clearPolling();
  let stopped = false, timer = null, debounce = null;
  const run = async () => { if (stopped) return; try { await fn(); } catch { /* keep going through transient errors */ } };
  const onEvent = () => { if (stopped || debounce) return; debounce = setTimeout(() => { debounce = null; run(); }, 350); };
  const tick = async () => { if (stopped) return; await run(); if (!stopped) timer = setTimeout(tick, ms); };
  ensureEventSource();
  _esListeners.add(onEvent);
  timer = setTimeout(tick, ms);
  _stopPoll = () => { stopped = true; if (timer) clearTimeout(timer); if (debounce) clearTimeout(debounce); _esListeners.delete(onEvent); };
  return _stopPoll;
}

function renderNav() {
  const { seg } = parseHash();
  const activeTab = seg === 'series' ? 'library' : seg;
  const nav = $('#nav'); nav.innerHTML = '';
  for (const t of TABS) {
    const b = h(`<button class="${t.toLowerCase() === activeTab ? 'active' : ''}">${t}</button>`);
    b.onclick = () => navigate('#/' + t.toLowerCase());
    nav.appendChild(b);
  }
}

async function route() {
  clearPolling();
  renderNav();
  const v = $('#view'); v.innerHTML = '<p class="muted">Loading…</p>';
  const { seg, arg } = parseHash();
  try {
    if (seg === 'series' && arg) await showDetail(arg);
    else if (seg === 'add') await viewAdd(v);
    else if (seg === 'activity') await viewActivity(v);
    else if (seg === 'settings') await viewSettings(v);
    else await viewLibrary(v);
  } catch (e) { v.innerHTML = `<div class="card"><span class="pill err">error</span> ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// --- Cover art + progress helpers ------------------------------------------
function hueFromString(s) {
  let n = 0; for (let i = 0; i < (s || '').length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
  return n;
}
function initials(title) {
  const w = String(title || '?').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '?';
}
/** Fallback gradient+initials layer, plus the cover <img> on top when available. */
function coverArt(coverPath, title) {
  const hue = hueFromString(title || '');
  const fb = `<div class="poster-fallback" style="background:linear-gradient(150deg,hsl(${hue},42%,34%),hsl(${(hue + 45) % 360},45%,20%))">${esc(initials(title))}</div>`;
  if (!coverPath) return fb;
  return `${fb}<img src="${esc(coverPath)}" alt="${esc(title)}" loading="lazy" onerror="this.remove()">`;
}
/** Determinate bar when total>0, else indeterminate. */
function progressBar(done, total, extraCls = '') {
  if (total && total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    return `<div class="progress ${pct >= 100 ? 'complete' : extraCls}"><i style="width:${pct}%"></i></div>`;
  }
  return `<div class="progress indet ${extraCls}"><i></i></div>`;
}
const ACTIVE_STATES = ['downloading', 'wanted', 'queued', 'downloaded', 'bindery'];
const hasActive = (counts = {}) => ACTIVE_STATES.some(s => (counts[s] || 0) > 0);

/** Close any open dropdown menu. */
function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
document.addEventListener('click', () => closeMenus());

/** A button that toggles a dropdown of { label, icon?, danger?, onClick } items. */
function menuButton(label, items, btnCls = 'btn sm icon') {
  const wrap = h('<span class="menu-wrap"></span>');
  const btn = h(`<button class="${btnCls}">${label}</button>`);
  wrap.appendChild(btn);
  btn.onclick = (e) => {
    e.stopPropagation();
    const existing = wrap.querySelector('.menu');
    closeMenus();
    if (existing) return;
    const menu = h('<div class="menu"></div>');
    for (const it of items.filter(Boolean)) {
      const mb = h(`<button><span>${it.icon || '•'}</span><span>${esc(it.label)}</span></button>`);
      if (it.danger) mb.style.color = 'var(--err)';
      mb.onclick = (ev) => { ev.stopPropagation(); closeMenus(); it.onClick(); };
      menu.appendChild(mb);
    }
    wrap.appendChild(menu);
  };
  return wrap;
}

// --- Library ---------------------------------------------------------------
/** Library "progress": imported chapters over the chapters we intend to own (excludes skipped). */
function libProgress(counts = {}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const denom = total - (counts.skipped || 0);
  const owned = (counts.imported || 0) + (counts.bindery || 0);
  return { owned, denom, total };
}

let _libState = { q: '', filter: 'all', sort: 'title' };

async function viewLibrary(v) {
  const [series, health] = await Promise.all([api('/series'), api('/health')]);
  v.innerHTML = '';

  // Page header
  const head = h(`<div class="page-head">
    <h1>Library</h1>
    <span class="count">${series.length} series</span>
    <span class="pill ${health.scheduler.running ? 'ok' : 'warn'}" title="Auto-scan scheduler">${health.scheduler.running ? '● scheduler on' : '○ scheduler off'} · ${health.scheduler.intervalHours}h</span>
    <div class="spacer"></div>
  </div>`);
  const scanLibBtn = h('<button class="btn sm">📁 Scan library</button>');
  scanLibBtn.onclick = async () => {
    scanLibBtn.disabled = true; scanLibBtn.textContent = 'Scanning…';
    try { const r = await api('/library/scan', { method:'POST' }); toast(`Marked ${r.markedChapters} owned across ${r.matchedFiles} file(s)`); route(); }
    catch (e) { toast(e.message); scanLibBtn.disabled = false; scanLibBtn.textContent = '📁 Scan library'; }
  };
  const scanBtn = h('<button class="btn sm primary">↻ Scan now</button>');
  scanBtn.onclick = async () => { await api('/scan', { method:'POST' }); toast('Scan started — checking sources for new chapters'); };
  head.querySelector('.spacer').after(scanLibBtn, scanBtn);
  v.appendChild(head);

  if (!series.length) {
    v.appendChild(h('<div class="empty"><div class="big">📚</div><div>No series followed yet.</div><p class="muted">Use the <b>Add</b> tab to search a source and follow your first series.</p></div>'));
  } else {
    // Toolbar: search · filter chips · sort
    const FILTERS = [['all','All'],['manga','Manga'],['comic','Comics'],['monitored','Monitored'],['missing','Missing'],['downloading','Downloading']];
    const toolbar = h(`<div class="toolbar">
      <div class="search"><input id="lib-q" placeholder="Search library…" value="${esc(_libState.q)}"></div>
      <div class="chips" id="lib-filters">${FILTERS.map(([k,l]) => `<button class="chip ${_libState.filter===k?'active':''}" data-f="${k}">${l}</button>`).join('')}</div>
      <select id="lib-sort" title="Sort">
        <option value="title">A–Z</option>
        <option value="updated">Recently updated</option>
        <option value="progress">Least complete</option>
      </select>
    </div>`);
    toolbar.querySelector('#lib-sort').value = _libState.sort;
    v.appendChild(toolbar);

    const grid = h('<div class="poster-grid"></div>');
    v.appendChild(grid);

    const renderGrid = () => {
      const q = _libState.q.trim().toLowerCase();
      let list = series.filter(s => {
        if (q && !(`${s.title} ${s.publisher||''} ${s.authors.join(' ')}`.toLowerCase().includes(q))) return false;
        const f = _libState.filter;
        if (f === 'manga') return (s.mediaType||'manga') === 'manga';
        if (f === 'comic') return s.mediaType === 'comic';
        if (f === 'monitored') return s.monitored;
        if (f === 'missing') { const { owned, denom } = libProgress(s.counts); return denom > owned; }
        if (f === 'downloading') return (s.counts?.downloading||0) > 0;
        return true;
      });
      list.sort((a, b) => {
        if (_libState.sort === 'updated') return String(b.lastScanAt||'').localeCompare(String(a.lastScanAt||''));
        if (_libState.sort === 'progress') {
          const pa = libProgress(a.counts), pb = libProgress(b.counts);
          return (pa.owned/(pa.denom||1)) - (pb.owned/(pb.denom||1));
        }
        return a.title.localeCompare(b.title);
      });
      grid.innerHTML = '';
      if (!list.length) { grid.appendChild(h('<p class="muted" style="grid-column:1/-1">No series match.</p>')); return; }
      for (const s of list) grid.appendChild(libPoster(s));
    };

    toolbar.querySelector('#lib-q').oninput = (e) => { _libState.q = e.target.value; renderGrid(); };
    toolbar.querySelector('#lib-filters').onclick = (e) => {
      const f = e.target.dataset?.f; if (!f) return;
      _libState.filter = f;
      toolbar.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.f === f));
      renderGrid();
    };
    toolbar.querySelector('#lib-sort').onchange = (e) => { _libState.sort = e.target.value; renderGrid(); };
    renderGrid();
  }

  // --- Untracked series found in the library ---
  try {
    const { untracked } = await api('/library/untracked');
    if (untracked.length) {
      const sec = h('<div><div class="section-head"><h2>In your library — not followed</h2><div class="line"></div></div><p class="muted" style="margin:-6px 0 14px">Found in your library folders but not tracked yet.</p></div>');
      const grid2 = h('<div class="grid"></div>');
      for (const u of untracked) {
        const provider = u.comicvineId ? 'comicvine' : (u.mangadexId ? 'mangadex' : null);
        const providerId = u.comicvineId || u.mangadexId;
        const comic = u.mediaType === 'comic';
        const volLabel = u.volumes.length
          ? `Vol. ${u.volumes.join(', ')} (${u.fileCount} file${u.fileCount!==1?'s':''})`
          : `${u.fileCount} file${u.fileCount!==1?'s':''}`;
        const idLabel = provider ? `${comic?'ComicVine':'MangaDex'} ID: ${providerId}` : 'No source ID found — follow manually via Add tab';
        const card = h(`<div class="card">
          <div class="title-row"><strong>${esc(u.title)}</strong> <span class="pill">${esc(u.mediaType)}</span> <span class="pill">${esc(volLabel)}</span></div>
          <div class="muted" style="font-size:12px">${esc(idLabel)}</div>
        </div>`);
        if (provider) {
          const actions = h('<div class="row" style="margin-top:8px"></div>');
          const pk = h(`<select class="pk"><option value="chapter">per ${comic?'issue':'chapter'}</option><option value="volume">${comic?'collected':'volume'} CBZ</option></select>`);
          pk.value = comic ? 'chapter' : 'volume';
          const mm = h('<select class="mm"><option value="all">all</option><option value="future">future only</option></select>');
          const btn = h('<button class="btn primary sm">Follow</button>');
          btn.onclick = async () => {
            btn.disabled = true; btn.textContent = 'Following…';
            try {
              await api('/series', { method:'POST', body:{ provider, providerSeriesId: providerId, packagingMode: pk.value, monitorMode: mm.value } });
              toast('Following ' + u.title);
              route();
            } catch(e) { toast(e.message); btn.disabled = false; btn.textContent = 'Follow'; }
          };
          actions.append(pk, mm, btn);
          card.appendChild(actions);
        }
        grid2.appendChild(card);
      }
      sec.appendChild(grid2);
      v.appendChild(sec);
    }
  } catch { /* untracked endpoint failure shouldn't break the library view */ }
}

/** Build one Library poster card. */
function libPoster(s) {
  const { owned, denom } = libProgress(s.counts);
  const downloading = (s.counts?.downloading || 0) > 0;
  const dotCls = downloading ? 'dl' : (s.monitored ? 'on' : 'off');
  const statusText = downloading ? 'Downloading' : (s.monitored ? (s.status || 'monitored') : 'unmonitored');
  const mediaTag = (s.mediaType || 'manga') === 'comic' ? 'Comic' : 'Manga';
  const poster = h(`<div class="poster fade-in">
    <div class="poster-art">
      ${coverArt(s.coverPath, s.title)}
      <div class="poster-corner"><span class="poster-tag">${mediaTag}</span></div>
      <div class="poster-overlay"><div class="poster-actions"></div></div>
    </div>
    <div class="poster-meta">
      <div class="poster-title" title="${esc(s.title)}">${esc(s.title)}</div>
      <div class="poster-sub"><span class="dot ${dotCls}"></span>${esc(statusText)}<span class="grow"></span>${denom > 0 ? `${owned}/${denom}` : ''}</div>
      ${denom > 0 ? progressBar(owned, denom, downloading ? 'dl' : '') : ''}
    </div>
  </div>`);
  poster.onclick = () => navigate('#/series/' + s.id);

  const openBtn = h('<button class="btn sm primary" style="flex:1">Open</button>');
  openBtn.onclick = (e) => { e.stopPropagation(); navigate('#/series/' + s.id); };
  const refreshBtn = h('<button class="btn sm icon" title="Refresh from source">↻</button>');
  refreshBtn.onclick = async (e) => {
    e.stopPropagation();
    refreshBtn.disabled = true; refreshBtn.textContent = '…';
    try { await api(`/series/${s.id}/refresh`, { method: 'POST' }); toast('Refreshing ' + s.title + '…'); }
    catch (err) { toast(err.message); }
    refreshBtn.disabled = false; refreshBtn.textContent = '↻';
  };
  const more = menuButton('⋯', [
    { label: 'Refresh & scan', icon: '↻', onClick: async () => { await api(`/series/${s.id}/refresh`, { method: 'POST' }); await api(`/series/${s.id}/scan-library`, { method: 'POST' }); toast('Refreshed & scanned'); } },
    { label: 'Unfollow', icon: '🗑', danger: true, onClick: async () => { if (confirm(`Unfollow ${s.title}?`)) { await api(`/series/${s.id}`, { method: 'DELETE' }); toast('Unfollowed'); route(); } } },
  ]);
  poster.querySelector('.poster-actions').append(openBtn, refreshBtn, more);
  return poster;
}

async function showDetail(id) {
  const v = $('#view'); v.innerHTML = '<p class="muted">Loading…</p>';
  const s = await api(`/series/${id}`);
  v.innerHTML = '';
  const comic = s.mediaType === 'comic';
  const volUnit = comic ? 'Collection' : 'Volume';
  const chUnit  = comic ? 'issue' : 'chapter';

  const heroProg = libProgress(s.counts);

  // --- Hero Header Card ---
  const hero = h(`<div class="hero-card">
    <div class="hero-poster-container">
      <div class="hero-poster" id="hero-poster" title="Click to set cover URL">
        ${coverArt(s.coverPath, s.title)}
        <div class="hero-poster-edit">✎ Set Cover</div>
      </div>
    </div>
    <div class="hero-content">
      <div>
        <div class="row" style="gap:10px;margin-bottom:10px">
          <h1 class="hero-title">${esc(s.title)}</h1>
          ${s.year ? `<span style="font-size:18px;color:var(--muted);font-weight:600">(${s.year})</span>` : ''}
        </div>
        <div class="row" style="gap:8px;margin-bottom:12px">
          <span class="status-badge queued">${esc(s.mediaType||'manga')}</span>
          <span class="status-badge ${s.status==='completed'?'imported':'queued'}">${esc(s.status||'ongoing')}</span>
          ${s.publisher ? `<span class="status-badge skipped">${esc(s.publisher)}</span>` : ''}
          <span class="status-badge ${s.monitored?'imported':'skipped'}">${s.monitored?'🏷 Monitored':'⏸ Unmonitored'}</span>
          <a href="${s.provider==='mangadex'?`https://mangadex.org/title/${s.providerSeriesId}`:`https://comicvine.gamespot.com/volume/4050-${s.providerSeriesId}/`}" target="_blank" class="status-badge skipped" style="color:var(--acc)">↗ ${esc(s.provider)}</a>
          <span class="status-badge ${s.folderPath?'imported':'skipped'}" style="cursor:pointer" id="folder-pill" title="Click to link local folder">📁 ${esc(s.folderPath||'Default Folder')}</span>
        </div>
        <p class="hero-desc">${esc(s.description||'No description available.')}</p>
      </div>
      <div id="hero-prog" style="display:flex;align-items:center;gap:12px;margin-top:6px">
        <span class="muted" style="font-size:12px;font-weight:700;min-width:64px" id="hero-prog-label">${heroProg.owned} / ${heroProg.denom}</span>
        <div style="flex:1;max-width:340px" id="hero-prog-bar">${progressBar(heroProg.owned, heroProg.denom)}</div>
        <span class="muted" style="font-size:11px" id="hero-prog-dl"></span>
      </div>
      <div class="hero-toolbar">
        <button class="btn sm" id="hd-back">← Library</button>
        <button class="btn sm primary" id="hd-refresh">↻ Refresh &amp; Scan</button>
        <button class="btn sm" id="hd-run" title="Drain the download queue now">▶ Run downloads</button>
        <button class="btn sm acc2" id="hd-package-all" title="Package all owned volumes into clean CBZs">📦 Package All</button>
        <span id="hd-more-slot"></span>
        <div class="row" id="modes" style="margin-left:auto;gap:8px"></div>
      </div>
    </div>
  </div>`);

  hero.querySelector('#hd-back').onclick = () => navigate('#/library');
  hero.querySelector('#hd-refresh').onclick = async () => {
    toast('Refreshing & scanning…');
    await api(`/series/${id}/refresh`,{method:'POST'});
    await api(`/series/${id}/scan-library`,{method:'POST'});
    showDetail(id);
  };
  hero.querySelector('#hd-run').onclick = async () => {
    await api('/downloads/run', { method:'POST' });
    toast('Running downloads…');
    startLive();
  };
  const linkFolderAction = async () => {
    const input = prompt(`Enter local folder path where files for "${s.title}" are stored:`, s.folderPath || '');
    if (input !== null) {
      const folderPath = input.trim() || null;
      toast('Linking folder & scanning library…');
      await api(`/series/${id}`, { method:'PATCH', body:{ folderPath } });
      await api(`/series/${id}/scan-library`, { method:'POST' });
      toast('Folder linked and scanned!');
      showDetail(id);
    }
  };
  hero.querySelector('#folder-pill').onclick = linkFolderAction;

  hero.querySelector('#hd-package-all').onclick = async () => {
    toast('Auditing volumes…');
    const alerts = await api(`/series/${id}/audit-volumes`);
    const LOCAL_STATES = new Set(['imported', 'downloaded', 'bindery']);
    const allVols = [...groups.keys()]
      .filter(k => k !== 'none' && k !== 'Specials')
      .filter(k => groups.get(k).some(c => LOCAL_STATES.has(c.state)));
    if (!allVols.length) { toast('No volumes with local chapters to package!'); return; }

    openPackageAuditModal({
      title: `📦 Batch Package Volumes - ${s.title}`,
      allVols,
      alerts,
      onProceed: async (selectedVols) => {
        toast(`Packaging ${selectedVols.length} volumes…`);
        const res = await api(`/series/${id}/package-volumes`, { method: 'POST', body: { volumes: selectedVols } });
        toast(`Successfully packaged ${res?.packagedCount || 0} volumes!`);
        showDetail(id);
      }
    });
  };

  // Secondary actions tucked into a "More" menu to declutter the toolbar.
  const moreMenu = menuButton('⋯ More', [
    { label: 'Link local folder', icon: '📁', onClick: linkFolderAction },
    { label: 'Extrapolate volumes', icon: '🪄', onClick: async () => { toast('Extrapolating volumes…'); await api(`/series/${id}/extrapolate-volumes`, { method:'POST' }); toast('Distributed chapters into volumes!'); showDetail(id); } },
    { label: 'Link / change MangaDex', icon: '🔗', onClick: async () => {
        const input = prompt(`Enter MangaDex Series ID or URL to link with ${s.title}:`, s.provider === 'mangadex' ? s.providerSeriesId : '');
        if (!input) return;
        let mdxId = input.trim();
        const match = mdxId.match(/mangadex\.org\/title\/([a-f0-9-]+)/i);
        if (match) mdxId = match[1];
        toast('Linking with MangaDex…');
        try { await api(`/series/${id}/link-mangadex`, { method:'POST', body:{ providerSeriesId: mdxId } }); toast('Linked to MangaDex!'); showDetail(id); }
        catch (e) { alert('Failed to link MangaDex: ' + (e.message || e)); }
      } },
    { label: 'Retry all failed', icon: '↻', onClick: async () => { const r = await api(`/series/${id}/retry-failed`, { method:'POST' }); toast(`Re-queued ${r.retried||0} failed`); startLive(); showDetail(id); } },
    { label: 'Cancel all downloads', icon: '✕', danger: true, onClick: async () => { const r = await api(`/series/${id}/cancel`, { method:'POST' }); toast(`Cancelled ${r.cancelled||0}`); showDetail(id); } },
  ], 'btn sm');
  hero.querySelector('#hd-more-slot').replaceWith(moreMenu);

  hero.querySelector('#hero-poster').onclick = async () => {
    const url = prompt('Enter image URL for cover art:', s.coverPath || '');
    if (url !== null) {
      await api(`/series/${id}`, { method:'PATCH', body:{ coverPath: url.trim() || null } });
      toast('Cover updated');
      showDetail(id);
    }
  };

  const modes = hero.querySelector('#modes');
  modes.append(
    field('Monitor',   ['all','future','none'],   s.monitorMode,   async v => { await api(`/series/${id}`,{method:'PATCH',body:{monitorMode:v}});   toast('Saved'); }),
    field('Packaging', ['volume','chapter'],       s.packagingMode, async v => { await api(`/series/${id}`,{method:'PATCH',body:{packagingMode:v}}); toast('Saved'); }),
    field('Language',  ['en','fr','ja','es','pt'], s.language,      async v => { await api(`/series/${id}`,{method:'PATCH',body:{language:v}});      toast('Saved'); })
  );
  v.appendChild(hero);

  // --- Group chapters by volume ---
  const groups = new Map(); // volume key → [{chapter}]
  for (const c of s.chapters) {
    const vk = (c.volume != null && c.volume !== '') ? c.volume : 'none';
    if (!groups.has(vk)) groups.set(vk, []);
    groups.get(vk).push(c);
  }
  const volKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'none') return 1; if (b === 'none') return -1;
    if (a === 'Specials') return 1; if (b === 'Specials') return -1;
    return parseFloat(a) - parseFloat(b);
  });

  // ---- Live status helpers (patch in place so expanded volumes are preserved) ----
  const volStats = (cs) => {
    const total = cs.length;
    const owned = cs.filter(c => c.state==='imported'||c.state==='bindery'||c.state==='downloaded').length;
    return { total, owned, complete: total>0 && owned===total };
  };
  const chapterStatusHTML = (c) => {
    switch (c.state) {
      case 'imported':    return `<span class="status-badge imported">✓ Available</span>`;
      case 'downloading': {
        const pct = c.progTotal ? Math.round((c.progDone/c.progTotal)*100) : null;
        return `<div class="dl-cell"><span class="status-badge downloading">⬇ ${pct!=null?pct+'%':'…'}</span>${progressBar(c.progDone, c.progTotal, 'dl')}</div>`;
      }
      case 'downloaded':  return `<span class="status-badge queued">⏳ Downloaded</span>`;
      case 'bindery':     return `<span class="status-badge queued" style="color:#cbb0f7;background:rgba(160,107,240,0.15);border-color:rgba(160,107,240,0.3)">⏳ Bindery</span>`;
      case 'wanted':      return `<span class="status-badge wanted">● Wanted</span>`;
      case 'queued':      return `<span class="status-badge queued">⏳ Queued</span>`;
      case 'failed':      return `<span class="status-badge failed" title="${esc(c.error||'')}">✕ Failed</span>`;
      case 'skipped':     return `<span class="status-badge skipped">⏸ Skipped</span>`;
      default:            return `<span class="status-badge queued">${esc(c.state)}</span>`;
    }
  };
  const cancelChBtn = (c) => {
    const b = h('<button class="btn sm danger icon" title="Cancel download">✕</button>');
    b.onclick = async () => { await api(`/chapters/${c.id}/cancel`, { method:'POST' }); toast(`Cancelled ${chUnit} ${c.number}`); liveTick(); };
    return b;
  };
  const packageChBtn = (c) => {
    const b = h('<button class="btn sm acc2" title="Package into standalone CBZ">📦 CBZ</button>');
    b.onclick = async () => { toast(`Packaging ${chUnit} ${c.number}…`); const res = await api(`/series/${id}/chapters/${c.id}/package`, { method:'POST' }); if (res?.ok) toast(`📦 ${res.path}`); };
    return b;
  };
  const fillChapterActions = (act, c) => {
    act.innerHTML = '';
    const searchBtn = h('<button class="btn sm icon" title="Manual search">🔍</button>');
    searchBtn.onclick = () => openManualSearchModal({
      title: `Manual Search - ${s.title} #${c.number}`,
      defaultQuery: `${s.title} ${c.number}`,
      onDownload: async (url) => { await api(`/series/${id}/chapters/${c.id}/manual-download`, { method:'POST', body:{ url } }); toast('Override saved, download queued!'); startLive(); showDetail(id); }
    });
    if (c.state === 'imported') {
      const redl = h('<button class="btn sm icon" title="Re-download (overwrites the CBZ)">⟲</button>');
      redl.onclick = async () => { if (confirm(`Re-download ${chUnit} ${c.number}? This overwrites the existing file.`)) { await api(`/chapters/${c.id}/redownload`, { method:'POST' }); toast('Re-downloading…'); startLive(); liveTick(); } };
      act.append(packageChBtn(c), redl);
    } else if (c.state === 'downloaded') {
      act.append(packageChBtn(c), cancelChBtn(c));
    } else if (c.state === 'downloading') {
      act.append(cancelChBtn(c));
    } else if (c.state === 'bindery') {
      act.append(h('<span class="muted" style="font-size:11px;color:#cbb0f7">In Bindery</span>'));
    } else if (c.state === 'wanted' || c.state === 'queued') {
      const skip = h('<button class="btn sm" title="Cancel / skip">Skip</button>');
      skip.onclick = async () => { await api(`/chapters/${c.id}/cancel`, { method:'POST' }); toast(`${chUnit} ${c.number} skipped`); liveTick(); };
      act.append(skip);
    } else if (c.state === 'failed') {
      const retry = h('<button class="btn sm primary" title="Retry">↻ Retry</button>');
      retry.onclick = async () => { await api(`/chapters/${c.id}/retry`, { method:'POST' }); toast(`Retrying ${chUnit} ${c.number}…`); startLive(); liveTick(); };
      act.append(retry);
    } else if (c.state === 'skipped') {
      const want = h('<button class="btn sm primary" title="Mark as wanted">➕ Want</button>');
      want.onclick = async () => { await api(`/chapters/${c.id}/retry`, { method:'POST' }); toast(`${chUnit} ${c.number} wanted`); startLive(); liveTick(); };
      act.append(want);
    }
    act.append(searchBtn);
  };
  const updateVolumeBadges = (chapters) => {
    const g = new Map();
    for (const c of chapters) { const vk=(c.volume!=null&&c.volume!=='')?c.volume:'none'; if(!g.has(vk))g.set(vk,[]); g.get(vk).push(c); }
    for (const [vk, cs] of g) {
      const { total, owned, complete } = volStats(cs);
      const badge = v.querySelector(`[data-volbadge="${vk}"]`);
      if (badge) { badge.textContent = `${owned}/${total}`; badge.className = `progress-badge ${complete?'complete':owned>0?'partial':''}`; badge.setAttribute('data-volbadge', vk); }
      const bar = v.querySelector(`[data-volbar="${vk}"]`);
      if (bar) bar.innerHTML = progressBar(owned, total);
    }
  };
  const updateHeroProgress = (counts) => {
    const p = libProgress(counts);
    const lbl = v.querySelector('#hero-prog-label'); if (lbl) lbl.textContent = `${p.owned} / ${p.denom}`;
    const bar = v.querySelector('#hero-prog-bar'); if (bar) bar.innerHTML = progressBar(p.owned, p.denom);
    const dl = v.querySelector('#hero-prog-dl'); if (dl) { const n = counts.downloading||0; dl.textContent = n ? `⬇ ${n} downloading` : ''; }
  };
  const liveTick = async () => {
    let fresh;
    try { fresh = await api(`/series/${id}`); } catch { return; }
    for (const c of fresh.chapters) {
      const tr = v.querySelector(`tr[data-ch="${c.id}"]`);
      if (!tr) continue;
      const st = tr.querySelector('.st-cell'); if (st) st.innerHTML = chapterStatusHTML(c);
      const ac = tr.querySelector('.act-cell'); if (ac) fillChapterActions(ac, c);
    }
    updateVolumeBadges(fresh.chapters);
    updateHeroProgress(fresh.counts);
    if (!hasActive(fresh.counts)) clearPolling();
  };
  const startLive = () => startPolling(liveTick, 2000);

  // Bulk-state helper (volume-level Want/Skip) — patches in place, keeps expansion.
  const setStates = async (state, volume) => {
    await api(`/series/${id}/set-chapter-states`, { method:'POST', body:{ state, volume: volume === 'none' ? null : volume } });
    if (state === 'wanted') startLive();
    liveTick();
  };

  const openManualSearchModal = ({ title, defaultQuery, onDownload }) => {
    const existing = document.getElementById('search-modal');
    if (existing) existing.remove();

    const modal = h(`<div class="modal-backdrop" id="search-modal" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="modal-box" style="background:#1a1e24;border:1px solid #2e353f;border-radius:12px;width:100%;max-width:650px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,0.8);overflow:hidden">
        <div style="padding:16px 20px;border-bottom:1px solid #2e353f;display:flex;align-items:center;justify-content:space-between">
          <h3 style="margin:0;font-size:16px;color:#fff">${esc(title)}</h3>
          <button class="btn sm" id="modal-close" style="padding:2px 8px;font-size:16px">✕</button>
        </div>
        <div style="padding:16px 20px;border-bottom:1px solid #2e353f;display:flex;gap:10px">
          <input type="text" id="modal-query" value="${esc(defaultQuery)}" style="flex:1;background:#0d1117;border:1px solid #30363d;color:#fff;padding:8px 12px;border-radius:6px;font-size:14px">
          <button class="btn primary" id="modal-search">Search</button>
        </div>
        <div id="modal-results" style="padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px">
          <p class="muted">Searching archives…</p>
        </div>
      </div>
    </div>`);

    const close = () => modal.remove();
    modal.querySelector('#modal-close').onclick = close;
    modal.onclick = e => { if (e.target === modal) close(); };

    const doSearch = async () => {
      const resBox = modal.querySelector('#modal-results');
      const q = modal.querySelector('#modal-query').value.trim();
      if (!q) return;
      resBox.innerHTML = '<p class="muted">Searching archives…</p>';
      try {
        const list = await api(`/series/${id}/manual-search?query=${encodeURIComponent(q)}`);
        if (!list || !list.length) {
          resBox.innerHTML = '<p class="muted" style="color:var(--warn)">No results found.</p>';
          return;
        }
        resBox.innerHTML = '';
        for (const item of list) {
          const row = h(`<div style="background:#13171c;border:1px solid #252b33;padding:12px 14px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="color:#fff;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(item.title)}">${esc(item.title)}</div>
              <a href="${item.id}" target="_blank" style="color:var(--acc);font-size:11px;text-decoration:none">↗ View Post</a>
            </div>
            <button class="btn sm primary dl-trigger" style="white-space:nowrap">⬇️ Download</button>
          </div>`);
          row.querySelector('.dl-trigger').onclick = async () => {
            toast('Triggering manual download…');
            close();
            await onDownload(item.id);
          };
          resBox.appendChild(row);
        }
      } catch (err) {
        resBox.innerHTML = `<p style="color:var(--warn)">Search failed: ${esc(err.message||err)}</p>`;
      }
    };

    modal.querySelector('#modal-search').onclick = doSearch;
    modal.querySelector('#modal-query').onkeydown = e => { if (e.key === 'Enter') doSearch(); };
    document.body.appendChild(modal);
    doSearch();
  };

  // --- Sonarr Volume Sections ---
  for (const vk of volKeys) {
    const chaps = groups.get(vk);
    const total    = chaps.length;
    const owned    = chaps.filter(c => c.state === 'imported' || c.state === 'bindery' || c.state === 'downloaded').length;
    const imported = chaps.filter(c => c.state === 'imported').length;
    const isComplete = total > 0 && owned === total;
    const label    = vk === 'none' ? `Unknown ${volUnit}` : vk === 'Specials' ? 'Specials & Extras' : `${volUnit} ${vk}`;

    const sec = h(`<div class="vol-card"></div>`);

    // Volume header row
    const volHead = h(`<div class="vol-header">
      <span class="vol-chevron">▶</span>
      <span class="vol-bookmark">🔖</span>
      <strong style="font-size:15px;color:#fff;min-width:130px">${esc(label)}</strong>
      <div class="vol-progress" data-volbar="${esc(vk)}" style="margin-left:auto">${progressBar(owned, total)}</div>
      <div class="vol-pkg-slot" style="margin-right:4px"></div>
      <span class="progress-badge ${isComplete?'complete':owned>0?'partial':''}" data-volbadge="${esc(vk)}">${owned}/${total}</span>
      <div class="row vol-acts" style="gap:6px;margin-left:12px"></div>
    </div>`);

    const chevron = volHead.querySelector('.vol-chevron');
    const body    = h('<div class="vol-body"></div>');

    const availableChapsCount = chaps.filter(c => c.state === 'imported' || c.state === 'downloaded' || c.state === 'bindery').length;
    if (vk !== 'none' && availableChapsCount > 0) {
      const pkgVolBtn = h('<button class="btn sm acc2" title="Package volume into clean Tome CBZ">📦 CBZ</button>');
      pkgVolBtn.onclick = async (e) => {
        e.stopPropagation();
        toast(`Packaging Volume ${vk}…`);
        const res = await api(`/series/${id}/volumes/${encodeURIComponent(vk)}/package`, { method: 'POST' });
        if (res?.ok) toast(`📦 Created CBZ: ${res.path}`);
      };
      volHead.querySelector('.vol-pkg-slot').appendChild(pkgVolBtn);
    }

    volHead.addEventListener('click', e => {
      if (e.target.closest('.vol-acts, .vol-pkg-slot, .menu-wrap, button')) return;
      body.classList.toggle('open');
      chevron.classList.toggle('open');
      volHead.classList.toggle('open');
    });

    const actsContainer = volHead.querySelector('.vol-acts');
    if (vk === 'none') {
      const autoExtBtn = h('<button class="btn sm primary" style="background:var(--acc)" title="Distribute unknown chapters automatically">✨ Extrapolate All</button>');
      autoExtBtn.onclick = async () => {
        toast('Extrapolating volumes…');
        await api(`/series/${id}/extrapolate-volumes`, { method: 'POST' });
        showDetail(id);
      };
      const custVolBtn = h('<button class="btn sm" style="border-color:var(--acc)" title="Choose which volume to create from chapter range">📦 Choose Volumes…</button>');
      custVolBtn.onclick = () => {
        const modal = h(`<div class="modal-backdrop" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
          <div class="modal-box" style="background:#1a1e24;border:1px solid #2e353f;border-radius:12px;width:100%;max-width:420px;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 20px 40px rgba(0,0,0,0.8)">
            <h3 style="margin:0;font-size:16px;color:#fff">📦 Create Custom Volume</h3>
            <p class="muted" style="font-size:13px;margin:0">Assign un-volumed local chapters to a specific volume number.</p>
            <div style="display:flex;flex-direction:column;gap:10px">
              <label style="font-size:12px;color:#ccc">Volume Number:
                <input type="number" id="m-vnum" placeholder="e.g. 36" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#fff;padding:6px 10px;border-radius:6px;margin-top:4px">
              </label>
              <div style="display:flex;gap:10px">
                <label style="flex:1;font-size:12px;color:#ccc">From Chapter:
                  <input type="number" id="m-vfrom" placeholder="e.g. 363" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#fff;padding:6px 10px;border-radius:6px;margin-top:4px">
                </label>
                <label style="flex:1;font-size:12px;color:#ccc">To Chapter:
                  <input type="number" id="m-vto" placeholder="e.g. 372" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#fff;padding:6px 10px;border-radius:6px;margin-top:4px">
                </label>
              </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px">
              <button class="btn sm" id="m-cancel">Cancel</button>
              <button class="btn sm primary" id="m-save">Save Volume</button>
            </div>
          </div>
        </div>`);
        const close = () => modal.remove();
        modal.querySelector('#m-cancel').onclick = close;
        modal.querySelector('#m-save').onclick = async () => {
          const v = modal.querySelector('#m-vnum').value.trim();
          const f = parseFloat(modal.querySelector('#m-vfrom').value);
          const t = parseFloat(modal.querySelector('#m-vto').value);
          if (!v || Number.isNaN(f) || Number.isNaN(t)) { toast('Invalid fields!'); return; }
          await api(`/series/${id}/custom-volume`, { method: 'POST', body: { volume: v, from: f, to: t } });
          toast(`Volume ${v} created!`);
          close();
          showDetail(id);
        };
        document.body.appendChild(modal);
      };
      actsContainer.append(autoExtBtn, custVolBtn);
    } else if (isComplete) {
      actsContainer.append(h('<span class="status-badge imported" style="padding:5px 10px">✓ Available</span>'));
    } else {
      const wantBtn = h('<button class="btn sm primary" title="Mark missing chapters in volume as wanted">➕ Want</button>');
      wantBtn.onclick = () => setStates('wanted', vk);
      const skipBtn = h('<button class="btn sm" title="Skip remaining in volume">⏸ Skip</button>');
      skipBtn.onclick = () => setStates('skipped', vk);
      actsContainer.append(wantBtn, skipBtn);
    }
    const searchVolBtn = h('<button class="btn sm" title="Manual Search for Volume">🔍</button>');
    searchVolBtn.onclick = () => {
      openManualSearchModal({
        title: `Manual Search - ${s.title} Vol. ${vk}`,
        defaultQuery: `${s.title} ${vk === 'none' ? '' : vk}`.trim(),
        onDownload: async (url) => {
          await api(`/series/${id}/volumes/${encodeURIComponent(vk)}/manual-download`, { method:'POST', body:{ url } });
          toast('Override saved, download queued!');
          showDetail(id);
        }
      });
    };
    actsContainer.append(searchVolBtn);

    // Chapter table (inside collapsible body)
    const tbl = h(`<table class="chapter-table">
      <thead>
        <tr>
          <th style="width:60px">#</th>
          <th>Title</th>
          <th style="width:140px">Release Date</th>
          <th style="width:140px">Status</th>
          <th style="width:120px;text-align:right">Action</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>`);
    const tb = tbl.querySelector('tbody');

    for (const c of chaps) {
      const dateStr = c.publishedAt ? new Date(c.publishedAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '—';
      const ownedState = c.state === 'imported' || c.state === 'bindery' || c.state === 'downloaded';
      const isDiffLang = !ownedState && c.language && c.language !== s.language;
      const langBadge = isDiffLang ? `<span class="pill warn" style="margin-left:8px" title="Available in ${esc(c.language)} on MangaDex, but series is set to ${esc(s.language)}.">⚠️ ${esc(c.language)}</span>` : '';

      const tr = h(`<tr data-ch="${c.id}">
        <td style="color:var(--muted);font-weight:600">${esc(c.number)}</td>
        <td>
          <span style="display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;vertical-align:middle" title="${esc(c.title||`Chapter ${c.number}`)}">${esc(c.title||`Chapter ${c.number}`)}</span>
          ${langBadge}
        </td>
        <td style="color:var(--muted);font-size:12px">${esc(dateStr)}</td>
        <td class="st-cell">${chapterStatusHTML(c)}</td>
        <td class="act-cell" style="display:flex;justify-content:flex-end;align-items:center;gap:6px"></td>
      </tr>`);
      fillChapterActions(tr.querySelector('.act-cell'), c);
      tb.appendChild(tr);
    }
    body.appendChild(tbl);
    sec.appendChild(volHead);
    sec.appendChild(body);
    v.appendChild(sec);
  }

  // Kick off live polling if anything is actively downloading/queued.
  if (hasActive(s.counts)) startLive();
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
  v.appendChild(h('<div class="page-head"><h1>Add a series</h1></div>'));
  // Searchable sources = metadata providers (MangaDex for manga, ComicVine for comics).
  const providers = (await api('/providers')).filter(p => p.capabilities.metadata && p.enabled);
  const byName = Object.fromEntries(providers.map(p => [p.name, p]));
  const card = h(`<div class="card"><h2>Search a source</h2><div class="row">
    <select id="prov">${providers.map(p=>`<option value="${p.name}">${esc(p.label)} (${p.mediaType})</option>`).join('')}</select>
    <input id="q" placeholder="Title…" style="flex:1;min-width:200px" />
    <button class="btn primary" id="go">Search</button></div>
    <p class="muted" id="provhint" style="font-size:12px;margin:8px 0 0"></p></div>`);
  v.appendChild(card);
  const results = h('<div id="results"></div>'); v.appendChild(results);

  const isComic = () => (byName[$('#prov',card).value]?.mediaType === 'comic');
  const updateHint = () => {
    $('#provhint', card).textContent = isComic()
      ? 'Comics: metadata from ComicVine, files from GetComics. Defaults to one CBZ per issue.'
      : 'Manga: metadata + pages from MangaDex.';
    $('#q', card).placeholder = isComic() ? 'Comic series title…' : 'Manga title…';
  };
  $('#prov', card).onchange = updateHint;
  updateHint();

  const doSearch = async () => {
    const q = $('#q', card).value.trim(); if (!q) return;
    results.innerHTML = '<p class="muted">Searching…</p>';
    try {
      const { results: rs, provider } = await api(`/search?provider=${$('#prov',card).value}&q=${encodeURIComponent(q)}`);
      const comic = isComic();
      const unit = comic ? 'issue' : 'chapter';
      const coll = comic ? 'collected volume' : 'volume';
      results.innerHTML = '';
      if (!rs.length) { results.innerHTML = '<p class="muted">No results.</p>'; return; }
      for (const r of rs) {
        const meta = [r.publisher, r.year, r.issueCount ? `${r.issueCount} issues` : null].filter(Boolean).join(' · ');
        const row = h(`<div class="card row"><div style="flex:1"><strong>${esc(r.title)}</strong>${meta?`<div class="muted" style="font-size:12px">${esc(meta)}</div>`:''}</div>
          <select class="pk"><option value="chapter">per ${unit}</option><option value="volume">${coll} CBZ</option></select>
          <select class="mm"><option value="all">all</option><option value="future">future only</option></select></div>`);
        // Manga default to volume packaging; comics default to per-issue.
        $('.pk', row).value = comic ? 'chapter' : 'volume';
        const add = h('<button class="btn primary">Follow</button>');
        add.onclick = async () => {
          add.disabled = true; add.textContent = 'Following…';
          try { await api('/series',{method:'POST',body:{provider,providerSeriesId:r.id,packagingMode:$('.pk',row).value,monitorMode:$('.mm',row).value}}); toast('Following '+r.title); navigate('#/library'); }
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
  v.innerHTML = '';

  const head = h(`<div class="page-head">
    <h1>Activity</h1>
    <span class="pill" id="sched-pill">—</span>
    <div class="spacer"></div>
  </div>`);
  const runBtn = h('<button class="btn sm primary" title="Drain the queue now">▶ Run downloads</button>');
  runBtn.onclick = async () => { await api('/downloads/run', { method:'POST' }); toast('Running downloads…'); load(); };
  const retryBtn = h('<button class="btn sm" title="Re-queue every failed item">↻ Retry all failed</button>');
  retryBtn.onclick = async () => { const r = await api('/downloads/retry-failed', { method:'POST' }); toast(`Re-queued ${r.retried||0} failed`); load(); };
  const cancelBtn = h('<button class="btn sm danger" title="Cancel everything active">✕ Cancel all</button>');
  cancelBtn.onclick = async () => { if (confirm('Cancel all active downloads?')) { const r = await api('/downloads/cancel-all', { method:'POST' }); toast(`Cancelled ${r.cancelled||0}`); load(); } };
  head.querySelector('.spacer').after(runBtn, retryBtn, cancelBtn);
  v.appendChild(head);

  const queueWrap = h('<div></div>'); v.appendChild(queueWrap);
  const histWrap = h('<div></div>'); v.appendChild(histWrap);

  const qThumb = (c) => `<div class="q-thumb">${coverArt(c.seriesCover, c.seriesTitle || ('#' + c.seriesId))}</div>`;
  const unit = (c) => (c.seriesMediaType === 'comic' ? 'Issue' : 'Ch.');

  const qRow = (c) => {
    const row = h(`<div class="q-row">
      ${qThumb(c)}
      <div class="q-main">
        <div class="q-title" title="${esc(c.seriesTitle||'')}">${esc(c.seriesTitle || ('Series #' + c.seriesId))}</div>
        <div class="q-sub">${unit(c)} ${esc(c.number)}${c.attempts ? ` · attempt ${c.attempts}` : ''}${c.state==='failed' && c.error ? ` · ${esc(c.error)}` : ''}</div>
      </div>
      <div class="q-status"></div>
      <div class="q-actions"></div>
    </div>`);
    const st = row.querySelector('.q-status');
    const ac = row.querySelector('.q-actions');
    if (c.state === 'downloading') {
      const pct = c.progTotal ? Math.round((c.progDone/c.progTotal)*100) : null;
      st.innerHTML = `${progressBar(c.progDone, c.progTotal, 'dl')}<span class="muted" style="font-size:11px;min-width:30px">${pct!=null?pct+'%':'…'}</span>`;
    } else if (c.state === 'failed') {
      st.innerHTML = `<span class="status-badge failed">✕ Failed</span>`;
    } else {
      st.innerHTML = `<span class="status-badge ${c.state==='downloaded'?'queued':'wanted'}">${c.state==='downloaded'?'⏳ Processing':'● Queued'}</span>`;
    }
    const goto = h('<button class="btn sm icon" title="Open series">↗</button>');
    goto.onclick = () => navigate('#/series/' + c.seriesId);
    if (c.state === 'failed') {
      const retry = h('<button class="btn sm primary" title="Retry">↻</button>');
      retry.onclick = async () => { await api(`/chapters/${c.id}/retry`, { method:'POST' }); toast('Retrying…'); load(); };
      ac.append(retry);
    }
    const x = h('<button class="btn sm danger icon" title="Cancel">✕</button>');
    x.onclick = async () => { await api(`/chapters/${c.id}/cancel`, { method:'POST' }); toast('Cancelled'); load(); };
    ac.append(x, goto);
    return row;
  };

  const renderQueue = (queue) => {
    const downloading = queue.filter(c => c.state === 'downloading');
    const pending = queue.filter(c => ['wanted','queued','downloaded'].includes(c.state));
    const failed = queue.filter(c => c.state === 'failed');
    queueWrap.innerHTML = '';
    const section = (title, items, accent) => {
      const sec = h(`<div><div class="section-head"><h2>${title} <span class="count">${items.length}</span></h2><div class="line"></div></div></div>`);
      const list = h('<div class="q-list"></div>');
      for (const c of items) list.appendChild(qRow(c));
      sec.appendChild(list);
      return sec;
    };
    if (downloading.length) queueWrap.appendChild(section('⬇ Downloading now', downloading));
    if (pending.length) queueWrap.appendChild(section('● Queued', pending));
    if (failed.length) queueWrap.appendChild(section('✕ Failed', failed));
    if (!queue.length) queueWrap.appendChild(h('<div class="empty"><div class="big">✓</div><div>Queue is idle</div><p class="muted">Nothing downloading right now.</p></div>'));
  };

  const renderHist = (history) => {
    histWrap.innerHTML = '';
    const hi = h(`<div class="card"><div class="section-head"><h2>History</h2><div class="line"></div></div><table><thead><tr><th style="width:160px">When</th><th style="width:180px">Event</th><th>Detail</th></tr></thead><tbody></tbody></table></div>`);
    const tb = $('tbody', hi);
    for (const e of history) tb.appendChild(h(`<tr><td class="muted" style="font-size:12px">${esc(e.ts)}</td><td><span class="pill">${esc(e.event)}</span></td><td>${esc(e.message||'')}</td></tr>`));
    if (!history.length) tb.appendChild(h('<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'));
    histWrap.appendChild(hi);
  };

  const pauseBanner = h('<div></div>'); queueWrap.before(pauseBanner);
  const load = async () => {
    const [queue, health, history] = await Promise.all([api('/queue'), api('/health'), api('/history')]);
    const sp = v.querySelector('#sched-pill');
    if (sp) {
      const sc = health.scheduler;
      sp.className = `pill ${sc.scanning ? 'acc' : sc.running ? 'ok' : 'warn'}`;
      sp.textContent = sc.scanning ? '↻ scanning…' : sc.running ? `● scheduler on · ${sc.intervalHours}h` : '○ scheduler off';
    }
    pauseBanner.innerHTML = health.downloadsPaused
      ? `<div class="card" style="border-color:#a36;background:#3a1f2a"><strong>⏸ Downloads are paused.</strong> <span class="muted">Nothing will download or package until you resume in <a href="#/settings">Settings</a>.</span></div>`
      : '';
    renderQueue(queue);
    renderHist(history);
  };

  await load();
  startPolling(load, 2000);
}

// --- Settings --------------------------------------------------------------
async function viewSettings(v) {
  const [settings, providers] = await Promise.all([api('/settings'), api('/providers')]);
  v.innerHTML = '';
  v.appendChild(h('<div class="page-head"><h1>Settings</h1></div>'));

  // Prominent master switch: pause the whole download/package pipeline.
  const dlc = h('<div class="card"><h2>Downloads</h2></div>');
  const paused = !!settings.downloadsPaused;
  const prow = h(`<label class="field" style="display:flex;align-items:center;gap:10px">
    <input type="checkbox" ${paused ? 'checked' : ''}>
    <span>Pause all downloads <span class="muted" style="font-size:11px">— no fetching or packaging; useful while deploying/testing (env: DOWNLOADS_PAUSED)</span></span>
  </label>`);
  const pStatus = h(`<span class="pill ${paused ? 'warn' : 'ok'}">${paused ? '⏸ paused' : '● active'}</span>`);
  prow.querySelector('input').onchange = async (e) => {
    const val = e.target.checked;
    await api('/settings', { method:'PATCH', body:{ downloadsPaused: val } });
    pStatus.className = `pill ${val ? 'warn' : 'ok'}`; pStatus.textContent = val ? '⏸ paused' : '● active';
    toast(val ? 'Downloads paused' : 'Downloads resumed');
    if (!val) api('/downloads/run', { method:'POST' }).catch(()=>{});
  };
  const phead = h('<div class="row" style="align-items:center;gap:10px"></div>');
  phead.append(prow, pStatus); dlc.appendChild(phead); v.appendChild(dlc);

  const numKeys = ['scanIntervalHours','downloadConcurrency','chapterConcurrency','refreshConcurrency','seriesRefreshTimeoutSec'];
  // English is the default, French the backup — list them first in that order.
  const enumKeys = { defaultPackagingMode:['volume','chapter'], defaultMonitorMode:['all','future','none'], defaultLanguage:['en','fr','ja','es','pt'] };
  const boolKeys = ['dataSaver','keepLoosePages','extrapolateVolumes','mangaFallbackEnabled'];
  const textKeys = ['flaresolverrUrl'];

  const sc = h('<div class="card"><h2>General</h2></div>');
  const form = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:10px"></div>');
  for (const k of [...numKeys, ...Object.keys(enumKeys), ...boolKeys, ...textKeys]) {
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

  // Library / folder paths
  const lc = h('<div class="card"><h2>Folders</h2></div>');
  const lform = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:10px"></div>');

  const mkFolderRow = (label, key, placeholder, hint) => {
    const row = h(`<label class="field">${label}${hint ? `<span class="muted" style="font-size:11px;margin-left:6px">${hint}</span>` : ''}</label>`);
    const inp = h(`<input value="${esc(settings[key] ?? '')}" placeholder="${placeholder}" style="min-width:400px">`);
    inp.dataset.fkey = key; row.appendChild(inp); lform.appendChild(row);
    return inp;
  };
  mkFolderRow('Output directory', 'outputDir', './data/output', '— finished CBZs land here (env: OUTPUT_DIR)');
  mkFolderRow('Staging directory', 'stagingDir', './data/staging', '— in-progress downloads (env: STAGING_DIR)');
  mkFolderRow('Library scan directories', 'libraryScanDirs', './data/output', '— comma-separated paths scanned for already-owned files');

  const lsave = h('<button class="btn primary" style="align-self:flex-start">Save</button>');
  lsave.onclick = async () => {
    const body = {};
    for (const el of lform.querySelectorAll('[data-fkey]')) body[el.dataset.fkey] = el.value.trim();
    await api('/settings', { method:'PATCH', body }); toast('Saved — restart the server for path changes to take full effect');
  };
  lform.appendChild(lsave); lc.appendChild(lform); v.appendChild(lc);

  // Notifications
  const nc = h('<div class="card"><h2>Notifications</h2></div>');
  const nform = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:10px"></div>');
  const nFields = [
    ['discordWebhook','Discord webhook URL','text'],
    ['ntfyUrl','ntfy topic URL (e.g. https://ntfy.sh/my-topic)','text'],
    ['notifyOnImport','Notify when media is added','bool'],
    ['notifyOnError','Notify on failures','bool'],
  ];
  for (const [k,label,type] of nFields) {
    const row = h(`<label class="field">${label}</label>`);
    let inp;
    if (type==='bool') { inp = h(`<select style="width:160px"><option value="true">true</option><option value="false">false</option></select>`); inp.value = String(settings[k] ?? false); }
    else inp = h(`<input value="${esc(settings[k]??'')}" placeholder="(disabled)" style="min-width:320px">`);
    inp.dataset.nkey = k; row.appendChild(inp); nform.appendChild(row);
  }
  const nrow = h('<div class="row"></div>');
  const nsave = h('<button class="btn primary">Save notifications</button>');
  nsave.onclick = async () => {
    const body = {};
    for (const el of nform.querySelectorAll('[data-nkey]')) {
      const k = el.dataset.nkey;
      body[k] = (k==='notifyOnImport'||k==='notifyOnError') ? el.value==='true' : el.value;
    }
    await api('/settings',{method:'PATCH',body}); toast('Saved');
  };
  const ntest = h('<button class="btn">Send test</button>');
  ntest.onclick = async () => { try { await api('/notify/test',{method:'POST'}); toast('Test sent'); } catch(e){ toast(e.message); } };
  nrow.append(nsave, ntest); nform.appendChild(nrow); nc.appendChild(nform); v.appendChild(nc);

  const PROVIDER_CONFIG = {
    comicvine: [['apikey', 'ComicVine API key (comicvine.gamespot.com/api)', 'password']],
    getcomics: [['baseUrl', 'GetComics base URL (optional override)', 'text']],
    mangakatana: [['throttleMs', 'Request throttle in ms (min delay between requests, default 1000)', 'text']],
  };
  const capLabel = (c) => c.archive ? 'archive' : c.download ? 'download' : c.pageFallback ? 'fallback' : 'metadata';

  const pc = h('<div class="card"><h2>Sources</h2></div>');
  for (const p of providers) {
    const wrap = h('<div style="border-top:1px solid #2a2a2a;padding:10px 0"></div>');
    const row = h(`<div class="row" style="justify-content:space-between"><div><strong>${esc(p.label)}</strong>
      <span class="pill">${esc(p.mediaType)}</span>
      <span class="pill ${p.capabilities.download||p.capabilities.archive?'acc':''}">${capLabel(p.capabilities)}</span></div></div>`);
    const btns = h('<div class="row" style="gap:6px;align-items:center"></div>');
    const status = h('<span class="muted" style="font-size:12px"></span>');
    const test = h('<button class="btn sm">Test</button>');
    test.onclick = async () => {
      test.disabled = true; const prev = test.textContent; test.textContent = 'Testing…';
      status.className = 'muted'; status.style.fontSize = '12px'; status.textContent = '';
      try {
        const r = await api(`/providers/${p.name}/test`, { method:'POST' });
        status.innerHTML = `<span class="pill ${r.ok?'ok':'err'}">${r.ok?'✓':'✗'}</span> ${esc(r.message)}`;
      } catch (e) { status.innerHTML = `<span class="pill err">✗</span> ${esc(e.message)}`; }
      finally { test.disabled = false; test.textContent = prev; }
    };
    const tg = h(`<button class="btn sm">${p.enabled?'Enabled':'Disabled'}</button>`);
    tg.classList.toggle('primary', p.enabled);
    tg.onclick = async () => { await api(`/providers/${p.name}`,{method:'PATCH',body:{enabled:!p.enabled}}); viewSettings(v); };
    btns.append(test, tg); row.appendChild(btns); wrap.appendChild(row);
    wrap.appendChild(status);

    const fields = PROVIDER_CONFIG[p.name];
    if (fields) {
      const cfgForm = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:8px;margin-top:8px"></div>');
      for (const [key, label, type] of fields) {
        const f = h(`<label class="field" style="font-size:12px">${label}</label>`);
        const inp = h(`<input type="${type==='password'?'password':'text'}" value="${esc(p.config?.[key]??'')}" placeholder="(not set)" style="min-width:320px">`);
        inp.dataset.cfg = key; f.appendChild(inp); cfgForm.appendChild(f);
      }
      const csave = h('<button class="btn sm primary" style="align-self:flex-start">Save</button>');
      csave.onclick = async () => {
        const config = {};
        for (const el of cfgForm.querySelectorAll('[data-cfg]')) if (el.value.trim()) config[el.dataset.cfg] = el.value.trim();
        await api(`/providers/${p.name}`, { method:'PATCH', body:{ config } }); toast('Saved');
      };
      cfgForm.appendChild(csave); wrap.appendChild(cfgForm);
    }
    pc.appendChild(wrap);
  }
  v.appendChild(pc);
}

function openPackageAuditModal({ title, allVols, alerts, onProceed }) {
  const alertMap = new Map((alerts||[]).map(a => [a.volumeKey, a]));
  const modal = h(`<div class="modal-backdrop" style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
    <div class="modal-box" style="background:#1a1e24;border:1px solid #2e353f;border-radius:12px;width:100%;max-width:560px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,0.8)">
      <div style="padding:16px 20px;border-bottom:1px solid #2e353f;display:flex;align-items:center">
        <h3 style="margin:0;font-size:16px;color:#fff">${esc(title)}</h3>
        <span class="muted" style="margin-left:auto;font-size:12px">${allVols.length} Volumes Total</span>
      </div>
      <div style="padding:16px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1">
        <p class="muted" style="font-size:13px;margin:0 0 4px 0">Review volume audit results. Volumes with missing chapters or unusual chapter counts are flagged below.</p>
        <div class="audit-list" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <div style="padding:16px 20px;border-top:1px solid #2e353f;display:flex;justify-content:flex-end;gap:10px">
        <button class="btn sm" id="pa-cancel">Cancel</button>
        <button class="btn sm primary" style="background:#8957e5" id="pa-proceed">🚀 Proceed Packaging</button>
      </div>
    </div>
  </div>`);

  const list = modal.querySelector('.audit-list');
  const toggles = new Map();

  for (const vk of allVols) {
    const alert = alertMap.get(vk);
    const isFlagged = !!alert;
    let desc = 'All chapters locally available';
    if (isFlagged) {
      const parts = [];
      if (alert.isIncomplete) {
        const missing = alert.totalCount - alert.localCount;
        parts.push(`${alert.localCount}/${alert.totalCount} chapters locally (missing ${missing})`);
      }
      if (alert.missingGaps && alert.missingGaps.length) {
        parts.push(`Missing: ${alert.missingGaps.join(', ')}`);
      }
      if (alert.unexpectedLangs && alert.unexpectedLangs.length) {
        parts.push(`Unexpected language(s): ${alert.unexpectedLangs.join(', ')}`);
      }
      desc = parts.join(' · ');
    }
    const item = h(`<div style="display:flex;align-items:center;padding:10px 14px;background:#0d1117;border:1px solid ${isFlagged?'#d29922':'#238636'};border-radius:8px;gap:12px">
      <span style="font-size:16px">${isFlagged?'⚠️':'✔️'}</span>
      <div style="display:flex;flex-direction:column;flex:1">
        <strong style="color:#fff;font-size:14px">Volume ${esc(vk)}</strong>
        <span style="color:#aaa;font-size:12px">${esc(desc)}</span>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ccc;cursor:pointer">
        <input type="checkbox" checked style="accent-color:#8957e5;width:16px;height:16px"> Process
      </label>
    </div>`);

    const cb = item.querySelector('input');
    cb.onchange = () => {
      item.style.opacity = cb.checked ? '1' : '0.4';
    };
    toggles.set(vk, cb);
    list.appendChild(item);
  }

  modal.querySelector('#pa-cancel').onclick = () => modal.remove();
  modal.querySelector('#pa-proceed').onclick = () => {
    const selected = [...toggles.entries()].filter(([_, cb]) => cb.checked).map(([vk]) => vk);
    modal.remove();
    onProceed(selected);
  };
  document.body.appendChild(modal);
}

route();
