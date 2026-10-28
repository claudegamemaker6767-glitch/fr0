'use strict';

/*
 * The Treehouse: a small private chat server.
 *  - Friends open the site, type the access code and a name, and chat. No accounts.
 *  - The access code is checked here on the server (set ACCESS_CODE as an environment variable).
 *  - Messages are kept in memory and saved to a file so a restart keeps recent history
 *    (on free hosts the file may be wiped when the app redeploys).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'chat.json');

if (!ACCESS_CODE) {
  console.error('\nNo access code set. Set the ACCESS_CODE environment variable, for example:');
  console.error('  ACCESS_CODE=maple-42 npm start\n');
  process.exit(1);
}

const MAX_HISTORY = 200;   // messages kept per room
const MAX_ROOMS = 30;
const MAX_TEXT = 1000;
const MAX_NAME = 24;

const DEFAULT_ROOMS = [
  { id: 'lobby', name: 'lobby', topic: 'Say hi, catch up, plan things', hue: 160 },
  { id: 'arcade', name: 'arcade', topic: 'Game nights, clips and trash talk', hue: 275 },
  { id: 'jukebox', name: 'jukebox', topic: 'What are you listening to right now?', hue: 340 },
  { id: 'meme-wall', name: 'meme-wall', topic: 'Pictures, links and nonsense', hue: 42 },
  { id: 'late-night', name: 'late-night', topic: 'For the people still up', hue: 220 },
  { id: 'plans', name: 'plans', topic: 'Who is free, where, and when', hue: 100 }
];

/* ---------- state + saving ---------- */
let rooms = DEFAULT_ROOMS.map((r) => Object.assign({ custom: false }, r));
let history = {};
rooms.forEach((r) => { history[r.id] = []; });

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (saved && Array.isArray(saved.rooms)) {
    saved.rooms.forEach((r) => {
      if (r && typeof r.id === 'string' && typeof r.name === 'string' && !rooms.some((x) => x.id === r.id) && rooms.length < MAX_ROOMS) {
        rooms.push({ id: r.id, name: r.name.slice(0, MAX_NAME), topic: String(r.topic || '').slice(0, 80), hue: hash(r.id) % 360, custom: true });
        history[r.id] = [];
      }
    });
  }
  if (saved && saved.history && typeof saved.history === 'object') {
    rooms.forEach((r) => {
      const list = saved.history[r.id];
      if (Array.isArray(list)) {
        history[r.id] = list
          .filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.ts === 'number')
          .slice(-MAX_HISTORY);
      }
    });
  }
  console.log('Loaded saved chat history.');
} catch (e) { /* first run, nothing saved yet */ }

let saveTimer = null;
function saveNow() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ rooms: rooms.filter((r) => r.custom), history }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Could not save chat history:', e.message); }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 2000);
}

/* ---------- access code ---------- */
const norm = (s) => String(s || '').trim().toLowerCase();
const codeHash = crypto.createHash('sha256').update(norm(ACCESS_CODE)).digest();
function codeOk(input) {
  const h = crypto.createHash('sha256').update(norm(input)).digest();
  return crypto.timingSafeEqual(h, codeHash);
}

// Slow down people guessing the code: 6 wrong tries per 10 minutes per address.
const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 6;
const fails = new Map();
function ipOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function isBlocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { fails.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
function noteFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}
setInterval(() => {
  const now = Date.now();
  fails.forEach((f, ip) => { if (now - f.first > WINDOW_MS) fails.delete(ip); });
}, WINDOW_MS).unref();

/* ---------- cleaning input ---------- */
function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME); }
function cleanText(v) {
  return String(v || '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}
function slugify(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); }

/* ---------- web server (serves the three page files) ---------- */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8']
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-cache'
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const f = FILES[url];
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(__dirname, f[0]), (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server error'); }
    res.writeHead(200, Object.assign({ 'Content-Type': f[1] }, SECURITY_HEADERS));
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

/* ---------- live chat ---------- */
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1 && c.user) c.send(s); });
}
function broadcastPresence() {
  const names = [];
  wss.clients.forEach((c) => { if (c.readyState === 1 && c.user && !names.includes(c.user.name)) names.push(c.user.name); });
  broadcast({ type: 'presence', names: names.slice(0, 50), count: names.length });
}
function allow(ws, cost) {
  const now = Date.now();
  ws.tokens = Math.min(8, ws.tokens + ((now - ws.last) / 1000) * 1.2);
  ws.last = now;
  if (ws.tokens < cost) return false;
  ws.tokens -= cost;
  return true;
}

wss.on('connection', (ws, req) => {
  ws.ip = ipOf(req);
  ws.user = null;
  ws.isAlive = true;
  ws.tokens = 8;
  ws.last = Date.now();
  // Hang up on anyone who connects and never joins.
  const joinTimer = setTimeout(() => { if (!ws.user) ws.close(); }, 20000);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { clearTimeout(joinTimer); if (ws.user) broadcastPresence(); });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let d;
    try { d = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!d || typeof d.type !== 'string') return;

    if (d.type === 'join') {
      if (ws.user) return;
      if (isBlocked(ws.ip)) { send(ws, { type: 'error', reason: 'rate' }); return ws.close(); }
      if (!codeOk(d.code)) {
        noteFail(ws.ip);
        send(ws, { type: 'error', reason: 'bad_code' });
        return ws.close();
      }
      const name = cleanName(d.name);
      if (!name) { send(ws, { type: 'error', reason: 'bad_name' }); return; }
      fails.delete(ws.ip);
      const sid = typeof d.sid === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(d.sid) ? d.sid : 's' + crypto.randomBytes(8).toString('hex');
      ws.user = { sid, name };
      send(ws, { type: 'ready', you: { sid, name }, rooms, history });
      broadcastPresence();
      return;
    }

    if (!ws.user) return;

    if (d.type === 'msg') {
      if (!history[d.room]) return;
      const text = cleanText(d.text);
      if (!text) return;
      if (!allow(ws, 1)) { send(ws, { type: 'error', reason: 'slow' }); return; }
      const msg = { id: crypto.randomBytes(8).toString('hex'), uid: ws.user.sid, name: ws.user.name, text, ts: Date.now() };
      const list = history[d.room];
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      broadcast({ type: 'msg', room: d.room, msg });
      scheduleSave();
      return;
    }

    if (d.type === 'del') {
      const list = history[d.room];
      if (!list) return;
      const i = list.findIndex((m) => m.id === d.id && m.uid === ws.user.sid);
      if (i === -1) return;
      list.splice(i, 1);
      broadcast({ type: 'del', room: d.room, id: d.id });
      scheduleSave();
      return;
    }

    if (d.type === 'rename') {
      const name = cleanName(d.name);
      if (!name) return;
      ws.user.name = name;
      broadcastPresence();
      return;
    }

    if (d.type === 'newroom') {
      const id = slugify(d.name);
      if (!id || rooms.some((r) => r.id === id)) return;
      if (rooms.length >= MAX_ROOMS) { send(ws, { type: 'error', reason: 'room_limit' }); return; }
      if (!allow(ws, 3)) { send(ws, { type: 'error', reason: 'slow' }); return; }
      const room = { id, name: id, topic: String(d.topic || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80), hue: hash(id) % 360, custom: true };
      rooms.push(room);
      history[id] = [];
      broadcast({ type: 'room', room });
      scheduleSave();
    }
  });
});

// Keep connections alive (also stops hosts from dropping idle sockets) and clear out dead ones.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000).unref();

server.listen(PORT, '0.0.0.0', () => console.log('The Treehouse is open on port ' + PORT));

function shutdown() { saveNow(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
