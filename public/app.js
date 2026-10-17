'use strict';

// Selection. books === null means "all books available for the chosen stat".
const state = { league: null, date: null, stat: null, books: null };

let leagues = [];
let day = null; // last /api/day response for state.league + state.date
let dayKey = null;
let loading = false; // a load the user asked for; live refreshes don't set it
let leaguesLoading = true;
let error = null;
let requestSeq = 0;
let stream = null; // EventSource for the current league + date
let streamKey = null;
let streamNote = ''; // connection problems
let monitorError = null; // last failed API check, reported by the server
let prevCells = new Map();
let format = 'american';
try { format = localStorage.getItem('oddsFormat') || 'american'; } catch {}
let view = 'viewer'; // 'viewer' or 'csv'; the URL holds view=csv

// Collected CSVs, one per league + day: { id, league, date, stats, order, off }.
// order null = most coverage first; off = books unticked in the ranking.
let csvs = [];
let activeCsvId = null;
try { ({ list: csvs = [], active: activeCsvId = null } = JSON.parse(localStorage.getItem('csvs')) || {}); } catch {}
let csvData = null; // last /api/csv response
let csvDataFor = null; // id of the CSV it was loaded for
let csvLoading = false;
let csvError = null;
let csvSeq = 0;
let prevCsvCells = new Map();
let csvPane = 'table'; // the open CSV's sub-tab: 'table' or 'books'
let dragBook = null; // book row being dragged in the ranking

const $ = (sel, root = document) => root.querySelector(sel);
const fieldEl = (name) => $(`.field[data-field="${name}"]`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- dates (browser local time) ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ---------- URL state ----------

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.league = p.get('league');
  state.date = /^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '') ? p.get('date') : todayStr();
  state.stat = p.get('stat');
  state.books = p.has('books') ? p.get('books').split(',').filter(Boolean) : null;
  view = p.get('view') === 'csv' ? 'csv' : 'viewer';
  if (state.date && state.date < todayStr()) state.date = todayStr();
}

function writeUrl(push) {
  const p = new URLSearchParams();
  if (state.league) p.set('league', state.league);
  if (state.date) p.set('date', state.date);
  if (state.stat) p.set('stat', state.stat);
  if (state.books) p.set('books', state.books.join(','));
  if (view === 'csv') p.set('view', 'csv');
  const url = `${location.pathname}${p.size ? '?' + p : ''}`;
  if (url !== location.pathname + location.search) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

// ---------- derived selection ----------

function statInfo() {
  return day?.stats.find((s) => s.statID === state.stat) || null;
}

function availableBooks() {
  return statInfo()?.books || [];
}

function selectedBooks() {
  const avail = availableBooks();
  return state.books ? avail.filter((b) => state.books.includes(b)) : avail;
}

// ---------- odds formatting ----------

// American odds in the chosen format as a plain number ('-165', '2.65', '62.3'), '' if not a price.
function oddsValue(american) {
  const n = parseInt(american, 10);
  if (Number.isNaN(n)) return '';
  if (format === 'decimal') return (n > 0 ? 1 + n / 100 : 1 + 100 / -n).toFixed(2);
  if (format === 'implied') return ((n > 0 ? 100 / (n + 100) : -n / (-n + 100)) * 100).toFixed(1);
  return String(n);
}

function fmtOdds(american) {
  const n = parseInt(american, 10);
  if (Number.isNaN(n)) return american ?? '';
  if (format === 'implied') return oddsValue(american) + '%';
  if (format === 'decimal') return oddsValue(american);
  return n > 0 ? `+${n}` : `−${-n}`;
}

// Spread lines as SGO sends them ('-1.5', '+1.5'), with a typographic minus like prices.
const fmtSpread = (line) => String(line ?? '').replace('-', '−');

function cellHtml(kind, cell) {
  const sides = ['a', 'b'].filter((s) => cell?.[s] && cell[s].odds != null);
  if (!sides.length) return '<span class="none">—</span>';
  const label = kind === 'ou' ? { a: 'o', b: 'u' } : { a: 'Yes', b: 'No' };
  return sides
    .map((s) => {
      const c = cell[s];
      const cls = c.available ? 'px' : 'px na';
      // Moneyline and spread have one side: the price alone, or the spread line and price.
      const ln = kind === 'ml' ? '' : kind === 'sp' ? fmtSpread(c.line) : kind === 'ou' ? `${label[s]}${c.line ?? ''}` : label[s];
      return `<div class="${cls}"><span class="ln">${esc(ln)}</span><span class="od">${esc(fmtOdds(c.odds))}</span></div>`;
    })
    .join('');
}

// ---------- data loading ----------

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.retryAfter = body.retryAfter;
    throw e;
  }
  return body;
}

// refresh = triggered by the live monitor: keep the current view on screen while loading.
async function load({ refresh = false } = {}) {
  const seq = ++requestSeq;
  if (!state.league || !state.date) {
    day = null;
    dayKey = null;
    error = null;
    connectStream();
    render();
    return;
  }
  const key = `${state.league}|${state.date}`;
  if (dayKey !== key) day = null; // different day: don't show stale options
  if (!refresh) {
    loading = true;
    error = null;
    render();
  }

  const { from, to } = dayRange(state.date);
  const p = new URLSearchParams({ league: state.league, from, to });
  if (state.stat) p.set('stat', state.stat);
  if (state.books) p.set('books', state.books.join(','));
  try {
    const res = await api(`/api/day?${p}`);
    if (seq !== requestSeq) return;
    day = res;
    dayKey = key;
    error = null;

    // Drop later picks that no longer fit.
    if (state.stat && !statInfo()) {
      state.stat = null;
      state.books = null;
      writeUrl(false);
    } else if (state.books?.length && availableBooks().length && !selectedBooks().length) {
      // None of the previously chosen books price this stat today: fall back to all.
      state.books = null;
      writeUrl(false);
      return load({ refresh });
    }
  } catch (e) {
    if (seq !== requestSeq) return;
    if (refresh && day) monitorError = { message: e.message }; // keep showing the last good data
    else error = e;
  } finally {
    if (seq === requestSeq) loading = false;
  }
  connectStream();
  render({ flash: refresh });
}

// The league + day on screen: the viewer's selection, or the open CSV's.
function streamTarget() {
  if (view === 'csv') {
    const c = activeCsv();
    return c && { league: c.league, date: c.date };
  }
  return state.league && state.date ? { league: state.league, date: state.date } : null;
}

// Live monitor: the server re-checks the API for this league + day and sends a message
// after every check; a new version means fresh data to load.
function connectStream() {
  const t = streamTarget();
  const key = t ? `${t.league}|${t.date}` : null;
  if (key === streamKey) return;
  stream?.close();
  stream = null;
  streamKey = key;
  streamNote = '';
  monitorError = null;
  if (!key) return;
  const { from, to } = dayRange(t.date);
  stream = new EventSource(`/api/stream?${new URLSearchParams({ league: t.league, from, to })}`);
  stream.onopen = () => {
    streamNote = '';
    renderUpdated();
  };
  stream.onerror = () => {
    streamNote = 'Lost connection to the server. Reconnecting…';
    renderUpdated();
  };
  stream.onmessage = (e) => {
    const s = JSON.parse(e.data);
    streamNote = '';
    monitorError = s.error;
    if (view === 'csv') {
      if (csvData && s.version !== csvData.version) loadCsv({ refresh: true });
    } else if (day && s.version !== day.version) load({ refresh: true });
    renderUpdated();
  };
}

// ---------- rendering ----------

function render({ flash = false } = {}) {
  renderViews();
  document.querySelectorAll('#format button').forEach((b) => b.classList.toggle('on', b.dataset.format === format));
  if (view === 'csv') {
    renderCsv(flash);
    return;
  }
  renderFields();
  renderMessage();
  renderCsvAction();
  renderTable(flash);
  const open = $('.field.open');
  if (open) renderPanel(open.dataset.field);
}

function renderViews() {
  const csv = view === 'csv';
  document.querySelectorAll('#views button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === view);
    b.setAttribute('aria-selected', b.dataset.view === view);
  });
  $('#bar').hidden = csv;
  $('#table-wrap').hidden = csv;
  $('#csv-tabs').hidden = !csv;
  $('#csv-view').hidden = !csv;
  if (csv) $('#csv-action').innerHTML = '';
}

function setField(name, value, enabled) {
  const el = fieldEl(name);
  $('.value', el).textContent = value;
  $('.field-btn', el).disabled = !enabled;
  if (!enabled) el.classList.remove('open');
}

function renderFields() {
  setField('league', state.league || 'Select', leagues.length > 0);
  setField('date', state.date ? fmtDate(state.date) : 'Select', !!state.league);

  const statsReady = !!day && day.stats.length > 0;
  const statValue = state.stat || (day ? (statsReady ? 'Select' : 'None today') : loading ? 'Loading…' : '—');
  setField('stat', statValue, statsReady);

  let booksValue = '—';
  if (state.stat && statInfo()) {
    const avail = availableBooks();
    const sel = selectedBooks();
    if (!avail.length) booksValue = 'none available';
    else if (sel.length === avail.length) booksValue = `All (${avail.length})`;
    else if (!sel.length) booksValue = 'Select';
    else if (sel.length <= 2) booksValue = sel.join(', ');
    else booksValue = `${sel.length} of ${avail.length}`;
  }
  setField('books', booksValue, !!(state.stat && statInfo()));
}

const games = (n) => `${n} game${n === 1 ? '' : 's'}`;

function renderMessage() {
  const el = $('#message');
  el.classList.toggle('error', !!error);
  let msg = '';
  if (error) {
    msg = error.status === 429
      ? `Rate limited by the API.${error.retryAfter ? ` Retry in ${error.retryAfter}s.` : ''}`
      : `Error: ${error.message}`;
  } else if (leaguesLoading || loading) msg = ''; // the spinner in the table box says what's loading
  else if (!state.league) msg = 'Choose a league to see its games.';
  else if (!state.date) msg = 'Choose a date.';
  else if (!day) msg = '';
  else if (!day.gameCount) msg = `No ${state.league} games on ${fmtDate(state.date)}. Try another date.`;
  else if (!day.stats.length) msg = `${games(day.gameCount)}, but no player markets yet. Books usually post props about a day before.`;
  else if (!state.stat) msg = `${games(day.gameCount)}. Choose a market.`;
  else if (availableBooks().length && !selectedBooks().length) msg = 'Select at least one bookmaker.';
  else if (day.table) {
    const without = day.table.gamesWithoutStat;
    msg = `${games(day.table.games.length)} with ${state.stat}.` +
      (without ? ` ${games(without)} ${without === 1 ? 'has' : 'have'} no ${state.stat} markets.` : '');
  }
  el.textContent = msg;
}

// The day's schedule, shown before a market is picked.
function gamesHtml(list) {
  let html = '<table class="games"><thead><tr><th>Time</th><th>Away</th><th>Home</th><th>Status</th><th>Player markets</th></tr></thead><tbody>';
  for (const g of list) {
    const markets = g.statCount ? `${g.statCount} stats, ${g.playerCount} players` : '<span class="none">none yet</span>';
    html += `<tr><td>${esc(fmtTime(g.startsAt))}</td>` +
      `<td><b>${esc(g.away.short)}</b> ${esc(g.away.long)}</td>` +
      `<td><b>${esc(g.home.short)}</b> ${esc(g.home.long)}</td>` +
      `<td>${esc(g.status)}</td><td>${markets}</td></tr>`;
  }
  return html + '</tbody></table>';
}

const COL_W = { player: 210, team: 70, odds: 140 }; // px

function loadingHtml(text) {
  return `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
}

function loadingText() {
  if (leaguesLoading) return 'Loading leagues…';
  if (!day) return `Loading ${state.league} games for ${fmtDate(state.date)}…`;
  return state.stat ? `Loading ${state.stat}…` : `Loading ${state.league} games…`;
}

function renderTable(flash) {
  const wrap = $('#table-wrap');
  // A load the user asked for replaces the table at once, so old data never stands in for new.
  if ((leaguesLoading || loading) && !error) {
    wrap.innerHTML = loadingHtml(loadingText());
    return;
  }
  const t = day?.table;
  const show = t && state.stat && !error && !(availableBooks().length && !selectedBooks().length);
  if (!show) {
    wrap.innerHTML = !state.stat && !error && day?.games?.length ? gamesHtml(day.games) : '';
    return;
  }
  const cols = ['consensus', 'fair', ...t.books];
  const next = new Map();
  // Fixed column widths, so a column looks the same whether 2 or 20 bookmakers are
  // selected. A trailing empty "filler" column takes up any leftover width, which keeps
  // the row lines running across the whole box.
  const widths = [COL_W.player, COL_W.team, ...cols.map(() => COL_W.odds)];
  let html = `<table class="odds" style="min-width:${widths.reduce((a, b) => a + b, 0)}px"><colgroup>` +
    widths.map((w) => `<col style="width:${w}px">`).join('') + '<col></colgroup>';
  html += '<thead><tr><th class="player">Player</th><th>Team</th><th class="ref">Consensus</th><th class="ref last">Fair</th>';
  html += t.books.map((b) => `<th title="${esc(b)}">${esc(b)}</th>`).join('') + '<th class="filler"></th></tr></thead><tbody>';
  for (const g of t.games) {
    html += `<tr class="game"><th colspan="${cols.length + 3}">` +
      `<span class="matchup">${esc(g.away.short)} @ ${esc(g.home.short)}</span>` +
      `<span class="when">${esc(fmtTime(g.startsAt))}</span>` +
      (g.status ? `<span class="state">${esc(g.status)}</span>` : '') +
      '</th></tr>';
    for (const r of g.rows) {
      html += `<tr><td class="player">${esc(r.name)}</td>` +
        `<td class="team">${esc(r.team)}</td>`;
      for (const col of cols) {
        const isRef = col === 'consensus' || col === 'fair';
        const cell = col === 'consensus' ? r.consensus : col === 'fair' ? r.fair : r.books[col];
        const k = `${g.eventID}|${r.key}|${col}`;
        // Flash only on visible changes, not on a re-check with the same price.
        const sig = JSON.stringify(['a', 'b'].map((s) => cell?.[s] && [cell[s].odds, cell[s].line, cell[s].available]));
        next.set(k, sig);
        const changed = flash && prevCells.has(k) && prevCells.get(k) !== sig;
        const cls = [isRef ? 'ref' : '', col === 'fair' ? 'last' : '', changed ? 'chg' : ''].filter(Boolean).join(' ');
        const checked = ['a', 'b'].map((s) => cell?.[s]?.checked).filter(Boolean).sort().pop();
        const closed = ['a', 'b'].some((s) => cell?.[s] && cell[s].odds != null && !cell[s].available);
        const data = (checked ? ` data-checked="${esc(checked)}"` : '') + (closed ? ' data-closed' : '');
        html += `<td${cls ? ` class="${cls}"` : ''}${data}>${cellHtml(r.kind, cell)}</td>`;
      }
      html += '<td class="filler"></td></tr>';
    }
  }
  wrap.innerHTML = html + '</tbody></table>';
  prevCells = next;
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderUpdated() {
  const el = $('#updated');
  el.classList.toggle('warn', !!(streamNote || monitorError));
  if (streamNote) {
    el.textContent = streamNote;
    return;
  }
  const d = view === 'csv' ? csvData : day;
  if (!d?.checkedAt) {
    el.textContent = '';
    return;
  }
  let text = `Checked ${ago(d.checkedAt)} ago, last change ${d.changedAt ? ago(d.changedAt) + ' ago' : 'not seen yet'}`;
  if (monitorError) text += `. Last check failed (${monitorError.message}), retrying`;
  el.textContent = text;
}

// ---------- CSV export ----------
// Rows = players, columns per collected market by kind (CSV_COLS), full game only.
// Each cell takes both sides from one book: the first ticked book in the ranking that
// prices it, preferring an open price; if every pricing book is closed, the first closed one.

const csvId = (league, date) => `${league}|${date}`;

// Columns per market kind. Only markets with a line get a _line column.
const CSV_COLS = { ou: ['line', 'over', 'under'], yn: ['yes', 'no'], sp: ['line', 'odds'], ml: ['odds'] };

// A market's columns: the ranked book's, then the same again from the consensus.
const marketCols = (kind) => [...CSV_COLS[kind], ...CSV_COLS[kind].map((col) => `consensus_${col}`)];

// Market kind from its name: the server suffixes every bet type except over/under.
function marketKind(stat) {
  if (stat.endsWith(':yes/no')) return 'yn';
  if (stat.endsWith(':moneyline')) return 'ml';
  if (stat.endsWith(':spread')) return 'sp';
  return 'ou';
}

function saveCsvs() {
  try { localStorage.setItem('csvs', JSON.stringify({ list: csvs, active: activeCsvId })); } catch {}
}

function activeCsv() {
  return csvs.find((c) => c.id === activeCsvId) || csvs[0] || null;
}

function viewerCsv() {
  return csvs.find((c) => c.id === csvId(state.league, state.date)) || null;
}

// Past days can't be loaded, so their CSVs are dropped. Returns true if any were.
function pruneCsvs() {
  const n = csvs.length;
  csvs = csvs.filter((c) => c.date >= todayStr());
  if (csvs.length === n) return false;
  saveCsvs();
  return true;
}

function removeStat(c, stat) {
  c.stats = c.stats.filter((s) => s !== stat);
  if (!c.stats.length) csvs = csvs.filter((x) => x !== c);
  saveCsvs();
}

async function loadCsv({ refresh = false } = {}) {
  const seq = ++csvSeq;
  const c = activeCsv();
  if (!c) {
    csvData = null;
    csvDataFor = null;
    connectStream();
    render();
    return;
  }
  if (csvDataFor !== c.id) {
    csvData = null; // different league or day: don't show its rows
    prevCsvCells = new Map();
  }
  if (!refresh) {
    csvLoading = true;
    csvError = null;
    render();
  }
  const { from, to } = dayRange(c.date);
  try {
    const res = await api(`/api/csv?${new URLSearchParams({ league: c.league, from, to, stats: c.stats.join(',') })}`);
    if (seq !== csvSeq) return;
    csvData = res;
    csvDataFor = c.id;
    csvError = null;
  } catch (e) {
    if (seq !== csvSeq) return;
    if (refresh && csvData) monitorError = { message: e.message };
    else csvError = e;
  } finally {
    if (seq === csvSeq) csvLoading = false;
  }
  connectStream();
  render({ flash: refresh });
}

const priced = (q) => ['a', 'b'].some((s) => q?.[s]?.odds != null);

// The consensus as a pick, so it fills its columns the same way a book does.
function consensusPick(cell) {
  const q = cell?.consensus;
  if (!priced(q)) return null;
  return { book: 'consensus', q, kind: cell.kind, open: ['a', 'b'].every((s) => q[s]?.odds == null || q[s].available) };
}

function pickBook(cell, order, off) {
  let closed = null;
  for (const book of order) {
    const q = cell.books[book];
    if (off.includes(book) || !priced(q)) continue;
    const open = ['a', 'b'].every((s) => q[s]?.odds == null || q[s].available);
    if (open) return { book, q, open, kind: cell.kind };
    closed ||= { book, q, open, kind: cell.kind };
  }
  return closed;
}

// Everything the preview and the file need, from the CSV's picks and the latest data.
function csvTable(c, data) {
  const cov = new Map(data.books.map((b) => [b, 0]));
  const players = data.rows.filter((r) => c.stats.some((s) => r.cells[s]));
  for (const r of players) {
    for (const s of c.stats) {
      for (const [b, q] of Object.entries(r.cells[s]?.books || {})) if (priced(q)) cov.set(b, cov.get(b) + 1);
    }
  }
  const byCoverage = [...data.books].sort((a, b) => cov.get(b) - cov.get(a) || a.localeCompare(b));
  const order = c.order
    ? [...c.order.filter((b) => cov.has(b)), ...byCoverage.filter((b) => !c.order.includes(b))]
    : byCoverage;
  const markets = c.stats.map((stat) => ({ stat, kind: marketKind(stat), offered: data.available.includes(stat) }));
  const used = new Map(order.map((b) => [b, 0]));
  const rows = players.map((r) => ({
    ...r,
    picks: markets.map((m) => {
      const p = r.cells[m.stat] && pickBook(r.cells[m.stat], order, c.off);
      if (p) used.set(p.book, used.get(p.book) + 1);
      return p;
    }),
    cons: markets.map((m) => consensusPick(r.cells[m.stat])),
  }));
  const t = { order, cov, used, markets, rows, sort: null };
  sortRows(t, c.sort);
  return t;
}

// Sorts the rows by one column (c.sort = { col: header name, dir: 'asc' | 'desc' }): numbers
// numerically, names alphabetically, blanks last either way. Ties keep the default order.
function sortRows(t, sort) {
  const i = sort ? csvHeader(t).indexOf(sort.col) : -1;
  if (i < 0) return; // never sorted, or that market was removed
  const dir = sort.dir === 'desc' ? -1 : 1;
  const keyed = t.rows.map((r) => [r, rowValues(r, t)[i]]);
  keyed.sort(([, a], [, b]) => {
    if (a === '' || b === '') return (a === '') - (b === '');
    const x = Number(a);
    const y = Number(b);
    return dir * (Number.isNaN(x) || Number.isNaN(y) ? a.localeCompare(b) : x - y);
  });
  t.rows = keyed.map(([r]) => r);
  t.sort = sort;
}

// One row of the file: the player, then each market's book and consensus values.
function rowValues(r, t) {
  return [r.name, ...r.picks.flatMap((p, i) => [...pickValues(p, t.markets[i].kind), ...pickValues(r.cons[i], t.markets[i].kind)])];
}

function csvHeader(t) {
  return ['player', ...t.markets.flatMap((m) => marketCols(m.kind).map((col) => `${m.stat}_${col}`))];
}

// One cell's values, one per CSV_COLS[kind] column.
function pickValues(p, kind) {
  if (!p) return CSV_COLS[kind].map(() => '');
  const odds = oddsValue(p.q.a?.odds);
  if (kind === 'ml') return [odds];
  if (kind === 'yn') return [odds, oddsValue(p.q.b?.odds)];
  if (kind === 'sp') {
    const n = parseFloat(p.q.a?.line);
    return [Number.isNaN(n) ? '' : String(n), odds]; // '+1.5' -> '1.5', like odds have no '+'
  }
  return [String(p.q.a?.line ?? p.q.b?.line ?? ''), odds, oddsValue(p.q.b?.odds)];
}

const csvField = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function exportCsv() {
  const c = activeCsv();
  if (!c || !csvData) return;
  const t = csvTable(c, csvData);
  const lines = [csvHeader(t), ...t.rows.map((r) => rowValues(r, t))];
  const text = lines.map((l) => l.map(csvField).join(',')).join('\r\n') + '\r\n';
  const now = new Date();
  const hms = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  const a = document.createElement('a');
  // The byte-order mark makes Excel read the file as UTF-8 (accented names otherwise garble).
  a.href = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = `${c.league}-${c.date}_exported-${ymd(now)}-${hms}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// "Add to CSV" next to the viewer's status line.
function renderCsvAction() {
  const el = $('#csv-action');
  if (!(day?.table && state.stat && !error && !loading)) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = viewerCsv()?.stats.includes(state.stat)
    ? `<span class="in-csv">In the ${esc(state.league)} ${esc(fmtDate(state.date))} CSV</span><button class="btn" data-act="csv-remove">Remove from CSV</button>`
    : '<button class="btn primary" data-act="csv-add">Add to CSV</button>';
}

function renderCsv(flash) {
  const c = activeCsv();
  activeCsvId = c?.id ?? null;
  $('#csv-tabs').innerHTML = csvs
    .map((x) => `<span class="ctab${x === c ? ' on' : ''}">` +
      `<button data-csv="${esc(x.id)}">${esc(x.league)} · ${esc(fmtDate(x.date))} <span class="n">${x.stats.length}</span></button>` +
      `<button data-close="${esc(x.id)}" title="Delete this CSV" aria-label="Delete this CSV">×</button></span>`)
    .join('');
  const msg = $('#message');
  const body = $('#csv-view');
  msg.classList.toggle('error', !!csvError);
  if (c && (csvLoading || leaguesLoading) && !csvError) {
    msg.textContent = '';
    body.innerHTML = `<div class="csv-wrap">${loadingHtml(`Loading the ${c.league} ${fmtDate(c.date)} CSV…`)}</div>`;
    renderUpdated();
    return;
  }
  if (!c || csvError || !csvData) {
    msg.textContent = !c ? 'No CSVs yet. In the viewer, pick a market and click Add to CSV.' : csvError ? `Error: ${csvError.message}` : '';
    body.innerHTML = '';
    renderUpdated();
    return;
  }

  const t = csvTable(c, csvData);
  const cells = t.rows.length * t.markets.length;
  const filled = t.rows.reduce((n, r) => n + r.picks.filter(Boolean).length, 0);
  const notOffered = t.markets.filter((m) => !m.offered).length;
  msg.textContent = `${t.rows.length} players, ${t.markets.length} market${t.markets.length === 1 ? '' : 's'}: ` +
    `${filled} of ${cells} cells have a price.` +
    (notOffered ? ` ${notOffered} market${notOffered === 1 ? ' is' : 's are'} not offered today.` : '');
  renderUpdated();
  if (dragBook) return; // rebuilding mid-drag would drop the dragged row; dragend re-renders

  const panes = '<span class="seg" role="tablist" aria-label="CSV section">' +
    [['table', 'Table'], ['books', 'Bookmakers']]
      .map(([p, label]) => `<button role="tab" data-pane="${p}"${csvPane === p ? ' class="on" aria-selected="true"' : ''}>${label}</button>`)
      .join('') + '</span>';
  const chips = csvPane !== 'table' ? '' : '<div class="chips"><span class="lbl">Markets</span>' + t.markets
    .map((m) => `<span class="chip${m.offered ? '' : ' gone'}"${m.offered ? '' : ' title="Not offered today"'}>${esc(m.stat)}` +
      `<button data-act="remove" data-stat="${esc(m.stat)}" title="Remove from CSV" aria-label="Remove ${esc(m.stat)}">×</button></span>`)
    .join('') + '</div>';
  const bar = `<div class="csv-bar">${panes}${chips}<button class="btn primary" data-act="export">Export CSV</button></div>`;

  // Keep the scroll position across live refreshes, which rebuild this.
  const wrap = $('.csv-wrap', body);
  const scroll = wrap && { top: wrap.scrollTop, left: wrap.scrollLeft };
  body.innerHTML = bar + (csvPane === 'table' ? csvTableHtml(t, flash) : csvBooksHtml(c, t));
  if (scroll && $('.csv-wrap', body)) Object.assign($('.csv-wrap', body), { scrollTop: scroll.top, scrollLeft: scroll.left });
}

// The preview: exactly the file's columns and header names.
function csvTableHtml(t, flash) {
  const header = csvHeader(t);
  const ends = new Set(); // index of each market's last column
  t.markets.reduce((i, m) => (ends.add(i + marketCols(m.kind).length - 1), i + marketCols(m.kind).length), 1);
  const last = (i) => ends.has(i);
  // Header names are mono at ≈ 9px per character; wide enough that none is cut off,
  // with room for the sort arrow.
  const widths = header.map((h, i) => (i === 0 ? 210 : Math.max(80, h.length * 9 + 46)));
  const sortedBy = (h) => t.sort?.col === h && t.sort.dir;
  let html = `<table class="odds csv" style="min-width:${widths.reduce((a, b) => a + b, 0)}px"><colgroup>` +
    widths.map((w) => `<col style="width:${w}px">`).join('') + '<col></colgroup><thead><tr>' +
    header.map((h, i) => {
      const dir = sortedBy(h);
      return `<th class="${[i === 0 ? 'player' : '', last(i) ? 'grp' : ''].join(' ').trim()}"` +
        (dir ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : '') +
        `><button class="sort" data-sort="${esc(h)}" title="Sort by ${esc(h)}">${esc(h)}` +
        `<span class="arrow" aria-hidden="true">${dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}</span></button></th>`;
    }).join('') +
    '<th class="filler"></th></tr></thead><tbody>';
  const next = new Map();
  for (const r of t.rows) {
    html += `<tr><td class="player">${esc(r.name)}</td>`;
    // One pick's cells; grp marks the market's last column.
    const cells = (p, kind, k, grp) => {
      const vals = pickValues(p, kind);
      const sig = JSON.stringify([vals, p?.open]);
      next.set(k, sig);
      const changed = flash && prevCsvCells.has(k) && prevCsvCells.get(k) !== sig;
      const cls = ['num', p && !p.open ? 'na' : '', changed ? 'chg' : ''].filter(Boolean).join(' ');
      const title = p ? ` title="${esc(p.book)}${p.open ? '' : ' (not currently open for betting)'}"` : '';
      return vals.map((v, j) => `<td class="${cls}${grp && j === vals.length - 1 ? ' grp' : ''}"${title}>${v === '' ? '<span class="none">—</span>' : esc(v)}</td>`).join('');
    };
    r.picks.forEach((p, i) => {
      const { stat, kind } = t.markets[i];
      html += cells(p, kind, `${r.playerID}|${stat}`, false) + cells(r.cons[i], kind, `${r.playerID}|${stat}|consensus`, true);
    });
    html += '<td class="filler"></td></tr>';
  }
  prevCsvCells = next;
  return `<div class="csv-wrap">${t.rows.length ? html + '</tbody></table>' : ''}</div>`;
}

function csvBooksHtml(c, t) {
  const custom = c.order || c.off.length;
  const rows = t.order
    .map((b, i) => {
      const off = c.off.includes(b);
      return `<div class="rk${off ? ' off' : ''}" draggable="true" data-book="${esc(b)}">` +
        `<span class="grip" tabindex="0" data-book="${esc(b)}" title="Drag to reorder (or focus and use ↑ ↓)" aria-label="Move ${esc(b)}: arrow keys">⠿</span>` +
        `<input type="checkbox" data-book="${esc(b)}"${off ? '' : ' checked'} aria-label="Use ${esc(b)}">` +
        `<span class="pos">${i + 1}</span><span class="bk">${esc(b)}</span>` +
        `<span class="nm">${t.cov.get(b)}</span><span class="nm">${t.used.get(b) || ''}</span></div>`;
    })
    .join('');
  return '<div class="books">' +
    `<div class="books-head"><p>Each cell uses the first ticked book that prices it, preferring open prices. Drag rows to reorder. ` +
    `${custom ? 'Custom order.' : 'Default order: most cells priced first.'}</p>` +
    `<button class="btn" data-act="reset"${custom ? '' : ' disabled'}>Reset to default</button></div>` +
    '<p class="legend"><b>Prices</b>: cells (player × market) this book has a price for. <b>Used</b>: cells the CSV takes from this book with the current order.</p>' +
    '<div class="rk rk-head"><span></span><span></span><span class="pos">#</span><span>Book</span><span class="nm">Prices</span><span class="nm">Used</span></div>' +
    `<div class="rk-list">${rows}</div></div>`;
}

// Moves book next to target in the CSV's ranking (before or after it).
function moveBook(c, book, target, before) {
  const order = csvTable(c, csvData).order.filter((b) => b !== book);
  const i = order.indexOf(target);
  if (i < 0 || book === target) return false;
  order.splice(before ? i : i + 1, 0, book);
  c.order = order;
  saveCsvs();
  return true;
}

// ---------- panels ----------

function radio(name, value, label, checked, tag = '') {
  return `<label><input type="radio" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}> ${esc(label)}` +
    (tag ? ` <span class="tag">${esc(tag)}</span>` : '') + '</label>';
}

function renderPanel(name) {
  const panel = $('.panel', fieldEl(name));
  if (name === 'league') {
    const pinned = ['NBA', 'NHL', 'MLB', 'NFL', 'UFC'];
    const rank = (id) => (pinned.includes(id) ? pinned.indexOf(id) : pinned.length);
    panel.innerHTML = [...leagues]
      .sort((a, b) => rank(a.leagueID) - rank(b.leagueID) || a.leagueID.localeCompare(b.leagueID))
      .map((l) => radio('league', l.leagueID, l.name === l.leagueID ? l.leagueID : `${l.leagueID} — ${l.name}`, l.leagueID === state.league))
      .join('');
  } else if (name === 'date') {
    panel.innerHTML = calendarHtml();
  } else if (name === 'stat') {
    const filter = $('input[type=search]', panel)?.value || '';
    const inCsv = viewerCsv()?.stats || [];
    const items = (day?.stats || [])
      .filter((s) => s.statID.toLowerCase().includes(filter.toLowerCase()))
      .map((s) => radio('stat', s.statID, s.statID, s.statID === state.stat, inCsv.includes(s.statID) ? 'in CSV' : ''))
      .join('');
    if (!$('input[type=search]', panel)) {
      panel.innerHTML = '<input type="search" placeholder="filter"><div class="list"></div>';
    }
    $('.list', panel).innerHTML = items || '<div class="note">no matches</div>';
  } else if (name === 'books') {
    const avail = availableBooks();
    const sel = selectedBooks();
    panel.innerHTML = avail.length
      ? '<div class="tools"><button data-act="all">All</button><button data-act="none">None</button></div>' +
        avail.map((b) => `<label><input type="checkbox" value="${esc(b)}"${sel.includes(b) ? ' checked' : ''}> ${esc(b)}</label>`).join('')
      : '<div class="note">No bookmaker prices this market — showing consensus and fair only.</div>';
  }
}

// ---------- calendar (date panel) ----------

let calMonth = null; // first day of the month shown, as YYYY-MM-01

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function calendarHtml() {
  const today = todayStr();
  if (!calMonth) calMonth = (state.date || today).slice(0, 8) + '01';
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const atCurrentMonth = calMonth <= today.slice(0, 8) + '01';
  let html = `<div class="cal"><div class="cal-head">` +
    `<button data-act="prev-month" aria-label="Previous month"${atCurrentMonth ? ' disabled' : ''}>‹</button>` +
    `<span>${esc(title)}</span><button data-act="next-month" aria-label="Next month">›</button></div><div class="cal-wds">`;
  const weekStart = new Date(2024, 0, 7); // a Sunday
  for (let i = 0; i < 7; i++) {
    const wd = new Date(weekStart.getFullYear(), 0, 7 + i).toLocaleDateString(undefined, { weekday: 'narrow' });
    html += `<span class="cal-wd">${esc(wd)}</span>`;
  }
  html += '</div><div class="cal-grid">';
  const daysInMonth = new Date(y, m, 0).getDate();
  for (let i = 0; i < first.getDay(); i++) html += '<span></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const date = ymd(new Date(y, m - 1, d));
    const cls = [date === today ? 'today' : '', date === state.date ? 'sel' : ''].filter(Boolean).join(' ');
    html += `<button data-date="${date}"${cls ? ` class="${cls}"` : ''}${date < today ? ' disabled' : ''}>${d}</button>`;
  }
  // pad the last week so every grid line is drawn
  for (let i = (first.getDay() + daysInMonth) % 7; i && i < 7; i++) html += '<span></span>';
  return html + '</div></div>';
}

function shiftMonth(delta) {
  const [y, m] = calMonth.split('-').map(Number);
  calMonth = ymd(new Date(y, m - 1 + delta, 1));
  renderPanel('date');
}

function toggleField(name) {
  const el = fieldEl(name);
  const wasOpen = el.classList.contains('open');
  document.querySelectorAll('.field.open').forEach((f) => f.classList.remove('open'));
  if (!wasOpen) {
    if (name === 'date') calMonth = null;
    el.classList.add('open');
    renderPanel(name);
    $('input[type=search]', el)?.focus();
  }
}

function closePanels() {
  document.querySelectorAll('.field.open').forEach((f) => f.classList.remove('open'));
}

function setBooks(list) {
  state.books = list.length === availableBooks().length ? null : list;
  writeUrl(true);
  load();
}

// ---------- events ----------

$('#bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.field-btn');
  if (btn && !btn.disabled) toggleField(btn.closest('.field').dataset.field);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'all') setBooks(availableBooks());
  if (act === 'none') setBooks([]);
  if (act === 'prev-month') shiftMonth(-1);
  if (act === 'next-month') shiftMonth(1);
  const date = e.target.closest('[data-date]')?.dataset.date;
  if (date && date >= todayStr()) {
    state.date = date;
    closePanels();
    writeUrl(true);
    load();
  }
});

$('#bar').addEventListener('change', (e) => {
  const field = e.target.closest('.field')?.dataset.field;
  if (field === 'league') {
    state.league = e.target.value;
    closePanels();
  } else if (field === 'stat' && e.target.name === 'stat') { // not the filter box, which fires change on blur
    state.stat = e.target.value;
    state.books = null;
    closePanels();
  } else if (field === 'books') {
    const checked = [...document.querySelectorAll('.field[data-field="books"] input:checked')].map((i) => i.value);
    setBooks(checked);
    return;
  } else return;
  writeUrl(true);
  load();
});

$('#bar').addEventListener('input', (e) => {
  if (e.target.matches('input[type=search]')) renderPanel('stat');
});

document.addEventListener('click', (e) => {
  // composedPath() still holds the clicked element's ancestors even if a re-render
  // has since removed it (e.g. calendar month arrows, All/None).
  if (!e.composedPath().some((el) => el.classList?.contains('field'))) closePanels();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanels();
});

$('#format').addEventListener('click', (e) => {
  const f = e.target.dataset.format;
  if (!f) return;
  format = f;
  try { localStorage.setItem('oddsFormat', f); } catch {}
  render();
});

window.addEventListener('popstate', () => {
  readUrl();
  reload();
});

$('#csv-action').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = csvId(state.league, state.date);
  let c = viewerCsv();
  if (act === 'csv-add') {
    if (!c) csvs.push((c = { id, league: state.league, date: state.date, stats: [], order: null, off: [] }));
    if (!c.stats.includes(state.stat)) c.stats.push(state.stat);
    activeCsvId = id;
    saveCsvs();
  } else if (act === 'csv-remove' && c) removeStat(c, state.stat);
  else return;
  render();
});

$('#csv-tabs').addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]')?.dataset.close;
  const c = csvs.find((x) => x.id === close);
  if (c) {
    if (!confirm(`Delete the ${c.league} ${fmtDate(c.date)} CSV?`)) return;
    csvs = csvs.filter((x) => x !== c);
    saveCsvs();
    loadCsv();
    return;
  }
  const id = e.target.closest('[data-csv]')?.dataset.csv;
  if (id && id !== activeCsv()?.id) {
    activeCsvId = id;
    saveCsvs();
    loadCsv();
  }
});

$('#csv-view').addEventListener('click', (e) => {
  const c = activeCsv();
  if (!c || !csvData) return;
  const pane = e.target.closest('[data-pane]')?.dataset.pane;
  if (pane) {
    csvPane = pane;
    return render();
  }
  const col = e.target.closest('[data-sort]')?.dataset.sort;
  if (col) {
    // First click sorts ascending; each further click on the same column flips it.
    c.sort = { col, dir: c.sort?.col === col && c.sort.dir === 'asc' ? 'desc' : 'asc' };
    saveCsvs();
    render();
    $(`#csv-view [data-sort="${CSS.escape(col)}"]`)?.focus(); // the re-render replaced the button
    return;
  }
  const el = e.target.closest('[data-act]');
  const act = el?.dataset.act;
  if (act === 'export') return exportCsv();
  if (act === 'remove') {
    removeStat(c, el.dataset.stat);
    if (activeCsv() !== c) return loadCsv(); // that was its last market
  } else if (act === 'reset') {
    c.order = null;
    c.off = [];
    saveCsvs();
  } else return;
  render();
});

// Ranking: drag a row onto another; the drop line shows which side it lands on.
const clearDrop = () => document.querySelectorAll('.rk.drop-before, .rk.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
let dropAt = null; // { book, before }

$('#csv-view').addEventListener('dragstart', (e) => {
  const row = e.target.closest?.('.rk[data-book]');
  if (!row) return;
  dragBook = row.dataset.book;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragBook);
  row.classList.add('dragging');
});
$('#csv-view').addEventListener('dragover', (e) => {
  const row = dragBook && e.target.closest('.rk[data-book]');
  if (!row) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  dropAt = { book: row.dataset.book, before: e.clientY < r.top + r.height / 2 };
  clearDrop();
  if (dropAt.book !== dragBook) row.classList.add(dropAt.before ? 'drop-before' : 'drop-after');
});
$('#csv-view').addEventListener('drop', (e) => {
  if (!dragBook || !dropAt) return;
  e.preventDefault();
  moveBook(activeCsv(), dragBook, dropAt.book, dropAt.before);
});
$('#csv-view').addEventListener('dragend', () => {
  dragBook = null;
  dropAt = null;
  render();
});

// Keyboard alternative to dragging: arrow keys on a row's grip.
$('#csv-view').addEventListener('keydown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const c = activeCsv();
  const book = grip.dataset.book;
  const order = csvTable(c, csvData).order;
  const target = order[order.indexOf(book) + (e.key === 'ArrowUp' ? -1 : 1)];
  if (!target || !moveBook(c, book, target, e.key === 'ArrowUp')) return;
  render();
  $(`#csv-view .grip[data-book="${CSS.escape(book)}"]`)?.focus();
});

$('#csv-view').addEventListener('change', (e) => {
  const c = activeCsv();
  const book = e.target.dataset.book;
  if (!c || !book) return;
  c.off = e.target.checked ? c.off.filter((b) => b !== book) : [...c.off, book];
  saveCsvs();
  render();
});

$('#views').addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]')?.dataset.view;
  if (!v || v === view) return;
  view = v;
  closePanels();
  writeUrl(true);
  reload();
});

// Hover on a price: when the API last checked it (ages change, so computed on hover).
$('#table-wrap').addEventListener('mouseover', (e) => {
  const td = e.target.closest('td[data-checked]');
  if (!td) return;
  const at = td.dataset.checked;
  const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  td.title = `Checked ${ago(at)} ago (${time})` + ('closed' in td.dataset ? '\nNot currently open for betting' : '');
});

function tick() {
  if (pruneCsvs() && view === 'csv') loadCsv();
  if (state.date && state.date < todayStr()) {
    state.date = todayStr();
    writeUrl(false);
    if (view === 'viewer') load();
  }
  renderUpdated();
}

const reload = () => (view === 'csv' ? loadCsv() : load());

// ---------- init ----------

(async function init() {
  readUrl();
  render();
  try {
    leagues = await api('/api/leagues');
  } catch (e) {
    error = e;
  }
  leaguesLoading = false;
  if (state.league && !leagues.some((l) => l.leagueID === state.league)) {
    Object.assign(state, { league: null, date: todayStr(), stat: null, books: null });
  }
  writeUrl(false);
  pruneCsvs();
  await reload();
  setInterval(tick, 1000);
})();
