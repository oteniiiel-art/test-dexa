/**
 * ============================================================
 *  SIPPI - Sistem Input Pengadaan Perangkat IT
 *  Backend Google Apps Script
 *  PT. Dexa Arfindo Pratama
 * ============================================================
 *  Cara pakai singkat (detail di PANDUAN_SETUP.md):
 *  1. Buat Google Spreadsheet baru, salin Spreadsheet ID-nya.
 *  2. Buat sheet bernama "Users" dan "Pengadaan" (lihat header di bawah).
 *  3. Buka Extensions > Apps Script pada spreadsheet tsb, tempel file ini.
 *  4. Isi SPREADSHEET_ID di bawah (atau kirim dari frontend).
 *  5. Deploy > New deployment > Web app > Execute as: Me, Access: Anyone.
 *  6. Salin URL Web App ke kolom "URL Google API / Apps Script" di halaman
 *     Pengaturan pada aplikasi web/mobile.
 * ============================================================
 */

const SCRIPT_URL = '';
let allData = [];
let filteredData = [];

const SHEET_USERS = 'Users';
const SHEET_PENGADAAN = 'Pengadaan';

const USER_HEADERS = ['id','nama','username','password','jabatan','divisi','role','email','hp'];
const PENGADAAN_HEADERS = ['id','kode','namaPerangkat','instansi','kategori','merk','jumlah','satuan','hargaSatuan','total','vendor','noPO','divisi','tglAjukan','tglButuh','status','tglBayar','metodeBayar','catatan','lampiranUrl','createdAt'];

/* ---------------------- ENTRY POINTS ---------------------- */

function doGet(e) {
  return jsonOut({ success: true, message: 'SIPPI backend aktif.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const ss = getSpreadsheet(body.spreadsheetId);

    switch (action) {
      case 'ping': return jsonOut({ success: true, message: 'Koneksi ke Apps Script & Spreadsheet berhasil.' });
      case 'login': return jsonOut(handleLogin(ss, body));
      case 'getUsers': return jsonOut({ success: true, data: getAllRows(ss, SHEET_USERS, USER_HEADERS) });
      case 'saveUser': return jsonOut(handleSaveUser(ss, body));
      case 'deleteUser': return jsonOut(handleDelete(ss, SHEET_USERS, body.id));
      case 'getPengadaan': return jsonOut({ success: true, data: getAllRows(ss, SHEET_PENGADAAN, PENGADAAN_HEADERS) });
      case 'savePengadaan': return jsonOut(handleSavePengadaan(ss, body));
      case 'deletePengadaan': return jsonOut(handleDelete(ss, SHEET_PENGADAAN, body.id));
      default: return jsonOut({ success: false, error: 'Aksi tidak dikenal: ' + action });
    }
  } catch (err) {
    return jsonOut({ success: false, error: err.message });
  }
}

/* ---------------------- HANDLERS ---------------------- */

function handleLogin(ss, body) {
  const users = getAllRows(ss, SHEET_USERS, USER_HEADERS);
  const user = users.find(u => u.username === body.username && String(u.password) === String(body.password));
  if (!user) return { success: false, error: 'Username atau password salah.' };
  const safeUser = Object.assign({}, user);
  return { success: true, user: safeUser };
}

function handleSaveUser(ss, body) {
  const sheet = getOrCreateSheet(ss, SHEET_USERS, USER_HEADERS);
  if (body.id) {
    const updated = updateRow(sheet, USER_HEADERS, body.id, body);
    if (!updated) return { success: false, error: 'User tidak ditemukan.' };
    return { success: true };
  }
  const id = 'U' + Utilities.getUuid().slice(0, 6).toUpperCase();
  const row = USER_HEADERS.map(h => h === 'id' ? id : (body[h] !== undefined ? body[h] : ''));
  sheet.appendRow(row);
  return { success: true, id: id };
}

function handleSavePengadaan(ss, body) {
  const sheet = getOrCreateSheet(ss, SHEET_PENGADAAN, PENGADAAN_HEADERS);
  if (body.id) {
    const updated = updateRow(sheet, PENGADAAN_HEADERS, body.id, body);
    if (!updated) return { success: false, error: 'Data tidak ditemukan.' };
    return { success: true };
  }
  const lastRow = sheet.getLastRow();
  const seq = lastRow; // baris data ke-N (header = baris 1)
  const id = 'P' + String(seq).padStart(4, '0');
  const kode = 'PGD-DXA-' + new Date().getFullYear() + '-' + String(seq).padStart(4, '0');
  const data = Object.assign({}, body, { id: id, kode: kode, createdAt: new Date().toISOString() });
  const row = PENGADAAN_HEADERS.map(h => data[h] !== undefined ? data[h] : '');
  sheet.appendRow(row);
  return { success: true, id: id, kode: kode };
}

function handleDelete(ss, sheetName, id) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { success: false, error: 'Sheet tidak ditemukan.' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: 'Data tidak ditemukan.' };
}

/* ---------------------- HELPERS ---------------------- */

function getSpreadsheet(idFromClient) {
  if (!idFromClient) {
    throw new Error('Spreadsheet ID belum diisi. Isi Spreadsheet ID di halaman Pengaturan > Koneksi Database pada aplikasi web.');
  }
  return SpreadsheetApp.openById(idFromClient);
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function getAllRows(ss, sheetName, headers) {
  const sheet = getOrCreateSheet(ss, sheetName, headers);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  return values.slice(1).filter(r => r[0] !== '').map(r => {
    const obj = {};
    head.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
}

function updateRow(sheet, headers, id, body) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      headers.forEach((h, colIdx) => {
        if (h === 'id') return;
        if (body[h] !== undefined) {
          sheet.getRange(i + 1, colIdx + 1).setValue(body[h]);
        }
      });
      return true;
    }
  }
  return false;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Jalankan fungsi ini sekali secara manual dari editor Apps Script
 * (Extensions > Apps Script yang dibuka dari dalam spreadsheet-nya)
 * untuk membuat sheet awal + akun Admin IT pertama.
 * Tidak perlu mengisi ID apapun - otomatis memakai spreadsheet ini sendiri.
 */
function setupInitialData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const users = getOrCreateSheet(ss, SHEET_USERS, USER_HEADERS);
  if (users.getLastRow() < 2) {
    users.appendRow(['U001', 'Admin IT', 'admin123', 'admin123', 'IT Manager', 'IT', 'Admin IT', '', '']);
  }
  getOrCreateSheet(ss, SHEET_PENGADAAN, PENGADAAN_HEADERS);
  Logger.log('Setup selesai. Spreadsheet ID: ' + ss.getId());
}
