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
