// Bel Sekolah Otomatis - server tanpa dependency (cukup Node.js)
// Jalankan lewat run.js (auto-update) atau langsung: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 8080;
const VERSION = process.env.APP_VERSION || 'lokal';
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const SOUNDS = path.join(ROOT, 'sounds');
const PUB = path.join(ROOT, 'public');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SOUNDS, { recursive: true });

// Isi suara contoh saat pertama kali dipasang
const DEF = path.join(ROOT, 'default-sounds');
if (fs.existsSync(DEF) && fs.readdirSync(SOUNDS).length === 0) {
  for (const f of fs.readdirSync(DEF)) fs.copyFileSync(path.join(DEF, f), path.join(SOUNDS, f));
}

// ---------- Database sederhana (JSON) ----------
const DB_FILE = path.join(DATA, 'db.json');
let db = { holiday: false, schedules: [], rev: 1, users: [], sessions: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) {}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Akun ----------
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function makeUser({ username, name, role, password }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: crypto.randomBytes(6).toString('hex'), username, name: name || username, role, salt, hash: hashPw(password, salt), created: Date.now() };
}
function checkPw(u, pw) {
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });

// Migrasi dari versi lama (PIN tunggal) → akun "admin" dengan password = PIN lama
if (!db.users.length) {
  const pw = db.pin || 'admin1234';
  db.users.push(makeUser({ username: 'admin', name: 'Administrator', role: 'admin', password: pw }));
  console.log(`Akun awal dibuat → username: admin  password: ${db.pin ? '(PIN lama Anda)' : 'admin1234'}`);
}
delete db.pin; delete db.secret;
save();

const SESSION_DAYS = 30;
function createSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return token;
}
function getUser(req) {
  const t = req.headers['x-token'];
  const s = t && db.sessions[t];
  if (!s || s.exp < Date.now()) return null;
  return db.users.find((u) => u.id === s.uid) || null;
}
function dropSessions(uid, keep) {
  for (const [t, s] of Object.entries(db.sessions)) if (s.uid === uid && t !== keep) delete db.sessions[t];
}
// bersihkan sesi kedaluwarsa tiap jam
setInterval(() => { let c = false; for (const [t, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) { delete db.sessions[t]; c = true; } if (c) save(); }, 36e5);

// Batas percobaan login: 8 gagal dalam 15 menit → blokir 15 menit
const fails = new Map();
const clientIp = (req) => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress).trim();
function blocked(ip) { const f = fails.get(ip); return f && f.n >= 8 && Date.now() - f.t < 15 * 60e3; }
function addFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 15 * 60e3) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; }

// ---------- Log ----------
const logs = [];
function log(msg) {
  const t = new Date();
  logs.unshift({ t: t.toISOString(), m: msg });
  if (logs.length > 80) logs.length = 80;
  console.log(`[${t.toLocaleString('id-ID')}] ${msg}`);
}

// ---------- Player (komputer speaker) via Server-Sent Events ----------
const players = new Set();
function broadcast(obj) {
  const s = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of players) res.write(s);
}
const AUDIO_EXT = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
const safeName = (n) => {
  n = path.basename(String(n || '')).replace(/[^\w\-. ()]/g, '_');
  return AUDIO_EXT[path.extname(n).toLowerCase()] ? n : null;
};
const listSounds = () => fs.readdirSync(SOUNDS).filter((f) => safeName(f) === f).sort();

function playSound(file, reason) {
  if (!file || !fs.existsSync(path.join(SOUNDS, file))) { log(`GAGAL: file "${file}" tidak ditemukan (${reason})`); return false; }
  broadcast({ type: 'play', file, reason });
  log(`Bunyi: ${reason} → ${file}` + (players.size ? '' : ' (PERINGATAN: tidak ada speaker terhubung!)'));
  return true;
}

// ---------- Penjadwal ----------
const pad = (n) => String(n).padStart(2, '0');
const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function upcoming(limit = 8) {
  if (db.holiday) return [];
  const now = new Date(), out = [];
  for (let d = 0; d < 8 && out.length < limit; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    db.schedules
      .filter((s) => s.enabled && s.days.includes(day.getDay()))
      .map((s) => { const [h, m] = s.time.split(':').map(Number); return { s, at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m) }; })
      .filter((x) => x.at > now)
      .sort((a, b) => a.at - b.at)
      .forEach(({ s, at }) => out.length < limit && out.push({ label: s.label, time: s.time, day: DAYS[at.getDay()], today: d === 0, at: at.getTime(), sound: s.sound }));
  }
  return out;
}
const nextBell = () => upcoming(1)[0] || null;
const tickMsg = () => ({ type: 'tick', next: nextBell(), upcoming: upcoming(8), holiday: db.holiday, serverTime: Date.now() });

let lastMinute = '';
setInterval(() => {
  const n = new Date();
  const hm = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  const key = n.toDateString() + hm;
  if (key === lastMinute) return;
  lastMinute = key;
  if (!db.holiday) {
    for (const s of db.schedules) if (s.enabled && s.time === hm && s.days.includes(n.getDay())) playSound(s.sound, s.label || 'Jadwal');
  }
  setTimeout(() => broadcast(tickMsg()), 1500); // segarkan daftar bel di player tiap menit
}, 1000);
setInterval(() => broadcast({ type: 'ping' }), 20000); // jaga koneksi tetap hidup

// ---------- Helper HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', ...AUDIO_EXT };
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('File terlalu besar (maks 40MB)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJSON = async (req) => { try { return JSON.parse((await readBody(req, 1e6)).toString() || '{}'); } catch { return {}; } };

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range && AUDIO_EXT[path.extname(file).toLowerCase()]) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = parseInt(a, 10) || 0, end = b ? Math.min(parseInt(b, 10), st.size - 1) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function validSchedules(list) {
  if (!Array.isArray(list)) return null;
  return list.map((s) => ({
    id: String(s.id || crypto.randomBytes(4).toString('hex')),
    time: /^\d{2}:\d{2}$/.test(s.time) ? s.time : '07:00',
    label: String(s.label || '').slice(0, 60),
    sound: safeName(s.sound) || '',
    days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [1, 2, 3, 4, 5],
    enabled: s.enabled !== false,
  })).sort((a, b) => a.time.localeCompare(b.time));
}
const validUsername = (u) => /^[a-z0-9._-]{3,30}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 6 && p.length <= 100;

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Halaman
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(req, res, path.join(PUB, 'index.html'));
    if (req.method === 'GET' && p === '/player') return serveFile(req, res, path.join(PUB, 'player.html'));
    if (req.method === 'GET' && p.startsWith('/sounds/')) {
      const f = safeName(decodeURIComponent(p.slice(8)));
      return f ? serveFile(req, res, path.join(SOUNDS, f)) : send(res, 404, 'Not found', 'text/plain');
    }

    // Koneksi player (komputer speaker)
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify(tickMsg())}\n\n`);
      players.add(res);
      log(`Speaker terhubung (${players.size} aktif)`);
      req.on('close', () => { players.delete(res); log(`Speaker terputus (${players.size} aktif)`); });
      return;
    }

    // Login
    if (req.method === 'POST' && p === '/api/login') {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { error: 'Terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.' });
      const { username, password } = await readJSON(req);
      const u = db.users.find((x) => x.username === String(username || '').trim().toLowerCase());
      if (!u || !checkPw(u, password)) { addFail(ip); log(`Login gagal: "${String(username || '').slice(0, 30)}" dari ${ip}`); return send(res, 401, { error: 'Username atau password salah' }); }
      fails.delete(ip);
      log(`${u.name} login`);
      return send(res, 200, { token: createSession(u), user: publicUser(u) });
    }

    if (p.startsWith('/api/')) {
      const me = getUser(req);
      if (!me) return send(res, 401, { error: 'Belum login' });
      const isAdmin = me.role === 'admin';
      const adminOnly = () => send(res, 403, { error: 'Hanya admin yang boleh melakukan ini' });

      if (req.method === 'POST' && p === '/api/logout') {
        delete db.sessions[req.headers['x-token']]; save();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, {
          me: publicUser(me), version: VERSION, serverTime: Date.now(), holiday: db.holiday,
          schedules: db.schedules, rev: db.rev, sounds: listSounds(), players: players.size,
          next: nextBell(), logs, users: isAdmin ? db.users.map(publicUser) : undefined,
        });
      }

      // --- semua pengguna ---
      if (req.method === 'POST' && p === '/api/play') {
        const { file } = await readJSON(req);
        const ok = playSound(safeName(file), `Manual oleh ${me.name}`);
        return send(res, ok ? 200 : 404, { ok });
      }
      if (req.method === 'POST' && p === '/api/stop') {
        broadcast({ type: 'stop' }); log(`Suara dihentikan oleh ${me.name}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/password') {
        const { oldPassword, newPassword } = await readJSON(req);
        if (!checkPw(me, oldPassword)) return send(res, 400, { error: 'Password lama salah' });
        if (!validPassword(newPassword)) return send(res, 400, { error: 'Password baru minimal 6 karakter' });
        me.salt = crypto.randomBytes(16).toString('hex'); me.hash = hashPw(newPassword, me.salt);
        dropSessions(me.id, req.headers['x-token']); save();
        log(`${me.name} mengganti password`);
        return send(res, 200, { ok: true });
      }

      // --- khusus admin ---
      if (!isAdmin) return adminOnly();

      if (req.method === 'POST' && p === '/api/schedules') {
        const body = await readJSON(req);
        if (body.rev !== undefined && body.rev !== db.rev) return send(res, 409, { error: 'Jadwal sudah diubah oleh admin lain. Muat ulang dulu agar perubahan mereka tidak tertimpa.' });
        const list = validSchedules(body.schedules);
        if (!list) return send(res, 400, { error: 'Data tidak valid' });
        db.schedules = list; db.rev++; save();
        log(`Jadwal diubah oleh ${me.name} (${list.length} jadwal)`);
        broadcast(tickMsg());
        return send(res, 200, { ok: true, schedules: list, rev: db.rev });
      }
      if (req.method === 'PUT' && p === '/api/sounds') {
        const name = safeName(url.searchParams.get('name'));
        if (!name) return send(res, 400, { error: 'Hanya file mp3 / wav / ogg / m4a' });
        const buf = await readBody(req);
        fs.writeFileSync(path.join(SOUNDS, name), buf);
        log(`Suara diunggah oleh ${me.name}: ${name} (${Math.round(buf.length / 1024)} KB)`);
        return send(res, 200, { ok: true, name });
      }
      if (req.method === 'DELETE' && p === '/api/sounds') {
        const name = safeName(url.searchParams.get('name'));
        if (name && fs.existsSync(path.join(SOUNDS, name))) { fs.unlinkSync(path.join(SOUNDS, name)); log(`Suara dihapus oleh ${me.name}: ${name}`); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/holiday') {
        db.holiday = !!(await readJSON(req)).on; save();
        log(db.holiday ? `Mode LIBUR diaktifkan oleh ${me.name}` : `Mode libur dimatikan oleh ${me.name}`);
        broadcast(tickMsg());
        return send(res, 200, { ok: true });
      }

      // Kelola akun
      if (req.method === 'POST' && p === '/api/users') {
        const b = await readJSON(req);
        const username = String(b.username || '').trim().toLowerCase();
        if (!validUsername(username)) return send(res, 400, { error: 'Username 3–30 karakter: huruf kecil, angka, titik, minus, garis bawah' });
        if (db.users.some((u) => u.username === username)) return send(res, 400, { error: 'Username sudah dipakai' });
        if (!validPassword(b.password)) return send(res, 400, { error: 'Password minimal 6 karakter' });
        const role = b.role === 'admin' ? 'admin' : 'operator';
        const u = makeUser({ username, name: String(b.name || username).slice(0, 40), role, password: b.password });
        db.users.push(u); save();
        log(`${me.name} menambah akun ${u.name} (${role})`);
        return send(res, 200, { ok: true, user: publicUser(u) });
      }
      if (req.method === 'POST' && p === '/api/users/update') {
        const b = await readJSON(req);
        const u = db.users.find((x) => x.id === b.id);
        if (!u) return send(res, 404, { error: 'Akun tidak ditemukan' });
        if (b.role && b.role !== u.role) {
          if (u.role === 'admin' && db.users.filter((x) => x.role === 'admin').length <= 1) return send(res, 400, { error: 'Harus ada minimal satu admin' });
          u.role = b.role === 'admin' ? 'admin' : 'operator';
        }
        if (b.name) u.name = String(b.name).slice(0, 40);
        if (b.password) {
          if (!validPassword(b.password)) return send(res, 400, { error: 'Password minimal 6 karakter' });
          u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(b.password, u.salt);
          dropSessions(u.id, req.headers['x-token']);
        }
        save(); log(`${me.name} mengubah akun ${u.name}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/users/delete') {
        const { id } = await readJSON(req);
        const u = db.users.find((x) => x.id === id);
        if (!u) return send(res, 404, { error: 'Akun tidak ditemukan' });
        if (u.id === me.id) return send(res, 400, { error: 'Tidak bisa menghapus akun sendiri' });
        if (u.role === 'admin' && db.users.filter((x) => x.role === 'admin').length <= 1) return send(res, 400, { error: 'Harus ada minimal satu admin' });
        db.users = db.users.filter((x) => x.id !== id); dropSessions(id); save();
        log(`${me.name} menghapus akun ${u.name}`);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n=========== BEL SEKOLAH OTOMATIS ===========');
  console.log(` Versi: ${VERSION}`);
  console.log(` Speaker : http://localhost:${PORT}/player`);
  console.log(` Panel   : http://localhost:${PORT}/`);
  ips.forEach((ip) => console.log(` Panel (jaringan): http://${ip}:${PORT}/`));
  console.log('============================================\n');
});
