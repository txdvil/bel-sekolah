// Launcher: menjalankan server.js dan mengecek update dari GitHub tiap 1 menit.
// Jika ada versi baru: ambil kode terbaru, cek tidak ada error, lalu restart server otomatis.
// Folder data/ dan sounds/ tidak pernah disentuh oleh update.
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const CHECK_EVERY = 60 * 1000;
let child = null, restarting = false;

const ts = () => new Date().toLocaleString('id-ID');
const git = (args) => new Promise((resolve) =>
  execFile('git', args, { cwd: DIR, timeout: 60000 }, (e, out, err) => resolve({ ok: !e, out: String(out || '').trim(), err: String(err || e || '').trim() })));
const syntaxOk = () => new Promise((resolve) =>
  execFile(process.execPath, ['--check', path.join(DIR, 'server.js')], (e, o, err) => resolve(e ? String(err) : null)));

async function version() {
  const r = await git(['log', '-1', '--format=%h %cd', '--date=format:%d-%m-%Y %H:%M']);
  return r.ok ? r.out : 'lokal';
}

async function start() {
  const env = { ...process.env, APP_VERSION: await version() };
  child = spawn(process.execPath, [path.join(DIR, 'server.js')], { cwd: DIR, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    child = null;
    if (!restarting) console.log(`[${ts()}] Server berhenti (kode ${code}), menyalakan ulang dalam 3 detik...`);
    restarting = false;
    setTimeout(start, 3000);
  });
}

let gitWarned = false, badCommit = null;
async function checkUpdate() {
  if (!fs.existsSync(path.join(DIR, '.git'))) {
    if (!gitWarned) { console.log(`[${ts()}] Auto-update nonaktif: folder ini belum terhubung ke GitHub.`); gitWarned = true; }
    return;
  }
  const f = await git(['fetch', '--quiet', 'origin']);
  if (!f.ok) { console.log(`[${ts()}] Gagal cek update: ${f.err.split('\n')[0]}`); return; }
  const local = (await git(['rev-parse', 'HEAD'])).out;
  const remote = (await git(['rev-parse', '@{u}'])).out;
  if (!remote || local === remote || remote === badCommit) return;

  const runBefore = fs.readFileSync(__filename, 'utf8');
  const r = await git(['reset', '--hard', '@{u}']);
  if (!r.ok) { console.log(`[${ts()}] Gagal menerapkan update: ${r.err}`); return; }

  const err = await syntaxOk();
  if (err) {
    console.log(`[${ts()}] Update ${remote.slice(0, 7)} berisi error, dikembalikan ke versi sebelumnya.\n${err}`);
    await git(['reset', '--hard', local]);
    badCommit = remote;
    return;
  }
  console.log(`[${ts()}] UPDATE: ${local.slice(0, 7)} → ${remote.slice(0, 7)}. Restart server...`);
  if (fs.readFileSync(__filename, 'utf8') !== runBefore) {
    console.log(`[${ts()}] run.js ikut berubah, launcher dimulai ulang.`);
    if (child) child.kill();
    setTimeout(() => process.exit(0), 1000); // panel/pengelola proses menyalakan ulang
    return;
  }
  if (child) { restarting = true; child.kill(); } else start();
}

start();
setTimeout(checkUpdate, 15000);
setInterval(checkUpdate, CHECK_EVERY);
