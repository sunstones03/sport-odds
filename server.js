import express from 'express';

const API_BASE = 'https://api.sportsgameodds.com/v2';
const API_KEY = process.env.SPORTS_ODDS_API_KEY_HEADER;
const PORT = Number(process.env.PORT) || 3000;
// How often a watched league/day is re-checked on plans without a monthly entity cap.
const POLL_SECONDS = Number(process.env.POLL_SECONDS) || 5;
const UNCAPPED_TIERS = new Set(['pro', 'allstar']);

// Re-check interval for plans with a monthly entity cap (matches their stated update
// frequency); uncapped plans use POLL_SECONDS instead.
const REFRESH_BY_TIER = { amateur: 600, rookie: 180, pro: 30, allstar: 10 };
const DEFAULT_REFRESH = 600;
const LEAGUES_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_MS = 26 * 60 * 60 * 1000; // a local day is 23-25h across DST changes

if (!API_KEY) {
  console.error('Missing SPORTS_ODDS_API_KEY_HEADER (see .env)');
  process.exit(1);
}

class UpstreamError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function sgo(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new UpstreamError(res.status, body.error || body.message || `Upstream error ${res.status}`, res.headers.get('retry-after'));
  }
  return body;
}

// --- plan ---

let refreshSeconds = DEFAULT_REFRESH;
let tier = 'unknown';
let checkSeconds = DEFAULT_REFRESH; // POLL_SECONDS on uncapped plans, else refreshSeconds

async function getTier() {
  const { data } = await sgo('/account/usage'); // free: does not count against limits
  return data.tier;
}

// --- leagues (costs ~1 entity per league, so cached for a day) ---

let leaguesCache = null;

async function getLeagues() {
  if (leaguesCache && Date.now() - leaguesCache.at < LEAGUES_TTL_MS) return leaguesCache.data;
  const { data } = await sgo('/leagues');
  const leagues = data
    .filter((l) => l.enabled)
    .map((l) => ({ leagueID: l.leagueID, name: l.name || l.leagueID, sportID: l.sportID }))
    .sort((a, b) => a.leagueID.localeCompare(b.leagueID));
  leaguesCache = { at: Date.now(), data: leagues };
  return leagues;
}

// --- events for one league + local day (1 entity per game) ---

// SGO takes seconds to build a whole day in one response (NFL Sunday ~4s, a 124-game NCAAF
// Saturday ~10s) but under a second for a few games, so uncapped plans fetch the day as
// parallel batches of eventIDs. Batches per check are capped so a 5s poll stays well inside
// Pro's 300 requests/minute.
const MAX_PARALLEL = 8;
const LIST_REFRESH_MS = 60_000; // how often the day's eventIDs are re-listed
// Listing with these oddIDs returns every game with odds, carrying only these few markets,
// in ~0.2s. Games with no odds at all come from a separate oddsPresent=false list.
const LIST_ODDS = 'points-home-game-ml-home,points-home-reg-ml3way-home,points-all-game-ou-over,points-home-game-sp-home';

async function pagedEvents(params) {
  const events = [];
  let cursor;
  do {
    const page = await sgo('/events', { ...params, limit: 100, cursor });
    events.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

async function fetchDay(m) {
  // cancelled=false also means cancelled games aren't billed as entities.
  const day = { leagueID: m.leagueID, startsAfter: m.from, startsBefore: m.to, cancelled: false };
  let events;
  if (!UNCAPPED_TIERS.has(tier)) {
    events = await pagedEvents(day); // one call: listing first would double a capped plan's entities
  } else {
    if (!m.list || Date.now() - m.list.at > LIST_REFRESH_MS) {
      const [withOdds, noOdds] = await Promise.all([
        pagedEvents({ ...day, oddID: LIST_ODDS }),
        pagedEvents({ ...day, oddsPresent: false }),
      ]);
      m.list = { at: Date.now(), ids: withOdds.map((e) => e.eventID).sort(), noOdds };
    }
    const size = Math.max(1, Math.ceil(m.list.ids.length / MAX_PARALLEL));
    const batches = [];
    for (let i = 0; i < m.list.ids.length; i += size) batches.push(m.list.ids.slice(i, i + size));
    const fetched = await Promise.all(batches.map((ids) => pagedEvents({ eventIDs: ids.join(',') })));
    events = [...fetched.flat(), ...m.list.noOdds];
  }
  // A listed game may since have been cancelled or moved to another day.
  events = events.filter((e) => !e.status?.cancelled && e.status?.startsAt >= m.from && e.status?.startsAt < m.to);
  events.sort((a, b) => a.eventID.localeCompare(b.eventID)); // stable order for signature()
  return { fetchedAt: new Date().toISOString(), events: dropMirroredYesNo(events.map(slimEvent)) };
}

// SGO copies a book's O/U 0.5 into a yes/no market (yes = over 0.5, same price) for many
// stats, e.g. MLB points. A yes/no market whose every price is such a copy adds nothing, so
// it is dropped and only the O/U is listed (user decision 2026-10-17). One with any price of
// its own is kept whole: e.g. NFL anytime touchdown, which bet365 prices only as yes/no and
// most books' O/U puts at 1.5.
function dropMirroredYesNo(events) {
  const own = new Set(); // yes/no statIDs with at least one price that isn't a copy
  for (const e of events) {
    const ou = new Map(); // "stat|player|over" -> O/U odd
    for (const o of e.odds) if (o.betTypeID === 'ou') ou.set(`${o.statID}|${o.playerID}|${o.sideID}`, o);
    for (const o of e.odds) {
      if (o.betTypeID !== 'yn' || own.has(o.statID)) continue;
      const stat = o.statID.slice(0, -BET_TYPES.yn.length);
      const copyOf = ou.get(`${stat}|${o.playerID}|${o.sideID === 'yes' ? 'over' : 'under'}`);
      const books = Object.entries(o.byBookmaker);
      if (!copyOf || books.some(([b, q]) => Number(copyOf.byBookmaker[b]?.line) !== 0.5 || copyOf.byBookmaker[b].odds !== q.odds)) {
        own.add(o.statID);
      }
    }
  }
  for (const e of events) e.odds = e.odds.filter((o) => o.betTypeID !== 'yn' || own.has(o.statID));
  return events;
}

// Hash of everything a viewer can see change (prices, lines, open/closed, game status),
// ignoring lastUpdatedAt, so "last change" means a real change.
function signature(events) {
  let h = 0x811c9dc5;
  const add = (str) => {
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  };
  for (const e of events) {
    add(`${e.eventID}|${e.status}|${e.startsAt}|`);
    for (const o of e.odds) {
      add(`${o.statID}|${o.playerID}|${o.betTypeID}|${o.sideID}|${o.consensus.odds}|${o.consensus.line}|${o.fair.odds}|${o.fair.line}|`);
      for (const [b, q] of Object.entries(o.byBookmaker)) add(`${b}:${q.odds}:${q.line}:${q.available}|`);
    }
  }
  return h >>> 0;
}

// --- monitors: one per league + local day, re-checked while any page watches it ---

const monitors = new Map(); // key -> monitor

function getMonitor(leagueID, from, to) {
  const key = `${leagueID}|${from}|${to}`;
  for (const [k, m] of monitors) {
    if (k !== key && !m.clients.size && Date.now() - m.lastUsed > 10 * 60 * 1000) monitors.delete(k);
  }
  let m = monitors.get(key);
  if (!m) {
    m = { key, leagueID, from, to, clients: new Set(), data: null, pending: null, version: 0, checkedAt: null,
      changedAt: null, sig: null, error: null, failures: 0, lastAttemptAt: 0, timer: null, lastUsed: Date.now() };
    monitors.set(key, m);
  }
  m.lastUsed = Date.now();
  return m;
}

function monitorStatus(m) {
  return { version: m.version, checkedAt: m.checkedAt, changedAt: m.changedAt, pollSeconds: checkSeconds, error: m.error };
}

function broadcast(m) {
  const msg = `data: ${JSON.stringify(monitorStatus(m))}\n\n`;
  for (const res of m.clients) res.write(msg);
}

function check(m) {
  if (m.pending) return m.pending;
  m.lastAttemptAt = Date.now();
  m.pending = fetchDay(m)
    .then((data) => {
      const sig = signature(data.events);
      if (sig !== m.sig) {
        m.sig = sig;
        m.changedAt = data.fetchedAt;
      }
      Object.assign(m, { data, checkedAt: data.fetchedAt, error: null, failures: 0 });
      m.version++;
      return data;
    })
    .catch((err) => {
      m.failures++;
      m.error = { message: err.message, status: err.status || 500, retryAfter: err.retryAfter ? Number(err.retryAfter) : null };
      if (!m.data) throw err;
      return m.data; // keep showing the last good data
    })
    .finally(() => {
      m.pending = null;
      broadcast(m);
    });
  return m.pending;
}

// Next check runs checkSeconds after the previous one started (never overlapping);
// after failures, wait Retry-After or back off up to a minute.
function schedule(m) {
  if (m.timer || !m.clients.size) return;
  let delay = checkSeconds * 1000;
  if (m.error?.retryAfter) delay = m.error.retryAfter * 1000;
  else if (m.failures) delay = Math.min(60_000, delay * 2 ** m.failures);
  const wait = Math.max(0, m.lastAttemptAt + delay - Date.now());
  m.timer = setTimeout(async () => {
    m.timer = null;
    if (!m.clients.size) return;
    await check(m).catch(() => {});
    schedule(m);
  }, wait);
}

// Data for /api/day and /api/csv: the monitor's latest if a page is watching it (the
// stream pushes newer data as each check lands) or it is fresh enough, otherwise check
// now. Not waiting on an in-flight check keeps a market switch instant instead of ~2s.
async function getDay(leagueID, from, to) {
  const m = getMonitor(leagueID, from, to);
  if (m.data && (m.clients.size || (!m.pending && Date.now() - Date.parse(m.checkedAt) < checkSeconds * 1000))) return m;
  await check(m);
  return m;
}

// Keep only full-game, player-level odds and the fields the table needs. Period markets
// (1h, 1q, 2p…) are dropped by design: the user only wants whole-game stats.
// Sports where SGO lists the two competitors as the event's teams and gives no players
// (UFC fighters, ATP players). Their home/away markets are treated as player markets.
const SOLO_SPORTS = new Set(['MMA', 'BOXING', 'TENNIS', 'TABLE_TENNIS', 'BADMINTON', 'SNOOKER', 'DARTS']);

// Bet types the table can show, and the suffix that makes each its own market. Over/under
// keeps the raw statID; the others become e.g. "touchdowns:yes/no", "points:moneyline",
// "games:spread", so each is listed apart from the stat's O/U.
const BET_TYPES = { ou: '', yn: ':yes/no', ml: ':moneyline', sp: ':spread' };

function slimEvent(e) {
  const players = { ...e.players };
  const team = (t) => ({ teamID: t?.teamID, short: t?.names?.short || t?.names?.medium || '', long: t?.names?.long || '' });
  const solo = SOLO_SPORTS.has(e.sportID) && !Object.keys(players).length;
  const competitor = {}; // statEntityID home/away -> playerID, solo sports only
  if (solo) {
    for (const side of ['home', 'away']) {
      const t = e.teams?.[side];
      if (!t?.teamID) continue;
      players[t.teamID] = { playerID: t.teamID, name: t.names?.long || t.teamID, teamID: t.teamID };
      competitor[side] = t.teamID;
    }
  }
  const odds = [];
  for (const o of Object.values(e.odds || {})) {
    if (o.periodID !== 'game' || !(o.betTypeID in BET_TYPES)) continue;
    const playerID = o.playerID || (players[o.statEntityID] ? o.statEntityID : competitor[o.statEntityID]);
    if (!playerID) continue;
    const byBookmaker = {};
    for (const [book, b] of Object.entries(o.byBookmaker || {})) {
      if (book === 'unknown') continue; // API placeholder, not a real book
      byBookmaker[book] = { odds: b.odds, line: b.overUnder ?? b.spread ?? null, available: b.available !== false, checked: b.lastUpdatedAt ?? null };
    }
    odds.push({
      statID: o.statID + BET_TYPES[o.betTypeID],
      playerID,
      betTypeID: o.betTypeID,
      sideID: o.sideID,
      consensus: { odds: o.bookOdds ?? null, line: o.bookOverUnder ?? o.bookSpread ?? null, available: !!o.bookOddsAvailable },
      fair: { odds: o.fairOdds ?? null, line: o.fairOverUnder ?? o.fairSpread ?? null, available: !!o.fairOddsAvailable },
      byBookmaker,
    });
  }
  return {
    eventID: e.eventID,
    startsAt: e.status?.startsAt,
    status: e.status?.displayLong || '',
    away: team(e.teams?.away),
    home: team(e.teams?.home),
    players: Object.fromEntries(
      Object.values(players).map((p) => [p.playerID, { name: p.name || `${p.firstName} ${p.lastName}`, teamID: p.teamID }]),
    ),
    odds,
  };
}

// --- shaping for the UI ---

function statSummary(events) {
  const stats = new Map();
  for (const e of events) {
    for (const o of e.odds) {
      if (!stats.has(o.statID)) stats.set(o.statID, new Set());
      for (const b of Object.keys(o.byBookmaker)) stats.get(o.statID).add(b);
    }
  }
  return [...stats]
    .map(([statID, books]) => ({ statID, books: [...books].sort() }))
    .sort((a, b) => a.statID.localeCompare(b.statID));
}

// side "a" = over/yes, side "b" = under/no. Moneyline and spread have one side per
// competitor (home/away), so it goes in "a" and "b" stays empty.
const SIDE = { over: 'a', yes: 'a', under: 'b', no: 'b', home: 'a', away: 'a' };
const KINDS = ['ou', 'yn', 'ml', 'sp'];

function buildTable(events, statID, books) {
  const games = [];
  let gamesWithoutStat = 0;
  for (const e of events) {
    const rows = new Map(); // playerID -> row
    for (const o of e.odds) {
      if (o.statID !== statID || !SIDE[o.sideID]) continue;
      const key = o.playerID;
      if (!rows.has(key)) {
        const p = e.players[o.playerID] || { name: o.playerID };
        const side = p.teamID === e.away.teamID ? 'away' : p.teamID === e.home.teamID ? 'home' : '';
        rows.set(key, {
          key,
          playerID: o.playerID,
          name: p.name,
          team: side ? e[side].short : '',
          side,
          markets: Object.fromEntries(KINDS.map((k) => [k, { consensus: {}, fair: {}, books: {} }])),
        });
      }
      const m = rows.get(key).markets[o.betTypeID];
      if (!m) continue;
      const s = SIDE[o.sideID];
      m.consensus[s] = o.consensus;
      m.fair[s] = o.fair;
      for (const b of books) {
        if (o.byBookmaker[b]) (m.books[b] ||= {})[s] = o.byBookmaker[b];
      }
    }
    if (!rows.size) {
      gamesWithoutStat++;
      continue;
    }
    const order = { away: 0, home: 1, '': 2 };
    const sorted = [...rows.values()]
      .map(({ markets, ...r }) => {
        // Each market (statID + suffix) holds one bet type.
        const has = (k) => Object.keys(markets[k].consensus).length || Object.keys(markets[k].books).length;
        const kind = KINDS.find(has) || 'yn';
        return { ...r, kind, ...markets[kind] };
      })
      .sort((a, b) => order[a.side] - order[b.side] || a.name.localeCompare(b.name));
    games.push({ eventID: e.eventID, startsAt: e.startsAt, status: e.status, away: e.away, home: e.home, rows: sorted });
  }
  games.sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || '') || a.eventID.localeCompare(b.eventID));
  return { books, games, gamesWithoutStat };
}

// CSV data: one row per player, with every book's price for each
// requested stat. Picking a book per cell (ranking, fallback) is done by the page.
function buildCsv(events, statIDs, summaries) {
  const players = new Map(); // playerID -> row
  const books = new Set();
  for (const statID of statIDs) {
    const summary = summaries.find((s) => s.statID === statID);
    if (!summary) continue;
    summary.books.forEach((b) => books.add(b));
    for (const g of buildTable(events, statID, summary.books).games) {
      for (const r of g.rows) {
        if (!players.has(r.playerID)) {
          players.set(r.playerID, { playerID: r.playerID, name: r.name, team: r.team, side: r.side, startsAt: g.startsAt, eventID: g.eventID, cells: {} });
        }
        players.get(r.playerID).cells[statID] = { kind: r.kind, books: r.books, consensus: r.consensus };
      }
    }
  }
  const order = { away: 0, home: 1, '': 2 };
  const rows = [...players.values()].sort(
    (a, b) => (a.startsAt || '').localeCompare(b.startsAt || '') || a.eventID.localeCompare(b.eventID) ||
      order[a.side] - order[b.side] || a.name.localeCompare(b.name),
  );
  return { books: [...books].sort(), rows };
}

// --- routes ---

const app = express();
app.use(express.static('public'));

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    const status = err.status || 500;
    if (err.retryAfter) res.set('Retry-After', err.retryAfter);
    res.status(status).json({ error: err.message, status, retryAfter: err.retryAfter ? Number(err.retryAfter) : null });
  }
};

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

function parseRange({ league, from, to }) {
  if (!league || !/^[A-Z0-9_]+$/.test(league)) throw badRequest('Invalid league');
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!start || !end || end <= start || end - start > MAX_DAY_MS) throw badRequest('Invalid day range');
  if (end < Date.now()) throw badRequest('Past days are not supported');
  return { league, from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

app.get('/api/leagues', route(getLeagues));

app.get(
  '/api/day',
  route(async (req) => {
    const { stat, books } = req.query;
    const range = parseRange(req.query);
    const m = await getDay(range.league, range.from, range.to);
    const day = m.data;
    const stats = statSummary(day.events);
    const result = {
      ...monitorStatus(m),
      gameCount: day.events.length,
      playerOddsCount: day.events.reduce((n, e) => n + e.odds.length, 0),
      games: day.events
        .map((e) => ({
          eventID: e.eventID,
          startsAt: e.startsAt,
          status: e.status,
          away: e.away,
          home: e.home,
          statCount: new Set(e.odds.map((o) => o.statID)).size,
          playerCount: new Set(e.odds.map((o) => o.playerID)).size,
        }))
        .sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || '')),
      stats,
      table: null,
    };
    const summary = stats.find((s) => s.statID === stat);
    if (summary) {
      const wanted = books == null ? summary.books : String(books).split(',').filter(Boolean);
      result.table = buildTable(day.events, stat, summary.books.filter((b) => wanted.includes(b)));
    }
    return result;
  }),
);

app.get(
  '/api/csv',
  route(async (req) => {
    const range = parseRange(req.query);
    const statIDs = String(req.query.stats || '').split(',').filter(Boolean);
    const m = await getDay(range.league, range.from, range.to);
    const stats = statSummary(m.data.events);
    return {
      ...monitorStatus(m),
      available: statIDs.filter((s) => stats.some((x) => x.statID === s)),
      ...buildCsv(m.data.events, statIDs, stats),
    };
  }),
);

// Server-Sent Events: tells open pages each time their league/day has been re-checked.
app.get('/api/stream', (req, res) => {
  let range;
  try {
    range = parseRange(req.query);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const m = getMonitor(range.league, range.from, range.to);
  m.clients.add(res);
  if (m.data) res.write(`data: ${JSON.stringify(monitorStatus(m))}\n\n`);
  schedule(m);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    m.clients.delete(res);
    m.lastUsed = Date.now();
    if (!m.clients.size && m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
  });
});

try {
  tier = await getTier();
  const t = String(tier).toLowerCase().replace(/[^a-z]/g, '');
  refreshSeconds = REFRESH_BY_TIER[t] ?? DEFAULT_REFRESH;
  checkSeconds = UNCAPPED_TIERS.has(t) ? POLL_SECONDS : refreshSeconds;
} catch (err) {
  console.warn(`Could not read plan tier (${err.message}); using ${DEFAULT_REFRESH}s refresh`);
}

app.listen(PORT, () => {
  console.log(`Plan: ${tier}, checking watched games every ${checkSeconds}s`);
  console.log(`http://localhost:${PORT}`);
});
