#!/usr/bin/env node
/**
 * Family Panel — Server with Home Assistant Integration
 * Node.js 18+, zero external dependencies.
 *
 * Usage:
 *   node server.js
 *   node server.js --port 8080
 *
 * Configuration:
 *   Edit config.json — set ha_token, ha_url, port, etc.
 *   Environment variables override config.json values:
 *     FP_HA_TOKEN, FP_HA_URL, FP_PORT
 *
 * Diagnostic endpoint (open in browser to test HA connection):
 *   http://localhost:8080/api/ha/test
 */

'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// SHA-256 hash for admin password storage
function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

// In-memory admin session tokens (cleared on server restart)
const ADMIN_SESSIONS = new Set();
// ─────────────────────────────────────────────────────────
// FP_DATA_DIR lets the data directory be moved (e.g. to a Docker named volume).
// Falls back to the app directory so existing non-Docker installs are unaffected.
const DATA_DIR   = process.env.FP_DATA_DIR ? path.resolve(process.env.FP_DATA_DIR) : __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  // If no config.json exists but env vars supply the essentials, continue with defaults
  if (process.env.FP_HA_URL && process.env.FP_HA_TOKEN) {
    console.warn('  ⚠ No config.json found — using FP_HA_URL / FP_HA_TOKEN env vars');
  } else {
    console.error(`  ✗ Could not read config.json: ${e.message}`);
    console.error('    Either create config.json or set FP_HA_URL and FP_HA_TOKEN env vars.');
    process.exit(1);
  }
}

// CLI --port flag overrides everything
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i !== -1) return parseInt(process.argv[i + 1], 10);
  return parseInt(process.env.FP_PORT || cfg.port || '8080', 10);
})();

// Environment variables override config.json (useful for secrets in production)
const HA_URL   = (process.env.FP_HA_URL   || cfg.ha_url   || '').replace(/\/$/, '');
const HA_TOKEN =  process.env.FP_HA_TOKEN || cfg.ha_token || '';
// True only when a real token is set (not the example placeholder, not empty)
const HA_TOKEN_SET = HA_TOKEN.length > 20 && HA_TOKEN !== 'PASTE_YOUR_LONG_LIVED_TOKEN_HERE';

const CALENDARS_STATIC      = cfg.calendars      || [];
const STATE_ENTITIES_STATIC = cfg.state_entities || [];

// Resolve the real client IP, honouring X-Real-IP / X-Forwarded-For ONLY when
// the TCP connection arrives from a trusted proxy IP configured in Admin →
// Settings → Trusted Proxies. Loopback (127.0.0.1 / ::1) is always trusted.
// Headers are never trusted from unknown sources — external clients cannot spoof.
function getClientIP(req) {
  const raw = req.socket.remoteAddress || '';
  const socketIP = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const isLoopback = socketIP === '127.0.0.1' || socketIP === '::1' || socketIP === 'localhost';
  const configured = getLiveData()?.settings?.trustedProxies || [];
  if (isLoopback || configured.includes(socketIP)) {
    const realIP = req.headers['x-real-ip'];
    if (realIP) return realIP.trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return socketIP;
}

// Read live config from data.json (so admin changes take effect without restart)
function getLiveData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function recordBlockedIP(clientIP) {
  try {
    const data = getLiveData();
    data.settings = data.settings || {};
    const log = data.settings.blockedIPLog || [];
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Prune entries older than 7 days
    const pruned = log.filter(e => (e.lastSeen || e.firstSeen || '') >= cutoff);
    const existing = pruned.find(e => e.ip === clientIP);
    if (existing) {
      existing.lastSeen = now;
      existing.count = (existing.count || 1) + 1;
    } else {
      pruned.push({ ip: clientIP, firstSeen: now, lastSeen: now, count: 1 });
    }
    data.settings.blockedIPLog = pruned;
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}
function getCalendars()     { const d = getLiveData(); return d.calendars     || CALENDARS_STATIC; }
function getStateEntities() {
  const d = getLiveData();
  // Prefer the new structured fields; fall back to legacy state_entities array
  const ids = new Set();
  (d.topbar_buttons  || []).forEach(b => { if (b.entity) ids.add(b.entity); });
  (d.control_buttons || []).forEach(b => { if (b.entity) ids.add(b.entity); });
  (d.sensors         || []).forEach(s => { if (s.entity) ids.add(s.entity); });
  ((d.custom_dashboard || {}).widgets || []).forEach(w => { if (w.entity) ids.add(w.entity); });
  if (ids.size) return [...ids];
  return (d.state_entities || STATE_ENTITIES_STATIC).map(e => typeof e === 'string' ? e : e.id);
}

// ─────────────────────────────────────────────────────────
//  PATHS & MIME
// ─────────────────────────────────────────────────────────
const ROOT      = __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ─────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2_000_000) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  const buf  = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Content-Length':              buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-store',
  });
  res.end(buf);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + path.basename(filePath));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type':   MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control':  'no-store',
    });
    res.end(data);
  });
}

// Extract path from request URL without using url.parse()
function getPathname(reqUrl) {
  // reqUrl is like "/api/ha/states?foo=bar" — we only want the path part
  const q = reqUrl.indexOf('?');
  const raw = q === -1 ? reqUrl : reqUrl.slice(0, q);
  return raw.replace(/\/+$/, '') || '/';
}

// ─────────────────────────────────────────────────────────
//  HOME ASSISTANT HTTP CLIENT
//  Uses Node's built-in http/https — no url.parse()
// ─────────────────────────────────────────────────────────
function haRequest(method, haPath, bodyObj) {
  return new Promise((resolve, reject) => {
    // Parse HA_URL once using WHATWG URL (no url.parse)
    let base;
    try {
      base = new URL(HA_URL);
    } catch (e) {
      return reject(new Error(`HA_URL "${HA_URL}" is not a valid URL: ${e.message}`));
    }

    const isHttps = base.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const port    = base.port ? parseInt(base.port, 10) : (isHttps ? 443 : 80);

    const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;

    const options = {
      hostname: base.hostname,
      port,
      path:     haPath,   // already includes query string when needed
      method,
      headers: {
        'Authorization': `Bearer ${HA_TOKEN}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
    };

    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          console.error(`  ✗ HA ${method} ${haPath} → HTTP ${res.statusCode}`);
          console.error(`    Raw body: ${raw.slice(0, 500)}`);
        }
        let parsed;
        try   { parsed = JSON.parse(raw); }
        catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error(`HA request timed out after 10s: ${method} ${haPath}`));
    });

    req.on('error', err => {
      reject(new Error(`HA connection error (${method} ${haPath}): ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Simple HTTPS GET → parsed JSON (for Open-Meteo proxy)
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'family-panel/1.0' } }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse failed: ${buf.slice(0, 80)}`)); }
      });
    }).on('error', reject);
  });
}

// Convenience: GET a single HA state
async function haGetState(entityId) {
  const r = await haRequest('GET', `/api/states/${entityId}`);
  if (r.status === 404) return { state: 'unknown',      attributes: {} };
  if (r.status >= 400)  return { state: 'unavailable',  attributes: {} };
  return { state: r.body.state ?? 'unknown', attributes: r.body.attributes ?? {} };
}

// Convenience: GET calendar events for a date range
async function haGetCalendar(entityId, startISO, endISO) {
  const qs   = `start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
  const r    = await haRequest('GET', `/api/calendars/${entityId}?${qs}`);
  if (!Array.isArray(r.body)) {
    console.warn(`  ⚠ Calendar ${entityId}: unexpected response`, JSON.stringify(r.body).slice(0, 100));
    return [];
  }
  return r.body;
}

// ─────────────────────────────────────────────────────────
//  IMMICH HTTP CLIENT
// ─────────────────────────────────────────────────────────
function immichRequest(immichUrl, apiKey, immichPath, asBuffer) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(immichUrl); }
    catch (e) { return reject(new Error(`Immich URL "${immichUrl}" is invalid: ${e.message}`)); }

    const isHttps = base.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const port    = base.port ? parseInt(base.port, 10) : (isHttps ? 443 : 80);

    const options = {
      hostname: base.hostname,
      port,
      path:     immichPath,
      method:   'GET',
      headers:  { 'x-api-key': apiKey, 'Accept': asBuffer ? 'image/*' : 'application/json' },
    };

    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (asBuffer) { resolve({ status: res.statusCode, buf, contentType: res.headers['content-type'] || 'image/jpeg' }); return; }
        let parsed;
        try   { parsed = JSON.parse(buf.toString('utf8')); }
        catch { parsed = buf.toString('utf8'); }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Immich request timed out')); });
    req.on('error', err => reject(new Error(`Immich connection error: ${err.message}`)));
    req.end();
  });
}

function getImmichCfg() {
  const d = getLiveData();
  return {
    url:    (d.settings?.immichUrl    || '').replace(/\/$/, ''),
    apiKey: d.settings?.immichApiKey  || '',
    album:  d.settings?.immichAlbumId || '',
  };
}


const server = http.createServer(async (req, res) => {
  const method   = req.method.toUpperCase();
  const pathname = getPathname(req.url);

  // ── CORS preflight ──────────────────────────────────────
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── IP ALLOWLIST ─────────────────────────────────────────
  // Only enforced when settings.allowedIPs is a non-empty array.
  // Localhost is always allowed so the host machine can reach admin.
  // /admin/login POST is always allowed so you can log in to manage the list.
  const isAdminLogin = pathname === '/admin/login' && method === 'POST';
  if (!isAdminLogin) {
    let allowedIPs = [];
    try { allowedIPs = getLiveData()?.settings?.allowedIPs || []; } catch {}
    if (Array.isArray(allowedIPs) && allowedIPs.length > 0) {
      // Normalise IPv6-mapped IPv4 (::ffff:192.168.1.5 → 192.168.1.5)
      const clientIP = getClientIP(req);
      const isLocal  = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === 'localhost';
      const allowedIPStrings = allowedIPs.map(e => (typeof e === 'string' ? e : e.ip));
      if (!isLocal && !allowedIPStrings.includes(clientIP)) {
        console.warn(`  ✗ IP blocked: ${clientIP} — not in allowlist`);
        recordBlockedIP(clientIP);
        const isPage = !pathname.startsWith('/api/');
        if (isPage) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Access Restricted</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f1eb;font-family:system-ui,sans-serif}
.card{background:#fff;border:1px solid #e5e0d5;border-radius:16px;padding:40px;width:360px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.07)}
h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#1a1815}p{font-size:13px;color:#7a746a;line-height:1.6}
code{background:#f4f1eb;padding:2px 7px;border-radius:4px;font-size:12px;}</style></head>
<body><div class="card"><div style="font-size:40px;margin-bottom:16px">🔒</div>
<h1>Access Restricted</h1>
<p>You do not have permission to access this page.<br><br>Please check with your Administrator.</p></div></body></html>`);
        } else {
          sendJSON(res, 403, { error: 'IP not in allowlist', ip: clientIP });
        }
        return;
      }
    }
  }

  // ── /api/version ────────────────────────────────────────
  if (pathname === '/api/version' && method === 'GET') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      sendJSON(res, 200, { version: pkg.version || 'unknown' });
    } catch { sendJSON(res, 200, { version: 'unknown' }); }
    return;
  }

  // ── /api/data  GET ──────────────────────────────────────
  if (pathname === '/api/data' && method === 'GET') {
    fs.readFile(DATA_FILE, 'utf8', (err, raw) => {
      if (err) { sendJSON(res, 500, { error: 'Cannot read data.json', detail: err.message }); return; }
      try     { sendJSON(res, 200, JSON.parse(raw)); }
      catch   { sendJSON(res, 500, { error: 'data.json contains invalid JSON' }); }
    });
    return;
  }

  // ── /api/data  POST ─────────────────────────────────────
  if (pathname === '/api/data' && method === 'POST') {
    try {
      const raw = await readBody(req);
      const obj = JSON.parse(raw);  // validate
      const out = JSON.stringify(obj, null, 2);
      fs.writeFile(DATA_FILE, out, 'utf8', err => {
        if (err) { sendJSON(res, 500, { error: 'Cannot write data.json', detail: err.message }); return; }
        sendJSON(res, 200, { ok: true });
      });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid JSON body', detail: e.message });
    }
    return;
  }

  // ── /api/myip  GET ───────────────────────────────────────
  // Returns the caller's IP as seen by the server — used by admin to detect
  // the current device's IP for easy allowlist entry
  if (pathname === '/api/myip' && method === 'GET') {
    const ip = getClientIP(req);
    sendJSON(res, 200, { ip });
    return;
  }
  // Returns the parts of config.json that are safe to expose to the admin UI
  // (never exposes ha_token)
  if (pathname === '/api/config' && method === 'GET') {
    sendJSON(res, 200, {
      ha_url:       HA_URL,
      port:         PORT,
      token_set:    HA_TOKEN_SET,
      url_from_env: !!process.env.FP_HA_URL,
      token_from_env: !!process.env.FP_HA_TOKEN,
    });
    return;
  }

  // ── /api/config  POST ───────────────────────────────────
  // Saves ha_url and optionally ha_token back to config.json
  // Body: { ha_url?, ha_token? }
  if (pathname === '/api/config' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      // Re-read current config so we don't clobber other fields
      let current = {};
      try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
      if (body.ha_url)   current.ha_url   = body.ha_url.replace(/\/$/, '');
      if (body.ha_token) current.ha_token = body.ha_token.trim();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2), 'utf8');
      sendJSON(res, 200, { ok: true, note: 'Restart server for ha_url / ha_token changes to take effect.' });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ── /api/ha/ping  GET ────────────────────────────────────
  // Quick HA connectivity check surfaced in admin UI
  if (pathname === '/api/ha/ping' && method === 'GET') {
    try {
      const r = await haRequest('GET', '/api/');
      sendJSON(res, 200, {
        ok:      r.status === 200,
        status:  r.status,
        message: r.body?.message ?? String(r.body).slice(0, 80),
        ha_url:  HA_URL,
        token_set: HA_TOKEN_SET,
      });
    } catch (e) {
      sendJSON(res, 200, { ok: false, error: e.message, ha_url: HA_URL });
    }
    return;
  }
  if (pathname === '/api/ha/test' && method === 'GET') {
    const result = {
      config: { ha_url: HA_URL, token_set: HA_TOKEN_SET, token_length: HA_TOKEN.length },
      api_ping: null,
      sample_entity: null,
      errors: [],
    };
    try {
      const ping = await haRequest('GET', '/api/');
      result.api_ping = { status: ping.status, message: ping.body?.message ?? ping.body };
    } catch (e) {
      result.errors.push({ step: 'api_ping', error: e.message });
    }
    try {
      const sample = await haGetState('alarm_control_panel.master');
      result.sample_entity = sample;
    } catch (e) {
      result.errors.push({ step: 'sample_entity', error: e.message });
    }
    const ok = result.errors.length === 0 && result.api_ping?.status === 200;
    sendJSON(res, ok ? 200 : 502, result);
    return;
  }

  // ── /api/ha/services  GET  ─── SERVICE SCHEMA DIAGNOSTIC ─
  // Visit http://localhost:8080/api/ha/services?domain=ms365_calendar
  // Returns the full schema for every service in that domain — shows exact field names HA expects.
  if (pathname === '/api/ha/services' && method === 'GET') {
    try {
      const qIdx   = req.url.indexOf('?');
      const qs     = qIdx !== -1 ? req.url.slice(qIdx + 1) : '';
      const domain = qs.split('&').find(p => p.startsWith('domain='))?.split('=')[1] || '';
      const r      = await haRequest('GET', '/api/services');
      if (r.status !== 200) { sendJSON(res, r.status, { error: 'HA returned ' + r.status }); return; }
      const all = Array.isArray(r.body) ? r.body : [];
      const filtered = domain
        ? all.filter(s => s.domain === domain)
        : all.filter(s => s.domain.includes('calendar'));
      sendJSON(res, 200, filtered);
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/states  GET ─────────────────────────────────
  if (pathname === '/api/ha/states' && method === 'GET') {
    try {
      // Poll both configured state_entities AND any user haEntity fields
      const data = getLiveData();
      const entityIds = new Set([
        ...getStateEntities(),
        ...(data.users || []).filter(u => u.haEntity).map(u => u.haEntity),
      ]);
      const pairs = await Promise.all(
        [...entityIds].map(id =>
          haGetState(id)
            .then(s  => [id, s])
            .catch(e => { console.error(`  ✗ State ${id}: ${e.message}`); return [id, { state: 'unavailable', attributes: {} }]; })
        )
      );
      sendJSON(res, 200, Object.fromEntries(pairs));
    } catch (e) {
      console.error('  ✗ /api/ha/states error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/weather  GET ───────────────────────────────────
  // Returns current weather. Uses HA weather entity if configured,
  // otherwise geocodes weatherLocation and hits Open-Meteo.
  if (pathname === '/api/weather' && method === 'GET') {
    try {
      const liveData     = getLiveData();
      const haEntity     = liveData?.settings?.weatherEntity?.trim() || '';
      const locationStr  = liveData?.settings?.weatherLocation?.trim() || 'Hamilton, NZ';

      // ── Source 1: HA weather entity ──────────────────────
      if (haEntity) {
        const s = await haGetState(haEntity);
        if (s.state && s.state !== 'unavailable' && s.state !== 'unknown') {
          const attr = s.attributes || {};
          // HA condition → WMO-style emoji mapping
          const HA_ICONS = {
            'sunny': '☀️', 'clear-night': '🌙', 'partlycloudy': '⛅',
            'cloudy': '☁️', 'fog': '🌫️', 'rainy': '🌧️', 'pouring': '🌧️',
            'snowy': '❄️', 'snowy-rainy': '🌨️', 'windy': '🌬️',
            'windy-variant': '🌬️', 'hail': '🌨️', 'lightning': '⛈️',
            'lightning-rainy': '⛈️', 'exceptional': '🌡️',
          };
          const icon  = HA_ICONS[s.state] || '🌡️';
          const desc  = s.state.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          const temp  = attr.temperature  != null ? Math.round(attr.temperature)  : null;
          const feels = attr.apparent_temperature != null ? Math.round(attr.apparent_temperature) : null;
          console.log(`  ✓ Weather (HA ${haEntity}): ${desc}, ${temp}°`);
          sendJSON(res, 200, { source: 'ha', icon, desc, temp, feels, entity: haEntity });
          return;
        }
        console.warn(`  ⚠ Weather: HA entity "${haEntity}" returned state "${s.state}", falling back to Open-Meteo`);
      }

      // ── Source 2: Open-Meteo (proxied through server) ────
      const WMO_ICONS = {
        0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️', 45:'🌫️', 48:'🌫️',
        51:'🌦️', 53:'🌦️', 55:'🌧️', 61:'🌦️', 63:'🌧️', 65:'🌧️',
        71:'🌨️', 73:'❄️', 75:'❄️', 80:'🌦️', 81:'🌧️', 82:'⛈️', 95:'⛈️', 99:'⛈️',
      };
      const WMO_CODES = {
        0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast',
        45:'Fog', 48:'Icy fog', 51:'Light drizzle', 53:'Drizzle', 55:'Heavy drizzle',
        61:'Light rain', 63:'Rain', 65:'Heavy rain', 71:'Light snow', 73:'Snow', 75:'Heavy snow',
        80:'Light showers', 81:'Showers', 82:'Heavy showers', 95:'Thunderstorm', 99:'Thunderstorm + hail',
      };

      // Geocode — split "Hamilton, NZ" → name=Hamilton&countryCode=NZ
      const [geoCity, geoCountry] = locationStr.split(',').map(s => s.trim());
      const geoCCParam = geoCountry ? `&countryCode=${encodeURIComponent(geoCountry)}` : '';
      const geoUrl  = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(geoCity)}&count=1&language=en&format=json${geoCCParam}`;
      const geoData = await httpsGetJSON(geoUrl);
      const loc     = geoData?.results?.[0];
      if (!loc) {
        sendJSON(res, 404, { error: `No geocoding result for "${locationStr}"` });
        return;
      }
      const tz = (loc.timezone && loc.timezone !== 'null') ? encodeURIComponent(loc.timezone) : 'auto';
      const wxUrl  = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m&wind_speed_unit=kmh&timezone=${tz}`;
      const wxData = await httpsGetJSON(wxUrl);
      const c      = wxData?.current;
      if (!c) { sendJSON(res, 502, { error: 'No current weather data from Open-Meteo' }); return; }

      const code = c.weather_code;
      const temp = Math.round(c.temperature_2m);
      const feels = Math.round(c.apparent_temperature);
      console.log(`  ✓ Weather (Open-Meteo, ${locationStr}): ${WMO_CODES[code] || code}, ${temp}°`);
      sendJSON(res, 200, {
        source: 'open-meteo',
        icon:   WMO_ICONS[code] || '🌡️',
        desc:   WMO_CODES[code] || '',
        temp, feels,
        location: locationStr,
      });
    } catch (e) {
      console.error('  ✗ /api/weather error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/calendar  GET ───────────────────────────────
  if (pathname === '/api/ha/calendar' && method === 'GET') {
    try {
      // Read dedup setting live from data.json so admin changes take effect immediately
      let dedupEnabled = true;
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        dedupEnabled = JSON.parse(raw)?.settings?.calendarDedup !== false;
      } catch { /* use default true if file unreadable */ }

      const now   = new Date();
      // Use client-supplied range if provided (allows fetching future months on demand)
      // Otherwise fall back to default: 7 days back, 90 days forward
      const calQS  = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
      const qStart = calQS.get('start');
      const qEnd   = calQS.get('end');
      const start  = qStart ? new Date(qStart) : new Date(now.getTime() - 7  * 86400000);
      const end    = qEnd   ? new Date(qEnd)   : new Date(now.getTime() + 90 * 86400000);
      const sISO   = start.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const eISO   = end.toISOString().replace(/\.\d{3}Z$/, 'Z');
      console.log(`  → Calendar range: ${sISO.slice(0,10)} → ${eISO.slice(0,10)}${qStart ? ' (client-requested)' : ' (default)'}`);

      // Calendar priority order — first calendar to claim a UID wins display
      // This deduplicates events that appear in multiple calendars (e.g. shared
      // events accepted by both Bob and Laura).
      const seenUids = new Set();
      const allEvents = [];

      for (const cal of getCalendars()) {
        let raw = [];
        try { raw = await haGetCalendar(cal.entity, sISO, eISO); }
        catch (e) { console.warn(`  ⚠ Calendar ${cal.entity}: ${e.message}`); }

        for (const ev of raw) {
          const uid = ev.uid || ev.iCalUID || null;

          const allDay   = !ev.start?.dateTime;
          const rawStart = ev.start?.dateTime || ev.start?.date || '';
          const rawEnd   = ev.end?.dateTime   || ev.end?.date   || '';

          // Normalise datetime for dedup: strip timezone offset (+12:00, Z, etc.)
          // so the same event from two calendars (in different tz representations) still matches.
          // Format: "YYYY-MM-DD" for all-day, "YYYY-MM-DDTHH:MM" for timed.
          const normStart = allDay
            ? rawStart.slice(0, 10)
            : rawStart.slice(0, 16).replace('T', ' ');

          // Deduplicate strategy:
          //   1. Same UID  → definitive match (same Outlook object)
          //   2. Same title (case-insensitive) + same normalised start → invited event duplicate
          const titleKey  = (ev.summary || '').toLowerCase().trim();
          const uidKey    = uid || null;
          const titleDateKey = `${titleKey}|${normStart}`;

          if (dedupEnabled) {
            if (uidKey && seenUids.has(uidKey)) {
              console.log(`  ↩ Dedup[uid]:   "${ev.summary}"`);
              continue;
            }
            if (seenUids.has(titleDateKey)) {
              console.log(`  ↩ Dedup[title]: "${ev.summary}" at ${normStart}`);
              continue;
            }
          }
          if (uidKey) seenUids.add(uidKey);
          seenUids.add(titleDateKey);

          allEvents.push({
            id:      `ha_${cal.entity}_${rawStart}_${titleKey.slice(0, 16)}`.replace(/[^\w-]/g, '_'),
            uid,          // Outlook event_id — used for ms365_calendar modify/remove services
            title:   ev.summary     || '(no title)',
            loc:     ev.location    || '',
            desc:    ev.description || '',
            cal:     cal.entity,
            calName: cal.name,
            color:   cal.color,
            date:    rawStart.slice(0, 10),
            time:    allDay ? '' : rawStart.slice(11, 16),
            endDate: rawEnd.slice(0, 10),
            endTime: allDay ? '' : rawEnd.slice(11, 16),
            allDay,
            editable: !!uid,  // only editable if we have an event_id
          });
        }
      }

      allEvents.sort((a, b) =>
        (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00'))
      );

      console.log(`  ✓ Calendar: ${allEvents.length} events (dedup: ${dedupEnabled ? 'on' : 'OFF'}, seenUids: ${seenUids.size})`);
      sendJSON(res, 200, { calendars: getCalendars(), events: allEvents });
    } catch (e) {
      console.error('  ✗ /api/ha/calendar error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/service  POST ───────────────────────────────
  // General-purpose HA service proxy (used by controls/lights/lock/gate etc.)
  // Body: { domain, service, data }
  if (pathname === '/api/ha/service' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const { domain, service, data: svcData } = JSON.parse(raw);
      if (!domain || !service) {
        sendJSON(res, 400, { error: 'Request body must include "domain" and "service"' });
        return;
      }
      console.log(`  → HA service: ${domain}.${service}`, JSON.stringify(svcData || {}));
      const r = await haRequest('POST', `/api/services/${domain}/${service}`, svcData ?? {});
      if (r.status >= 400) {
        sendJSON(res, r.status, { error: `HA returned ${r.status}`, detail: r.body });
        return;
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('  ✗ /api/ha/service error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/todo  GET ───────────────────────────────────
  if (pathname === '/api/ha/todo' && method === 'GET') {
    try {
      const qs     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(qs);
      const entity = params.get('entity');
      if (!entity) { sendJSON(res, 400, { error: 'entity param required' }); return; }

      const r = await haRequest('POST', '/api/services/todo/get_items?return_response=true', { entity_id: entity });
      if (r.status >= 400) {
        console.error(`  ✗ todo/get_items failed: ${r.status}`);
        sendJSON(res, r.status, { error: `HA returned ${r.status}` }); return;
      }
      const items = r.body?.service_response?.[entity]?.items || r.body?.[entity]?.items || [];
      sendJSON(res, 200, { items });
    } catch (e) {
      console.error('  ✗ /api/ha/todo error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/todo  POST ──────────────────────────────────
  // Update a todo item status. Body: { entity, uid, status }
  // status: "needs_action" | "completed"
  if (pathname === '/api/ha/todo' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const { entity, uid, status } = JSON.parse(raw);
      if (!entity || !uid || !status) { sendJSON(res, 400, { error: 'entity, uid, status required' }); return; }
      const svcData = { entity_id: entity, item: uid, status };
      const r = await haRequest('POST', '/api/services/todo/update_item', svcData);
      if (r.status >= 400) { sendJSON(res, r.status, { error: `HA returned ${r.status}`, detail: r.body }); return; }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('  ✗ /api/ha/todo POST error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/calendar/create  POST ───────────────────────
  // Body: { entity_id, summary, start, end, location?, description?, all_day? }
  // start/end: "YYYY-MM-DDTHH:MM:SS" for timed, "YYYY-MM-DD" for all-day
  if (pathname === '/api/ha/calendar/create' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      const { entity_id, summary, start, end, location, description, all_day } = body;

      if (!entity_id || !summary || !start || !end) {
        sendJSON(res, 400, { error: 'entity_id, summary, start, and end are required' });
        return;
      }

      const svcData = all_day
        ? { entity_id, summary, start_date: start, end_date: end }
        : { entity_id, summary, start_date_time: start, end_date_time: end };
      if (location)    svcData.location    = location;
      if (description) svcData.description = description;

      console.log(`  → calendar.create_event on ${entity_id}: "${summary}" ${start} → ${end}`);
      console.log(`    payload: ${JSON.stringify(svcData)}`);
      const r = await haRequest('POST', '/api/services/calendar/create_event', svcData);
      if (r.status >= 400) {
        console.error(`  ✗ HA rejected create: ${r.raw || JSON.stringify(r.body)}`);
        sendJSON(res, r.status, { error: `HA returned ${r.status}`, detail: r.body });
        return;
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('  ✗ /api/ha/calendar/create error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/calendar/update  POST ───────────────────────
  // Body: { entity_id, uid, summary, start, end, location?, description?, all_day? }
  if (pathname === '/api/ha/calendar/update' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      const { entity_id, uid, summary, start, end, location, description, all_day } = body;

      if (!entity_id || !uid || !summary || !start || !end) {
        sendJSON(res, 400, { error: 'entity_id, uid, summary, start, and end are required' });
        return;
      }

      // ms365_calendar.modify_calendar_event: entity_id flat alongside service fields
      const svcData = {
        entity_id,
        event_id:   uid,
        subject:    summary,
        start:      start,
        end:        end,
        is_all_day: !!all_day,
      };
      if (location)    svcData.location = location;
      if (description) svcData.body     = description;

      console.log(`  → ms365_calendar.modify_calendar_event: event_id=${uid.slice(0,30)}… "${summary}"`);
      console.log(`    payload: ${JSON.stringify(svcData)}`);
      const r = await haRequest('POST', '/api/services/ms365_calendar/modify_calendar_event', svcData);
      if (r.status >= 400) {
        console.error(`  ✗ HA rejected modify: ${r.raw || JSON.stringify(r.body)}`);
        sendJSON(res, r.status, { error: `HA returned ${r.status}`, detail: r.body });
        return;
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('  ✗ /api/ha/calendar/update error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/ha/calendar/delete  POST ───────────────────────
  // Body: { entity_id, uid }
  // Entity services need entity_id flat in the body alongside the service fields
  if (pathname === '/api/ha/calendar/delete' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const body = JSON.parse(raw);
      const { entity_id, uid } = body;

      if (!entity_id || !uid) {
        sendJSON(res, 400, { error: 'entity_id and uid are required' });
        return;
      }

      const payload = { entity_id, event_id: uid };
      console.log(`  → ms365_calendar.remove_calendar_event: event_id=${uid.slice(0,30)}…`);
      console.log(`    payload: ${JSON.stringify(payload)}`);
      const r = await haRequest('POST', '/api/services/ms365_calendar/remove_calendar_event', payload);
      if (r.status >= 400) {
        console.error(`  ✗ HA rejected remove: ${r.raw || JSON.stringify(r.body)}`);
        sendJSON(res, r.status, { error: `HA returned ${r.status}`, detail: r.body });
        return;
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('  ✗ /api/ha/calendar/delete error:', e.message);
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // Diagnostic: tests connection → auth → album → photo proxy in sequence
  if (pathname === '/api/immich/test' && method === 'GET') {
    const { url, apiKey, album } = getImmichCfg();
    const result = { url, album_id: album, steps: [] };
    const step = (name, ok, detail) => result.steps.push({ name, ok, detail });

    if (!url)    { step('config', false, 'immichUrl not set'); sendJSON(res, 200, result); return; }
    if (!apiKey) { step('config', false, 'immichApiKey not set'); sendJSON(res, 200, result); return; }
    step('config', true, 'URL and API key are set');

    // Step 1: ping server
    try {
      const r = await immichRequest(url, apiKey, '/api/server/ping', false);
      step('ping', r.status === 200, `HTTP ${r.status}`);
      if (r.status !== 200) { sendJSON(res, 200, result); return; }
    } catch(e) { step('ping', false, e.message); sendJSON(res, 200, result); return; }

    // Step 2: validate API key (use /api/users/me — works across all Immich versions)
    try {
      const r = await immichRequest(url, apiKey, '/api/users/me', false);
      step('auth', r.status === 200, `HTTP ${r.status}${r.body?.email ? ' — ' + r.body.email : r.body?.message ? ' — ' + r.body.message : ''}`);
      if (r.status !== 200) { sendJSON(res, 200, result); return; }
    } catch(e) { step('auth', false, e.message); sendJSON(res, 200, result); return; }

    // Step 3: fetch album
    if (!album) { step('album', false, 'No album selected — pick one in Admin → Photo Frame'); sendJSON(res, 200, result); return; }
    let assetId;
    try {
      const r = await immichRequest(url, apiKey, `/api/albums/${encodeURIComponent(album)}`, false);
      const all    = r.body?.assets || [];
      const images = all.filter(a => a.type === 'IMAGE' && !a.isTrashed);
      const videos = all.filter(a => a.type === 'VIDEO' && !a.isTrashed);
      const livePhotos = images.filter(a => a.livePhotoVideoId);
      step('album', r.status === 200,
        `HTTP ${r.status} — ${all.length} total, ${images.length} images (${livePhotos.length} Live Photos), ${videos.length} videos`);
      if (r.status !== 200 || !images.length) { sendJSON(res, 200, result); return; }
      assetId = images[0].id;
    } catch(e) { step('album', false, e.message); sendJSON(res, 200, result); return; }

    // Step 4: fetch one thumbnail
    try {
      const r = await immichRequest(url, apiKey, `/api/assets/${encodeURIComponent(assetId)}/thumbnail?size=preview`, true);
      step('photo', r.status === 200, `HTTP ${r.status} — ${r.status === 200 ? r.buf.length + ' bytes, ' + r.contentType : 'failed'}`);
    } catch(e) { step('photo', false, e.message); }

    sendJSON(res, 200, result);
    return;
  }
  // Returns list of all Immich albums — used by admin to pick one
  if (pathname === '/api/immich/albums' && method === 'GET') {
    try {
      const { url, apiKey } = getImmichCfg();
      if (!url || !apiKey) { sendJSON(res, 400, { error: 'Immich URL and API key are not configured' }); return; }
      const r = await immichRequest(url, apiKey, '/api/albums', false);
      if (r.status !== 200) { sendJSON(res, r.status, { error: `Immich returned ${r.status}`, detail: r.body }); return; }
      const albums = (Array.isArray(r.body) ? r.body : []).map(a => ({
        id:    a.id,
        name:  a.albumName,
        count: a.assetCount ?? 0,
      }));
      sendJSON(res, 200, albums);
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/immich/photos  GET ─────────────────────────────
  // Returns shuffled list of asset IDs from the configured album
  // ?albumId=X overrides the stored album (for admin preview)
  if (pathname === '/api/immich/photos' && method === 'GET') {
    try {
      const { url, apiKey, album: storedAlbum } = getImmichCfg();
      if (!url || !apiKey) { sendJSON(res, 400, { error: 'Immich not configured' }); return; }
      const qIdx    = req.url.indexOf('?');
      const qs      = qIdx !== -1 ? req.url.slice(qIdx + 1) : '';
      const albumId = qs.split('&').find(p => p.startsWith('albumId='))?.split('=')[1] || storedAlbum;
      if (!albumId) { sendJSON(res, 400, { error: 'No album configured — set one in Admin → Settings → Photo Frame' }); return; }

      const r = await immichRequest(url, apiKey, `/api/albums/${encodeURIComponent(albumId)}`, false);
      if (r.status !== 200) { sendJSON(res, r.status, { error: `Immich returned ${r.status}` }); return; }

      // Include IMAGE type and Live Photos (which Immich stores as IMAGE with a livePhotoVideoId)
      // Exclude pure video assets and trashed items
      const all    = r.body.assets || [];
      const byType = all.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {});
      const assets = all
        .filter(a => a.type === 'IMAGE' && !a.isTrashed)
        .map(a => ({
          id:            a.id,
          localDateTime: a.localDateTime || a.fileCreatedAt || null,
          city:          a.exifInfo?.city       || null,
          state:         a.exifInfo?.state      || null,
          country:       a.exifInfo?.country    || null,
          make:          a.exifInfo?.make        || null,
          model:         a.exifInfo?.model       || null,
          lensModel:     a.exifInfo?.lensModel   || null,
          fNumber:       a.exifInfo?.fNumber     ?? null,
          exposureTime:  a.exifInfo?.exposureTime || null,
          iso:           a.exifInfo?.iso          ?? null,
          focalLength:   a.exifInfo?.focalLength  ?? null,
          latitude:      a.exifInfo?.latitude     ?? null,
          longitude:     a.exifInfo?.longitude    ?? null,
          description:   a.exifInfo?.description  || a.description || null,
          fileName:      a.originalFileName       || null,
        }));

      console.log(`  Photo frame: album has ${all.length} assets — ${JSON.stringify(byType)} — serving ${assets.length} images`);

      // Fisher-Yates shuffle
      for (let i = assets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [assets[i], assets[j]] = [assets[j], assets[i]];
      }

      sendJSON(res, 200, { count: assets.length, assets });
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // ── /api/immich/photo/:assetId  GET ─────────────────────
  // Proxies a full-quality image from Immich so the tablet never needs direct Immich access
  if (pathname.startsWith('/api/immich/photo/') && method === 'GET') {
    try {
      const { url, apiKey } = getImmichCfg();
      if (!url || !apiKey) { sendJSON(res, 400, { error: 'Immich not configured' }); return; }
      const assetId = pathname.slice('/api/immich/photo/'.length);
      if (!assetId) { sendJSON(res, 400, { error: 'Missing asset ID' }); return; }

      // Try full original first — best quality for a wall display
      // Falls back to 'preview' thumbnail if original returns non-200
      let r = await immichRequest(url, apiKey, `/api/assets/${encodeURIComponent(assetId)}/original`, true);
      if (r.status !== 200) {
        console.warn(`  ⚠ Photo proxy: original returned ${r.status} for ${assetId.slice(0,8)}…, trying preview`);
        r = await immichRequest(url, apiKey, `/api/assets/${encodeURIComponent(assetId)}/thumbnail?size=preview`, true);
      }
      if (r.status !== 200) {
        console.warn(`  ✗ Photo proxy: both original and preview failed (${r.status}) for asset ${assetId.slice(0,8)}…`);
        res.writeHead(r.status); res.end(); return;
      }
      const contentType = r.contentType || 'image/jpeg';
      console.log(`  ✓ Photo proxy: ${assetId.slice(0,8)}… → ${r.buf.length} bytes (${contentType})`);
      res.writeHead(200, {
        'Content-Type':   contentType,
        'Content-Length': r.buf.length,
        'Cache-Control':  'public, max-age=3600',
      });
      res.end(r.buf);
    } catch (e) {
      console.warn('  ✗ Photo proxy error:', e.message);
      res.writeHead(502); res.end();
    }
    return;
  }

  // -- /api/ha/camera/:entityId  GET ----------------------------------------
  // Proxies HA camera snapshots so the dashboard never needs direct HA access.
  if (pathname.startsWith('/api/ha/camera/') && method === 'GET') {
    try {
      const entityId = decodeURIComponent(pathname.slice('/api/ha/camera/'.length));
      if (!entityId) { res.writeHead(400); res.end(); return; }
      const snapPath = '/api/camera_proxy/' + entityId;
      const imgBuf = await new Promise((resolve, reject) => {
        let base;
        try { base = new URL(HA_URL); } catch(e) { return reject(e); }
        const isHttps = base.protocol === 'https:';
        const lib     = isHttps ? require('https') : require('http');
        const port    = base.port ? parseInt(base.port, 10) : (isHttps ? 443 : 80);
        const opts = {
          hostname: base.hostname, port,
          path: snapPath, method: 'GET',
          headers: { 'Authorization': 'Bearer ' + HA_TOKEN, 'Accept': 'image/*' },
        };
        const req2 = lib.request(opts, res2 => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve({ buf: Buffer.concat(chunks), ct: res2.headers['content-type'] || 'image/jpeg', status: res2.statusCode }));
        });
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('Camera proxy timeout')); });
        req2.on('error', reject);
        req2.end();
      });
      if (imgBuf.status !== 200) {
        console.warn('  Camera proxy: HA returned ' + imgBuf.status + ' for ' + entityId);
        res.writeHead(imgBuf.status); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': imgBuf.ct, 'Content-Length': imgBuf.buf.length, 'Cache-Control': 'no-store' });
      res.end(imgBuf.buf);
    } catch (e) {
      console.warn('  Camera proxy error:', e.message);
      res.writeHead(502); res.end();
    }
    return;
  }

  // ── Static pages ────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    sendFile(res, path.join(ROOT, 'index.html')); return;
  }
  // ── /admin/login  POST ──────────────────────────────────
  if (pathname === '/admin/login' && method === 'POST') {
    try {
      const raw  = await readBody(req);
      const { password } = JSON.parse(raw);
      // Read current password from data.json
      let stored = '';
      try { stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))?.settings?.adminPassword || ''; }
      catch { /* no password set */ }

      if (!stored || sha256(password) === stored) {
        // No password set, or correct plaintext password (hashed and compared) — issue session token
        const token = crypto.randomBytes(24).toString('hex');
        ADMIN_SESSIONS.add(token);
        // Expire after 8 hours
        setTimeout(() => ADMIN_SESSIONS.delete(token), 8 * 60 * 60 * 1000);
        sendJSON(res, 200, { ok: true, token });
      } else {
        sendJSON(res, 401, { error: 'Incorrect password' });
      }
    } catch (e) {
      sendJSON(res, 400, { error: e.message });
    }
    return;
  }

  // ── /admin  GET ─────────────────────────────────────────
  if (pathname === '/admin' || pathname === '/admin.html') {
    // Check if password is set
    let stored = '';
    try { stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))?.settings?.adminPassword || ''; }
    catch { /* default no password */ }

    if (stored) {
      // Check for valid session cookie
      const cookie = req.headers.cookie || '';
      const match  = cookie.match(/fp_admin=([a-f0-9]+)/);
      const token  = match?.[1] || '';
      if (!ADMIN_SESSIONS.has(token)) {
        // Serve login page — theme colours read live from data.json
        const ld = getLiveData();
        const ls = ld.settings || {};
        const lMode = ls.themeMode || 'dark';
        const lPresetKey = lMode === 'light'
          ? (ls.lightTheme || 'light-cloud')
          : (ls.darkTheme  || 'dark-obsidian');
        const LOGIN_PRESETS = {
          'dark-obsidian': { bg:'#0e0d0c', surface:'#161512', surface2:'#1d1b18', border2:'rgba(255,255,255,0.14)', accent:'#e8a840', text:'#f0ece4', muted:'rgba(240,236,228,0.45)', faint:'rgba(240,236,228,0.20)', err:'#ef4444', btnText:'#0f0f0e' },
          'dark-midnight': { bg:'#0d1117', surface:'#161b22', surface2:'#1c2128', border2:'rgba(255,255,255,0.14)', accent:'#58a6ff', text:'#e6edf3', muted:'rgba(230,237,243,0.45)', faint:'rgba(230,237,243,0.20)', err:'#f85149', btnText:'#0d1117' },
          'dark-forest':   { bg:'#0d1a12', surface:'#122019', surface2:'#182b21', border2:'rgba(255,255,255,0.14)', accent:'#4ade80', text:'#e8f5ec', muted:'rgba(232,245,236,0.45)', faint:'rgba(232,245,236,0.20)', err:'#f87171', btnText:'#0d1a12' },
          'dark-slate':    { bg:'#0f1117', surface:'#181c25', surface2:'#1e2432', border2:'rgba(255,255,255,0.14)', accent:'#a78bfa', text:'#e2e8f0', muted:'rgba(226,232,240,0.45)', faint:'rgba(226,232,240,0.20)', err:'#f87171', btnText:'#0f1117' },
          'dark-rose':     { bg:'#120d0f', surface:'#1a1215', surface2:'#211620', border2:'rgba(255,255,255,0.14)', accent:'#fb7185', text:'#fce7f3', muted:'rgba(252,231,243,0.45)', faint:'rgba(252,231,243,0.20)', err:'#fb7185', btnText:'#120d0f' },
          'light-cloud':   { bg:'#f0f2f5', surface:'#ffffff', surface2:'#e8eaed', border2:'rgba(0,0,0,0.15)',      accent:'#c8780a', text:'#1a1815', muted:'rgba(26,24,21,0.50)',    faint:'rgba(26,24,21,0.28)',    err:'#c0392b', btnText:'#ffffff' },
          'light-ocean':   { bg:'#eff6ff', surface:'#ffffff', surface2:'#dbeafe', border2:'rgba(0,0,0,0.15)',      accent:'#1d4ed8', text:'#1e3a5f', muted:'rgba(30,58,95,0.50)',    faint:'rgba(30,58,95,0.28)',    err:'#be123c', btnText:'#ffffff' },
          'light-mint':    { bg:'#f0faf4', surface:'#ffffff', surface2:'#e6f4ec', border2:'rgba(0,0,0,0.15)',      accent:'#16a34a', text:'#0f2419', muted:'rgba(15,36,25,0.50)',    faint:'rgba(15,36,25,0.28)',    err:'#dc2626', btnText:'#ffffff' },
          'light-slate':   { bg:'#f1f5f9', surface:'#ffffff', surface2:'#e2e8f0', border2:'rgba(0,0,0,0.15)',      accent:'#6d28d9', text:'#1e293b', muted:'rgba(30,41,59,0.50)',    faint:'rgba(30,41,59,0.28)',    err:'#be123c', btnText:'#ffffff' },
          'light-rose':    { bg:'#fff1f4', surface:'#ffffff', surface2:'#fde8ec', border2:'rgba(0,0,0,0.15)',      accent:'#e11d48', text:'#1f0a10', muted:'rgba(31,10,16,0.50)',    faint:'rgba(31,10,16,0.28)',    err:'#e11d48', btnText:'#ffffff' },
        };
        const lt = LOGIN_PRESETS[lPresetKey] || LOGIN_PRESETS['dark-obsidian'];
        const lShadow = lMode === 'light' ? '0 4px 24px rgba(0,0,0,0.10)' : '0 8px 40px rgba(0,0,0,0.4)';
        // Derive focus ring from accent
        const lAccentHex = lt.accent.replace('#','');
        const lAR = parseInt(lAccentHex.slice(0,2),16), lAG = parseInt(lAccentHex.slice(2,4),16), lAB = parseInt(lAccentHex.slice(4,6),16);
        const lFocusBorder = `rgba(${lAR},${lAG},${lAB},0.5)`;
        let lVersion = '';
        try { lVersion = JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version || ''; } catch {}

        const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Family Panel — Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;600;700;800&family=DM+Sans:opsz,wght@9..40,300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:${lt.bg};font-family:'DM Sans',system-ui,sans-serif;color:${lt.text};}
.card{background:${lt.surface};border:1px solid ${lt.border2};border-radius:16px;
  padding:40px 36px 36px;width:340px;box-shadow:${lShadow};}
.logo{font-family:'Nunito',ui-sans-serif,sans-serif;font-size:24px;font-weight:700;
  color:${lt.text};margin-bottom:4px;display:flex;align-items:center;gap:10px;}
.logo img{width:36px;height:36px;border-radius:8px;flex-shrink:0;}
.logo span{color:${lt.accent};}
.sub{font-size:12px;color:${lt.muted};margin-bottom:28px;}
.ver{font-size:10px;color:${lt.faint};margin-top:-22px;margin-bottom:28px;}
label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;
  color:${lt.muted};display:block;margin-bottom:6px;}
input{width:100%;padding:10px 13px;background:${lt.surface2};border:1px solid ${lt.border2};
  border-radius:8px;font-size:13px;font-family:inherit;color:${lt.text};outline:none;
  transition:border-color .15s;}
input::placeholder{color:${lt.faint};}
input:focus{border-color:${lFocusBorder};}
button{width:100%;margin-top:14px;padding:11px;background:${lt.accent};border:none;
  border-radius:8px;color:${lt.btnText};font-size:13px;font-weight:700;font-family:inherit;
  cursor:pointer;transition:opacity .15s;letter-spacing:.2px;}
button:hover{opacity:.88;}
#err{font-size:11px;color:${lt.err};margin-top:10px;min-height:16px;text-align:center;}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><img src="/favicon-32x32.png" alt="Family Panel icon"> Family<span>Panel</span></div>
  <div class="sub">Admin access is password protected.</div>
  ${lVersion ? `<div class="ver">v${lVersion}</div>` : ''}
  <form onsubmit="login();return false;">
    <label>Password</label>
    <input type="password" id="pw" placeholder="Enter admin password" autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
    <div id="err"></div>
  </form>
</div>
<script>
async function login() {
  const pw = document.getElementById('pw').value;
  const r  = await fetch('/admin/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: pw}) });
  const d  = await r.json();
  if (d.ok) {
    document.cookie = 'fp_admin=' + d.token + '; path=/; max-age=28800; SameSite=Strict';
    location.href = '/admin';
  } else {
    document.getElementById('err').textContent = d.error || 'Incorrect password';
    document.getElementById('pw').value = '';
    document.getElementById('pw').focus();
  }
}
<\/script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginHtml);
        return;
      }
    }
    sendFile(res, path.join(ROOT, 'admin.html')); return;
  }

  if (pathname === '/favicon.ico')        { sendFile(res, path.join(ROOT, 'favicon.ico'));        return; }
  if (pathname === '/favicon-32x32.png')  { sendFile(res, path.join(ROOT, 'docs/favicon-32x32.png'));  return; }
  if (pathname === '/favicon-16x16.png')  { sendFile(res, path.join(ROOT, 'docs/favicon-16x16.png'));  return; }
  if (pathname === '/apple-touch-icon.png') { sendFile(res, path.join(ROOT, 'docs/apple-touch-icon.png')); return; }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`404 Not Found: ${pathname}`);
});

// ─────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const tokenSet = HA_TOKEN_SET;
  const urlSet   = HA_URL.length > 0;
  console.log('');
  console.log('  🏠 Family Panel — HA Edition');
  console.log(`     Dashboard  : http://localhost:${PORT}/`);
  console.log(`     Admin      : http://localhost:${PORT}/admin`);
  console.log(`     HA URL     : ${urlSet ? HA_URL : '✗ NOT SET'}`);
  console.log(`     HA token   : ${tokenSet ? `✓ set (${HA_TOKEN.length} chars)` : '✗ NOT SET'}`);
  console.log(`     Config     : ${CONFIG_FILE}`);
  console.log(`     Diagnostic : http://localhost:${PORT}/api/ha/test`);
  console.log('');
  if (!urlSet || !tokenSet) {
    console.log('  ★ HA not configured. Set FP_HA_URL and FP_HA_TOKEN env vars,');
    console.log('    or edit config.json and set "ha_url" and "ha_token".');
    console.log('');
  }
});

// ─────────────────────────────────────────────────────────
//  CHORE RESET SCHEDULER
//  Runs every minute. Resets chores based on their recur
//  type and resetTimes (multi-daily), days (weekly), and
//  weekOfMonth (monthly) fields.
// ─────────────────────────────────────────────────────────
async function choreResetTick() {
  let data;
  try { data = getLiveData(); } catch { return; }
  if (!Array.isArray(data.chores) || !data.chores.length) return;

  const now       = new Date();
  const todayDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const todayDow  = now.getDay();          // 0=Sun … 6=Sat
  const todayHM   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const weekOfMonth = Math.ceil(now.getDate() / 7); // 1-5

  let changed = false;
  const toNotify = []; // chores to send "now active" notifications for

  data.chores = data.chores.map(ch => {
    if (!ch.done) return ch;   // already open — nothing to reset
    const doneDate = ch.doneDate || '';
    const doneTs   = ch.doneDatetime || '';  // "YYYY-MM-DD HH:MM" for multi-daily

    let reset = false;

    if (ch.recur === 'daily') {
      const times = (ch.resetTimes && ch.resetTimes.length) ? ch.resetTimes : ['00:00'];
      if (doneDate < todayDate) {
        reset = true;
      } else if (doneDate === todayDate) {
        const lastResetTime = ch.lastResetTime || '00:00';
        const pendingReset = times.find(t => t > lastResetTime && t <= todayHM);
        if (pendingReset) reset = true;
      }
    }

    if (ch.recur === 'weekly') {
      const allowedDays = (ch.days && ch.days.length) ? ch.days : [0,1,2,3,4,5,6];
      if (allowedDays.includes(todayDow) && doneDate < todayDate) reset = true;
      if (doneDate < todayDate) {
        const dd = new Date(doneDate + 'T12:00:00');
        if ((now - dd) / 86400000 >= 7) reset = true;
      }
    }

    if (ch.recur === 'monthly') {
      const allowedWeeks  = (ch.weekOfMonth && ch.weekOfMonth.length) ? ch.weekOfMonth : [1,2,3,4,5];
      const allowedMonths = (ch.months && ch.months.length) ? ch.months : null;
      if (allowedMonths && !allowedMonths.includes(now.getMonth() + 1)) return ch;
      const dd = new Date((doneDate || '2000-01-01') + 'T12:00:00');
      if (dd.getMonth() !== now.getMonth() || dd.getFullYear() !== now.getFullYear()) reset = true;
      if (!reset && allowedWeeks.includes(weekOfMonth)) {
        const doneWeek = Math.ceil(dd.getDate() / 7);
        if (doneWeek !== weekOfMonth) reset = true;
      }
    }

    if (ch.recur === 'yearly') {
      const allowedMonths = (ch.months && ch.months.length) ? ch.months : null;
      if (allowedMonths && !allowedMonths.includes(now.getMonth() + 1)) return ch;
      const dd = new Date((doneDate || '2000-01-01') + 'T12:00:00');
      if (dd.getFullYear() !== now.getFullYear()) reset = true;
    }

    if (ch.recur === 'once') return ch;

    if (reset) {
      changed = true;
      console.log(`  ↺ chore reset: "${ch.label}" (${ch.recur})`);
      if (ch.notifyAssign) toNotify.push(ch);
      return { ...ch, done: false, doneDate: null, doneDatetime: null, lastResetTime: reset ? todayHM : (ch.lastResetTime || '00:00') };
    }
    return ch;
  });

  if (changed) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('  ✗ chore reset write failed:', e.message);
    }

    // Fire "now active" push notifications
    if (toNotify.length) {
      const users = data.users || [];
      for (const ch of toNotify) {
        const user = users.find(u => u.id === ch.userId);
        if (!user?.notifyEntity) continue;
        const svc = user.notifyEntity.replace(/^notify\./, '');
        try {
          await haRequest('POST', `/api/services/notify/${svc}`, {
            title: '📋 Chore reminder',
            message: `${user.name}: ${ch.label}`,
          });
          console.log(`  🔔 notified ${user.name} → ${svc}: "${ch.label}"`);
        } catch (e) {
          console.error(`  ✗ notify failed for ${svc}:`, e.message);
        }
      }
    }
  }
}

// Run immediately on start, then every 60 seconds
choreResetTick();
setInterval(choreResetTick, 60_000);

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`    Try: node server.js --port 3001\n`);
  } else {
    console.error('  ✗ Server error:', err.message);
  }
  process.exit(1);
});

// Catch unhandled promise rejections so they appear clearly in the log
process.on('unhandledRejection', (reason) => {
  console.error('  ✗ Unhandled rejection:', reason);
});
