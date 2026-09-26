/**
 * =====================================================================
 *  SIPPI - Backend Google Apps Script
 *  PT. Dexa Arfindo Pratama - Sistem Input Pengadaan Perangkat IT
 * =====================================================================
 *  Deploy: Deploy > New deployment > Web app
 *          Execute as : Me
 *          Who has access : Anyone
 *  Setiap kali file ini diubah, deploy ulang dengan "New version".
 *  (Pertama kali dijalankan akan meminta izin Spreadsheet + Drive.)
 * =====================================================================
 */

const CONFIG = {
  // ID Spreadsheet database. Kosongkan jika script ini dibuat dari menu
  // Extensions > Apps Script di dalam Spreadsheet-nya (bound script).
  SPREADSHEET_ID: '1OwCTbIY2cZVcETiaROKy6jAp6wUVbO_eRliUhDXF0Gw',

  // Folder induk di Google Drive untuk foto nota.
  // https://drive.google.com/drive/folders/1MJ_Jsq3sHkiOJDccU4lBnH7iypp4ap_5
  ROOT_FOLDER_ID: '1MJ_Jsq3sHkiOJDccU4lBnH7iypp4ap_5',

  // Nama sheet (dicari tanpa membedakan huruf besar/kecil; dibuat jika belum ada)
  SHEET_USERS: ['Users', 'User', 'Pengguna'],
  SHEET_PENGADAAN: ['Pengadaan', 'Data Pengadaan', 'Data'],

  SESSION_DAYS: 7,          // lama sesi login (hari)
  MAX_LOGIN_FAIL: 5,        // maksimal gagal login...
  LOGIN_LOCK_MINUTES: 10,   // ...sebelum dikunci sementara
  MAX_FILES: 5,             // maksimal foto nota per simpan
  MAX_FILE_MB: 8,           // maksimal ukuran per foto (setelah dikompres di browser)
  ROLE_ADMIN: 'Admin IT'
};

const USER_COLS = ['id', 'nama', 'username', 'password', 'jabatan', 'divisi', 'role', 'email', 'hp'];
const PGD_COLS = ['id', 'kode', 'namaPerangkat', 'instansi', 'kategori', 'merk', 'jumlah', 'satuan',
  'hargaSatuan', 'total', 'vendor', 'noPO', 'divisi', 'tglAjukan', 'tglButuh', 'status', 'tglBayar', 'metodeBayar', 'catatan',
  'notaFolderUrl', 'notaFiles', 'createdBy', 'createdAt', 'updatedAt'];

// Field yang boleh diisi dari browser (whitelist)
const PGD_INPUT = ['namaPerangkat', 'instansi', 'kategori', 'merk', 'jumlah', 'satuan', 'hargaSatuan', 'total',
  'vendor', 'noPO', 'divisi', 'tglAjukan', 'tglButuh', 'status', 'tglBayar', 'metodeBayar', 'catatan'];
const SELF_EDITABLE = ['nama', 'divisi', 'jabatan', 'email', 'hp', 'password'];
const ADMIN_EDITABLE = ['nama', 'username', 'password', 'jabatan', 'divisi', 'role', 'email', 'hp'];
const PGD_TEXT = ['id', 'kode', 'noPO', 'tglAjukan', 'tglButuh', 'tglBayar', 'createdAt', 'updatedAt'];
const TEXT_USER_COLS = ['id', 'nama', 'username', 'password', 'jabatan', 'divisi', 'role', 'email', 'hp'];

/* ============================ ENTRY POINTS ============================ */

function doGet() {
  return json_({ success: true, message: 'SIPPI API aktif.' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(route_(req));
  } catch (err) {
    return json_({ success: false, error: 'Server error: ' + err.message });
  }
}

function route_(req) {
  const action = req.action;

  // ---- aksi publik ----
  if (action === 'ping') return { success: true, message: 'Terhubung ke Apps Script.' };
  if (action === 'login') return login_(req);

  // ---- semua aksi lain wajib login ----
  const me = authenticate_(req.token);
  if (!me) return { success: false, code: 'AUTH', error: 'Sesi berakhir. Silakan login kembali.' };

  switch (action) {
    case 'session':        return { success: true, user: publicUser_(me) };
    case 'getPengadaan':   return getPengadaan_();
    case 'savePengadaan':  return withLock_(() => savePengadaan_(req, me));
    case 'deletePengadaan':return withLock_(() => deletePengadaan_(req));
    case 'getUsers':       return getUsers_(me);
    case 'getConfig':      return adminOnly_(me, () => getConfig_());
    case 'testConnection': return adminOnly_(me, () => testConnection_(req));
    case 'saveConfig':     return adminOnly_(me, () => withLock_(() => saveConfig_(req, me)));
    case 'saveUser':       return withLock_(() => saveUser_(req, me));
    case 'deleteUser':     return withLock_(() => deleteUser_(req, me));
    default:               return { success: false, error: 'Aksi tidak dikenal.' };
  }
}

/* ================================ AUTH ================================ */

function login_(req) {
  const username = String(req.username || '').trim();
  const password = String(req.password || '');
  if (!username || !password) return { success: false, error: 'Username dan password wajib diisi.' };

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username.toLowerCase().slice(0, 100);
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAIL) {
    return { success: false, error: 'Terlalu banyak percobaan gagal. Coba lagi dalam ' + CONFIG.LOGIN_LOCK_MINUTES + ' menit.' };
  }

  const user = readUsers_().find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
  if (!user) {
    cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCK_MINUTES * 60);
    return { success: false, error: 'Username atau password salah.' };
  }
  cache.remove(failKey);
  return { success: true, user: publicUser_(user), token: makeToken_(user.id) };
}

/** Token bertanda tangan HMAC: base64(payload).base64(signature). Tidak perlu disimpan di server. */
function makeToken_(userId) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    u: userId,
    e: Date.now() + CONFIG.SESSION_DAYS * 24 * 3600 * 1000
  }));
  return payload + '.' + sign_(payload);
}

function authenticate_(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts[1] !== sign_(parts[0])) return null;
  let data;
  try {
    data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) { return null; }
  if (!data || !data.u || Date.now() > data.e) return null;
  // Ambil user terbaru dari sheet -> jika user dihapus / role berubah, langsung berlaku.
  return readUsers_().find(u => u.id === String(data.u)) || null;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', s);
  }
  return s;
}

function isAdmin_(u) { return !!u && u.role === CONFIG.ROLE_ADMIN; }

/** Data user tanpa password (dipakai untuk login & session). */
function publicUser_(u) {
  const o = {};
  USER_COLS.forEach(k => { if (k !== 'password') o[k] = u[k]; });
  return o;
}

/* ================================ USERS =============================== */

function getUsers_(me) {
  // Hanya Admin IT yang boleh melihat seluruh user + password.
  if (!isAdmin_(me)) return { success: false, code: 'FORBIDDEN', error: 'Hanya Admin IT yang dapat melihat data pengguna.' };
  return { success: true, data: readUsers_() };
}

function saveUser_(req, me) {
  const admin = isAdmin_(me);
  const targetId = req.id ? String(req.id) : '';

  // Non-admin hanya boleh mengubah akunnya sendiri (tanpa role & username).
  if (!admin) {
    if (!targetId || targetId !== me.id) {
      return { success: false, code: 'FORBIDDEN', error: 'Anda tidak memiliki izin mengelola pengguna lain.' };
    }
  }

  const sheet = usersSheet_();
  const users = readUsers_();
  const allowed = admin ? ADMIN_EDITABLE : SELF_EDITABLE;
  const clean = {};
  allowed.forEach(k => { if (req[k] !== undefined && req[k] !== null) clean[k] = String(req[k]).trim(); });
  if ('password' in clean && clean.password === '') delete clean.password;

  // Admin tidak boleh menurunkan role dirinya sendiri (mencegah tidak ada admin tersisa).
  if (admin && targetId === me.id && clean.role && clean.role !== CONFIG.ROLE_ADMIN) delete clean.role;

  if (clean.username !== undefined) {
    if (!clean.username) return { success: false, error: 'Username tidak boleh kosong.' };
    const dup = users.find(u => u.username.toLowerCase() === clean.username.toLowerCase() && u.id !== targetId);
    if (dup) return { success: false, error: 'Username sudah dipakai.' };
  }

  let rec;
  if (targetId) {
    rec = users.find(u => u.id === targetId);
    if (!rec) return { success: false, error: 'Pengguna tidak ditemukan.' };
    Object.assign(rec, clean);
  } else {
    if (!clean.nama || !clean.username) return { success: false, error: 'Nama dan username wajib diisi.' };
    rec = { id: nextId_('U', users.map(u => u.id), 3), role: 'Staff Pengadaan', password: '123' };
    USER_COLS.forEach(k => { if (rec[k] === undefined) rec[k] = ''; });
    Object.assign(rec, clean);
  }
  upsertRow_(sheet, USER_COLS, rec, TEXT_USER_COLS);
  return { success: true, user: publicUser_(rec) };
}

function deleteUser_(req, me) {
  if (!isAdmin_(me)) return { success: false, code: 'FORBIDDEN', error: 'Hanya Admin IT yang dapat menghapus pengguna.' };
  const id = String(req.id || '');
  if (id === me.id) return { success: false, error: 'Tidak bisa menghapus akun sendiri.' };
  return deleteRow_(usersSheet_(), USER_COLS, id)
    ? { success: true }
    : { success: false, error: 'Pengguna tidak ditemukan.' };
}

function readUsers_() {
  const sheet = usersSheet_();
  const rows = readRows_(sheet, USER_COLS);
  // Nilai seperti password "123" / no. HP bisa terbaca sebagai angka -> paksa jadi teks.
  return rows.map(r => {
    TEXT_USER_COLS.forEach(k => { r[k] = r[k] === '' || r[k] == null ? '' : String(r[k]); });
    return r;
  }).filter(r => r.id || r.username);
}

function usersSheet_() {
  const sheet = getSheet_(CONFIG.SHEET_USERS);
  ensureHeaders_(sheet, USER_COLS);
  const rows = readRows_(sheet, USER_COLS);

  // Beri ID pada baris user lama yang belum punya ID.
  const ids = rows.map(r => String(r.id || '')).filter(Boolean);
  rows.forEach(r => {
    if (!r.id && r.username) {
      r.id = nextId_('U', ids, 3);
      ids.push(r.id);
      upsertRow_(sheet, USER_COLS, r, TEXT_USER_COLS);
    }
  });

  // Sheet kosong: buat 1 akun Admin awal. SEGERA GANTI passwordnya setelah login pertama.
  if (!rows.length) {
    upsertRow_(sheet, USER_COLS, {
      id: 'U001', nama: 'Admin IT', username: 'admin', password: 'admin123',
      jabatan: 'Admin IT', divisi: 'IT', role: CONFIG.ROLE_ADMIN, email: '', hp: ''
    }, TEXT_USER_COLS);
  }
  return sheet;
}

/* ============================== PENGADAAN ============================= */

function getPengadaan_() {
  const rows = readRows_(pengadaanSheet_(), PGD_COLS).filter(r => r.id).map(r => {
    r.notaFiles = parseJson_(r.notaFiles, []);
    return r;
  });
  return { success: true, data: rows };
}

function savePengadaan_(req, me) {
  const sheet = pengadaanSheet_();
  const rows = readRows_(sheet, PGD_COLS);
  const now = nowStr_();

  const clean = {};
  PGD_INPUT.forEach(k => { if (req[k] !== undefined && req[k] !== null) clean[k] = req[k]; });

  let rec;
  if (req.id) {
    rec = rows.find(r => String(r.id) === String(req.id));
    if (!rec) return { success: false, error: 'Data pengadaan tidak ditemukan.' };
    Object.assign(rec, clean);
    rec.updatedAt = now;
  } else {
    const year = String((clean.tglAjukan || now).slice(0, 4));
    const seq = rows.reduce((m, r) => {
      const n = String(r.kode || '');
      return n.indexOf('PGD-DXA-' + year + '-') === 0 ? Math.max(m, Number(n.split('-').pop()) || 0) : m;
    }, 0) + 1;
    rec = { id: nextId_('P', rows.map(r => String(r.id)), 3) };
    PGD_COLS.forEach(k => { if (rec[k] === undefined) rec[k] = ''; });
    Object.assign(rec, clean);
    rec.kode = 'PGD-DXA-' + year + '-' + pad_(seq, 4);
    rec.createdBy = me.username;
    rec.createdAt = now;
    rec.updatedAt = now;
  }

  // ---- Upload foto nota -> Drive: [Folder induk] / [Nama RS] / [tanggal] ----
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length) {
    if (files.length > CONFIG.MAX_FILES) return { success: false, error: 'Maksimal ' + CONFIG.MAX_FILES + ' foto nota per penyimpanan.' };
    try {
      const up = uploadNota_(rec, files);
      const existing = parseJson_(rec.notaFiles, []);
      rec.notaFiles = JSON.stringify(existing.concat(up.files));
      rec.notaFolderUrl = up.folderUrl;
    } catch (err) {
      return { success: false, error: 'Gagal mengunggah foto nota: ' + err.message };
    }
  } else if (typeof rec.notaFiles !== 'string') {
    rec.notaFiles = JSON.stringify(rec.notaFiles || []);
  }

  upsertRow_(sheet, PGD_COLS, rec, PGD_TEXT);
  const out = Object.assign({}, rec, { notaFiles: parseJson_(rec.notaFiles, []) });
  return { success: true, data: out };
}

function deletePengadaan_(req) {
  return deleteRow_(pengadaanSheet_(), PGD_COLS, String(req.id || ''))
    ? { success: true }
    : { success: false, error: 'Data tidak ditemukan.' };
}

function pengadaanSheet_() {
  const sheet = getSheet_(CONFIG.SHEET_PENGADAAN);
  ensureHeaders_(sheet, PGD_COLS);
  return sheet;
}

/* ========================= DRIVE: FOLDER OTOMATIS ===================== */

/**
 * Membuat (jika belum ada) folder "Nama RS" di dalam folder induk, lalu subfolder
 * "tanggal" (yyyy-MM-dd) di dalamnya, dan menyimpan semua foto ke sana.
 * Contoh: Nota Pengadaan / RS Dexa Medika Semarang / 2026-09-21 / Nota_PGD-DXA-2026-0007_1.jpg
 */
function uploadNota_(rec, files) {
  const root = DriveApp.getFolderById(dbConfig_().driveFolderId);
  const rsName = safeName_(rec.instansi) || 'Tanpa Nama RS';
  const tgl = /^\d{4}-\d{2}-\d{2}$/.test(String(rec.tglAjukan || '')) ? rec.tglAjukan : nowStr_().slice(0, 10);

  const rsFolder = getOrCreateFolder_(root, rsName);
  const dateFolder = getOrCreateFolder_(rsFolder, tgl);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
  const saved = [];

  files.forEach((f, i) => {
    const mime = String(f.mime || '');
    if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(mime) && mime !== 'application/pdf') {
      throw new Error('Format file tidak didukung (' + (mime || 'tidak diketahui') + ').');
    }
    const bytes = Utilities.base64Decode(String(f.data || ''));
    if (bytes.length > CONFIG.MAX_FILE_MB * 1024 * 1024) throw new Error('Ukuran foto melebihi ' + CONFIG.MAX_FILE_MB + ' MB.');
    const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1].replace('jpeg', 'jpg');
    const name = 'Nota_' + (rec.kode || rec.id) + '_' + stamp + '_' + (i + 1) + '.' + ext;
    const file = dateFolder.createFile(Utilities.newBlob(bytes, mime, name));
    saved.push({ name: name, url: file.getUrl(), id: file.getId() });
  });
  return { files: saved, folderUrl: dateFolder.getUrl() };
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function safeName_(s) {
  return String(s || '').replace(/[\\\/:*?"<>|#\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/* ====================== KONEKSI DATABASE (ADMIN) ====================== */

function adminOnly_(me, fn) {
  if (!isAdmin_(me)) return { success: false, code: 'FORBIDDEN', error: 'Hanya Admin IT yang dapat mengelola koneksi database.' };
  return fn();
}

/** ID aktif: yang disimpan Admin lewat web (Script Properties), jika tidak ada pakai CONFIG. */
function dbConfig_() {
  const p = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: p.getProperty('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID,
    driveFolderId: p.getProperty('ROOT_FOLDER_ID') || CONFIG.ROOT_FOLDER_ID
  };
}

/** Ambil ID dari input: boleh ID saja atau link lengkap Spreadsheet / folder Drive. */
function extractId_(v) {
  v = String(v || '').trim();
  const m = v.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || v.match(/\/folders\/([a-zA-Z0-9_-]{20,})/) || v.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : v;
}

function getConfig_() {
  const c = dbConfig_();
  return { success: true, data: { spreadsheetId: c.spreadsheetId, driveFolderId: c.driveFolderId } };
}

/** Cek akses Spreadsheet & folder Drive, tanpa menyimpan apa pun. */
function checkDb_(sid, fid) {
  const info = { spreadsheet: null, folder: null, errors: [] };
  try {
    const ss = SpreadsheetApp.openById(sid);
    const names = ss.getSheets().map(x => x.getName());
    const count = (list) => {
      const w = list.map(n => n.toLowerCase());
      const sh = ss.getSheets().find(x => w.indexOf(x.getName().toLowerCase()) > -1);
      return sh ? Math.max(sh.getLastRow() - 1, 0) : null;
    };
    info.spreadsheet = { name: ss.getName(), url: ss.getUrl(), sheets: names,
      users: count(CONFIG.SHEET_USERS), pengadaan: count(CONFIG.SHEET_PENGADAAN) };
  } catch (err) { info.errors.push('Spreadsheet tidak dapat dibuka (' + err.message + ')'); }
  try {
    const f = DriveApp.getFolderById(fid);
    info.folder = { name: f.getName(), url: f.getUrl() };
  } catch (err) { info.errors.push('Folder Drive tidak dapat dibuka (' + err.message + ')'); }
  return info;
}

function testConnection_(req) {
  const c = dbConfig_();
  const sid = extractId_(req.spreadsheetId) || c.spreadsheetId;
  const fid = extractId_(req.driveFolderId) || c.driveFolderId;
  const info = checkDb_(sid, fid);
  if (info.errors.length) return { success: false, error: info.errors.join(' | '), data: info };
  const s = info.spreadsheet;
  const msg = 'Terhubung: Spreadsheet "' + s.name + '" (' +
    (s.users === null ? 'sheet Users belum ada' : s.users + ' user') + ', ' +
    (s.pengadaan === null ? 'sheet Pengadaan belum ada' : s.pengadaan + ' data pengadaan') +
    ') & folder "' + info.folder.name + '".';
  return { success: true, message: msg, data: info };
}

/**
 * Simpan Spreadsheet ID & Folder ID baru. Sheet Users/Pengadaan dibuat otomatis bila belum ada.
 * Jika Spreadsheet baru belum punya user, akun Admin yang sedang login disalin ke sana
 * supaya tidak terkunci keluar.
 */
function saveConfig_(req, me) {
  const sid = extractId_(req.spreadsheetId);
  const fid = extractId_(req.driveFolderId);
  if (!sid || !fid) return { success: false, error: 'Spreadsheet ID dan Google Drive Folder ID wajib diisi.' };
  const info = checkDb_(sid, fid);
  if (info.errors.length) return { success: false, error: info.errors.join(' | ') };

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', sid);
  props.setProperty('ROOT_FOLDER_ID', fid);

  const uSheet = getSheet_(CONFIG.SHEET_USERS);
  ensureHeaders_(uSheet, USER_COLS);
  if (!readRows_(uSheet, USER_COLS).length) {
    const copy = {};
    USER_COLS.forEach(k => { copy[k] = me[k] === undefined ? '' : me[k]; });
    upsertRow_(uSheet, USER_COLS, copy, TEXT_USER_COLS);
  }
  usersSheet_();
  pengadaanSheet_();
  return { success: true, message: 'Koneksi database disimpan: "' + info.spreadsheet.name + '" & folder "' + info.folder.name + '".', data: getConfig_().data };
}

/* =========================== SHEET HELPERS ============================ */

function spreadsheet_() {
  const sid = dbConfig_().spreadsheetId;
  if (sid) {
    try { return SpreadsheetApp.openById(sid); } catch (err) { /* fallback ke bound sheet */ }
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Spreadsheet tidak ditemukan. Periksa CONFIG.SPREADSHEET_ID.');
  return active;
}

function getSheet_(names) {
  const ss = spreadsheet_();
  const wanted = names.map(n => n.toLowerCase());
  const found = ss.getSheets().find(s => wanted.indexOf(s.getName().toLowerCase()) > -1);
  return found || ss.insertSheet(names[0]);
}

/** Pastikan baris 1 berisi semua kolom; kolom yang belum ada ditambahkan di kanan. */
function ensureHeaders_(sheet, cols) {
  if (sheet.getLastColumn() === 0 || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase());
  const missing = cols.filter(c => header.indexOf(c.toLowerCase()) < 0);
  if (missing.length) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
}

function headerMap_(sheet) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return header.map(h => String(h).trim());
}

/** Baca semua baris jadi array objek (kunci = nama kolom kanonik). Date -> yyyy-MM-dd. */
function readRows_(sheet, cols) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const header = headerMap_(sheet);
  const canon = header.map(h => cols.find(c => c.toLowerCase() === h.toLowerCase()) || null);
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const values = sheet.getRange(2, 1, last - 1, header.length).getValues();
  const out = [];
  values.forEach((row, idx) => {
    if (row.every(v => v === '' || v === null)) return;
    const o = { _row: idx + 2 };
    cols.forEach(c => { o[c] = ''; });
    row.forEach((v, i) => {
      if (!canon[i]) return;
      o[canon[i]] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
    });
    out.push(o);
  });
  return out;
}

/**
 * Simpan objek ke sheet. Baris ditentukan oleh rec._row (jika ada, hasil readRows_),
 * lalu berdasarkan id; jika tidak ketemu, ditambahkan sebagai baris baru.
 * textKeys = kolom yang dipaksa berformat teks (agar "0123" / tanggal tidak diubah Sheets).
 */
function upsertRow_(sheet, cols, rec, textKeys) {
  ensureHeaders_(sheet, cols);
  const header = headerMap_(sheet);
  const idCol = header.findIndex(h => h.toLowerCase() === 'id') + 1;
  const last = sheet.getLastRow();
  let rowNum = rec._row || 0;
  if (!rowNum && last >= 2) {
    const ids = sheet.getRange(2, idCol, last - 1, 1).getValues().map(r => String(r[0]));
    const at = ids.indexOf(String(rec.id));
    if (at > -1) rowNum = at + 2;
  }
  const isNew = !rowNum;
  if (isNew) rowNum = last + 1;

  const range = sheet.getRange(rowNum, 1, 1, header.length);
  const current = isNew ? new Array(header.length).fill('') : range.getValues()[0];
  const formats = isNew ? new Array(header.length).fill('General') : range.getNumberFormats()[0];
  const keys = header.map(h => cols.find(c => c.toLowerCase() === h.toLowerCase()) || null);

  const values = keys.map((key, i) => (key && rec[key] !== undefined ? rec[key] : current[i]));
  const newFormats = keys.map((key, i) => (key && textKeys && textKeys.indexOf(key) > -1 ? '@' : formats[i]));

  range.setNumberFormats([newFormats]);
  range.setValues([values]);
}

function deleteRow_(sheet, cols, id) {
  ensureHeaders_(sheet, cols);
  const header = headerMap_(sheet);
  const idCol = header.findIndex(h => h.toLowerCase() === 'id') + 1;
  const last = sheet.getLastRow();
  if (last < 2 || !id) return false;
  const ids = sheet.getRange(2, idCol, last - 1, 1).getValues().map(r => String(r[0]));
  const at = ids.indexOf(id);
  if (at < 0) return false;
  sheet.deleteRow(at + 2);
  return true;
}

/* ============================== UTILITIES ============================= */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function parseJson_(v, fallback) {
  if (Array.isArray(v)) return v;
  if (!v) return fallback;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : fallback; } catch (e) { return fallback; }
}

function pad_(n, len) { return ('0000000000' + n).slice(-len); }

function nextId_(prefix, existingIds, len) {
  const max = existingIds.reduce((m, id) => {
    const n = parseInt(String(id).replace(/\D/g, ''), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return prefix + pad_(max + 1, len);
}

function nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/* ============================ SETUP MANUAL ============================
 * buatAdminBaru()
 * Jalankan fungsi ini SEKALI dari editor Apps Script untuk membuat akun
 * Admin IT yang pasti bisa login ke web:
 *   1. Buka Extensions > Apps Script pada Spreadsheet ini.
 *   2. Pilih fungsi "buatAdminBaru" di dropdown toolbar (di samping tombol Run/Debug).
 *   3. Klik "Run". Izinkan akses saat diminta (hanya perlu sekali).
 *   4. Buka tab "Executions" atau menu View > Logs untuk melihat hasilnya.
 * Login di web dengan:
 *   Username : admin
 *   Password : Admin123!
 * Jika username "admin" SUDAH ada di sheet Users, fungsi ini akan
 * menjadikannya Admin IT dan mereset passwordnya ke "Admin123!" (bukan
 * membuat duplikat). Segera ganti password ini lewat menu Pengaturan
 * setelah berhasil login.
 * ===================================================================== */
function buatAdminBaru() {
  const USERNAME = 'admin';
  const PASSWORD = 'Admin123!';

  const sheet = usersSheet_();
  const users = readUsers_();
  let rec = users.find(u => u.username.toLowerCase() === USERNAME.toLowerCase());
  const isNew = !rec;

  if (isNew) {
    rec = { id: nextId_('U', users.map(u => u.id), 3) };
    USER_COLS.forEach(k => { if (rec[k] === undefined) rec[k] = ''; });
  }
  rec.nama = rec.nama || 'Admin IT';
  rec.username = USERNAME;
  rec.password = PASSWORD;
  rec.role = CONFIG.ROLE_ADMIN;
  rec.jabatan = rec.jabatan || 'Admin IT';
  rec.divisi = rec.divisi || 'IT';

  upsertRow_(sheet, USER_COLS, rec, TEXT_USER_COLS);

  const msg = (isNew ? 'Akun Admin IT baru dibuat. ' : 'Akun "admin" sudah ada — password direset. ')
    + 'Login dengan username "admin" dan password "Admin123!". Segera ganti password setelah login.';
  Logger.log(msg);
  return msg;
}
