// Elementrix web server: serves the static site + tracks REAL server uptime.
// Polls the Minecraft Java server every POLL_MS, appends {t, ok} to
// data/history.json, and exposes it all at GET /api/status.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { status: mcStatus } = require('minecraft-server-util');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MC_HOST = process.env.MC_HOST || 'elementrix.xyz';
const MC_PORT = parseInt(process.env.MC_PORT || '25565', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '60000', 10);
const GRACE_MS = parseInt(process.env.UPTIME_GRACE_MS || '300000', 10); // offline runs this short count as restarts, not downtime
const WINDOW_DAYS = 30;
const DATA_FILE = path.join(__dirname, 'data', 'history.json');
const TIERS_API_BASE = process.env.TIERS_API_BASE || 'https://tiers.elementrix.xyz';
const TIERS_CACHE_MS = parseInt(process.env.TIERS_CACHE_MS || '60000', 10);
let tiersCache = { at: 0, data: null };

// ---------- player analytics (pushed by the MC plugin) ----------
const ANALYTICS_SECRET = process.env.ANALYTICS_SECRET || 'ELEMENTRIXCORE';
const ANALYTICS_FILE = path.join(__dirname, 'data', 'analytics.json');
const ANALYTICS_RETENTION_MS = 95 * 864e5;
let analytics = { samples: [], sessions: [], peak: { n: 0, t: null } };
try {
  const raw = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
  if (raw && Array.isArray(raw.samples)) analytics = raw;
} catch (e) { /* first run */ }
if (!Array.isArray(analytics.sessions)) analytics.sessions = [];
if (!analytics.peak) analytics.peak = { n: 0, t: null };

let analyticsSaveTimer = null;
function saveAnalytics() {
  if (analyticsSaveTimer) return;
  analyticsSaveTimer = setTimeout(() => {
    analyticsSaveTimer = null;
    fs.mkdir(path.dirname(ANALYTICS_FILE), { recursive: true }, () => {
      fs.writeFile(ANALYTICS_FILE, JSON.stringify(analytics), () => {});
    });
  }, 2000);
}

// ---------- uptime store ----------
let history = [];
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (Array.isArray(raw)) history = raw.filter((r) => r && typeof r.t === 'number');
} catch (e) { /* first run, no history yet */ }

let latest = {
  online: false,
  playersOnline: 0,
  playersMax: 0,
  version: null,
  motd: null,
  lastChecked: null,
  error: 'warming up — first poll pending',
};

function save() {
  fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
    fs.writeFile(DATA_FILE, JSON.stringify(history), () => {});
  });
}

function prune() {
  const cut = Date.now() - WINDOW_DAYS * 864e5;
  history = history.filter((r) => r.t >= cut);
  if (history.length > 50000) history = history.slice(-50000);
}

// Percent of successful polls in the last `days` (null = not enough data yet).
// Offline runs lasting GRACE_MS or less are forgiven as restarts.
function uptimePct(days) {
  const cut = Date.now() - days * 864e5;
  const window = history.filter((r) => r.t >= cut);
  if (!window.length) return null;
  const down = new Set();
  let i = 0;
  while (i < window.length) {
    if (window[i].ok) { i++; continue; }
    let j = i;
    while (j + 1 < window.length && !window[j + 1].ok) j++;
    const span = (window[j].t - window[i].t) + POLL_MS;
    if (span > GRACE_MS) for (let k = i; k <= j; k++) down.add(k);
    i = j + 1;
  }
  const up = window.filter((_, idx) => !down.has(idx)).length;
  return Math.round((up / window.length) * 1000) / 10;
}

async function poll() {
  try {
    const res = await mcStatus(MC_HOST, MC_PORT, { timeout: 8000 });
    latest = {
      online: true,
      playersOnline: res.players.online,
      playersMax: res.players.max,
      version: res.version.name || null,
      motd: ((res.motd && res.motd.clean) || '').trim().slice(0, 140) || null,
      lastChecked: new Date().toISOString(),
      error: null,
    };
    history.push({ t: Date.now(), ok: true });
  } catch (e) {
    latest = {
      online: false,
      playersOnline: 0,
      playersMax: 0,
      version: null,
      motd: null,
      lastChecked: new Date().toISOString(),
      error: 'server unreachable',
    };
    history.push({ t: Date.now(), ok: false });
  }
  prune();
  save();
}

// ---------- app ----------
const app = express();

// Never leak backend internals through the static middleware.
app.use(['/data', '/server.js', '/package.json', '/package-lock.json', '/node_modules'],
  (req, res) => res.status(403).end());

app.use(express.json({ limit: '1mb' }));

// Clean URLs: /rules + /status serve the pages, the old .html URLs
// 301-redirect to them so bookmarks keep working and search engines
// consolidate ranking signals on the canonical (extensionless) URL.
app.get('/rules.html', (req, res) => res.redirect(301, '/rules'));
app.get('/status.html', (req, res) => res.redirect(301, '/status'));
app.get('/event.html', (req, res) => res.redirect(301, '/event'));
app.get('/rules', (req, res) => res.sendFile(path.join(__dirname, 'rules.html')));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'status.html')));
app.get('/event', (req, res) => res.sendFile(path.join(__dirname, 'event.html')));

app.use(express.static(__dirname));

app.get('/api/status', (req, res) => {
  res.json({
    server: { host: MC_HOST, port: MC_PORT },
    online: latest.online,
    players: { online: latest.playersOnline, max: latest.playersMax },
    version: latest.version,
    motd: latest.motd,
    lastChecked: latest.lastChecked,
    error: latest.error,
    uptime: {
      pct24h: uptimePct(1),
      pct30d: uptimePct(30),
      checks: history.length,
      trackingSince: history.length ? new Date(history[0].t).toISOString() : null,
      graceMin: GRACE_MS / 60000,
    },
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// UptimeRobot-friendly health check: GET /health -> 200 "ok" (plain text).
app.get('/health', (req, res) => res.type('text').send('ok'));

// Player analytics, pushed by the ElementrixCore plugin (shared secret).
// POST {secret, samples:[{id,ts,n}], sessions:[{id,uuid,name,join,quit,dur}]}
app.post('/api/analytics/ingest', (req, res) => {
  if (!ANALYTICS_SECRET) return res.status(503).json({ error: 'ingest not configured' });
  const body = req.body || {};
  if (body.secret !== ANALYTICS_SECRET) return res.status(403).json({ error: 'bad secret' });

  const now = Date.now();
  const cut = now - ANALYTICS_RETENTION_MS;
  let addedSamples = 0, addedSessions = 0;

  if (Array.isArray(body.samples)) {
    const seen = new Set(analytics.samples.map((s) => s.t));
    for (const s of body.samples) {
      const t = Number(s.ts), n = Number(s.n);
      if (!Number.isFinite(t) || !Number.isFinite(n) || t < cut || t > now + 36e5) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      analytics.samples.push({ t, n: Math.max(0, Math.round(n)) });
      addedSamples++;
    }
  }
  if (Array.isArray(body.sessions)) {
    for (const s of body.sessions) {
      const join = Number(s.join), quit = Number(s.quit), dur = Number(s.dur);
      if (!Number.isFinite(join) || !Number.isFinite(quit) || quit < join || join < cut) continue;
      if (analytics.sessions.some((x) => x.join === join && x.uuid === String(s.uuid || ''))) continue;
      analytics.sessions.push({
        uuid: String(s.uuid || '').slice(0, 40),
        name: String(s.name || '').slice(0, 24),
        join, quit, dur: Math.max(0, Math.round(Number.isFinite(dur) ? dur : (quit - join) / 1000)),
      });
      addedSessions++;
    }
  }

  analytics.samples = analytics.samples.filter((s) => s.t >= cut).sort((a, b) => a.t - b.t);
  if (analytics.samples.length > 30000) analytics.samples = analytics.samples.slice(-30000);
  analytics.sessions = analytics.sessions.filter((s) => s.quit >= cut);
  if (analytics.sessions.length > 20000) analytics.sessions = analytics.sessions.slice(-20000);

  // All-time peak from samples.
  for (const s of analytics.samples) {
    if (s.n > analytics.peak.n) analytics.peak = { n: s.n, t: s.t };
  }

  saveAnalytics();
  res.json({ received: true, addedSamples, addedSessions });
});

// Graph data: GET /api/analytics?range=7d|30d|90d
// -> {points:[[ts,avgN],...], peak:{n,t}, avgSessionSec, now:{n,t}, samples}
app.get('/api/analytics', (req, res) => {
  const days = req.query.range === '30d' ? 30 : req.query.range === '90d' ? 90 : 7;
  const cut = Date.now() - days * 864e5;
  const samples = analytics.samples.filter((s) => s.t >= cut);

  // Downsample into at most 200 buckets (average per bucket).
  const buckets = Math.max(1, Math.ceil(samples.length / 200));
  const points = [];
  for (let i = 0; i < samples.length; i += buckets) {
    const slice = samples.slice(i, i + buckets);
    const avg = slice.reduce((a, s) => a + s.n, 0) / slice.length;
    points.push([slice[Math.floor(slice.length / 2)].t, Math.round(avg * 10) / 10]);
  }

  const inRange = analytics.sessions.filter((s) => s.quit >= cut && s.dur > 0);
  const avgSessionSec = inRange.length
    ? Math.round(inRange.reduce((a, s) => a + s.dur, 0) / inRange.length)
    : null;
  const avgPlayers = samples.length
    ? Math.round((samples.reduce((a, s) => a + s.n, 0) / samples.length) * 10) / 10
    : null;

  const last = analytics.samples[analytics.samples.length - 1] || null;
  res.json({
    range: days + 'd',
    points,
    peak: analytics.peak.n > 0 ? analytics.peak : null,
    avgSessionSec,
    avgPlayers,
    sessions: inRange.length,
    now: last ? { n: last.n, t: last.t } : null,
  });
});

// Live tierlist, proxied so the frontend never hits CORS issues and the
// tiers site being down degrades gracefully (frontend keeps its mock).
// Shape returned: [{username, tier, element, notes}] from /api/v1/tiers.
app.get('/api/tiers', async (req, res) => {
  if (tiersCache.data && Date.now() - tiersCache.at < TIERS_CACHE_MS) {
    return res.json(tiersCache.data);
  }
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${TIERS_API_BASE}/api/v1/tiers`, { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error('tiers api ' + r.status);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('tiers api bad shape');
    tiersCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    // 200 (not 502) so browsers don't log console noise — the frontend
    // treats any non-array body as "tiers down" and keeps its mock.
    res.json({ error: 'tierlist unreachable' });
  }
});

// Anything unmatched serves the themed 404 page (unknown API paths get JSON).
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not found' });
  }
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

poll();
setInterval(poll, POLL_MS);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Elementrix web on :${PORT} — polling ${MC_HOST}:${MC_PORT} every ${POLL_MS}ms`);
});
