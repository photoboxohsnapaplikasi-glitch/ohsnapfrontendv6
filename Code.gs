// ============================================================================
// OH SNAP! PHOTOBOX - GOOGLE APPS SCRIPT (RESEND SOFTCOPY HANDLER)
// Tempel seluruh kode ini ke Extensions -> Apps Script, lalu Deploy -> Manage
// Deployments -> Edit (ikon pensil) -> Version: New version -> Deploy
// Catatan: Samakan SUPABASE_URL dan SUPABASE_KEY dengan yang ada di cms-cloud.js
// ============================================================================

var SUPABASE_URL = 'https://wiatbabvafjktwrdirys.supabase.co';
var SUPABASE_KEY = 'sb_publishable_miaUyHiO1kYUCyu7FxvGYg_RslVJWPx';

function isAuthorizedAdmin(tokenVal) {
  var token = String(tokenVal || "").trim();
  if (!token || token.length < 32) return false;
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/verify_admin_token', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY
      },
      payload: JSON.stringify({ p_token: token }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return false;
    var body = String(res.getContentText() || "").trim();
    return body === 'true';
  } catch (err) {
    return false;
  }
}

function executeSheetAction(sheet, data) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return false;

  var targetRow = Number(data.sheetRow || 0);
  var targetLink = String(data.link_foto || '').trim();
  var targetNama = String(data.nama || '').trim().toLowerCase();
  var targetHp = String(data.no_hp || '').replace(/\D/g, '');

  for (var r = lastRow; r >= 3; r--) {
    var vals = sheet.getRange(r, 1, 1, 10).getValues()[0];
    var rowNama = String(vals[4] || '').trim().toLowerCase();
    if (!rowNama || rowNama === 'nama') continue;
    var rowHp = String(vals[5] || '').replace(/\D/g, '');
    var rowLink = String(vals[8] || '').trim();

    var isMatch = (targetLink && targetLink !== '#' && targetLink !== 'Tidak ada' && rowLink === targetLink) ||
                  (targetNama && rowNama === targetNama && (!targetHp || rowHp.indexOf(targetHp) !== -1 || targetHp.indexOf(rowHp) !== -1)) ||
                  (targetRow === r);

    if (isMatch) {
      if (data.action === 'delete') {
        sheet.deleteRow(r);
        renumberRows(sheet);
      } else if (data.action === 'updateStatus') {
        sheet.getRange(r, 10).setValue(data.status || 'Sudah');
      }
      return true;
    }
  }
  return false;
}

function getFirstDataRowIndex(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return 3;
  var checkRows = Math.min(lastRow, 5);
  var vals = sheet.getRange(1, 5, checkRows, 1).getValues();
  for (var r = 2; r < vals.length; r++) {
    var cell = String(vals[r][0] || '').trim().toUpperCase();
    if (cell && cell !== 'NAMA') return r + 1;
  }
  return 3;
}

function doPost(e) {
  try {
    var rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var data = JSON.parse(rawBody);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // Aksi Admin (Hapus / Ubah Status) wajib diverifikasi ke sesi aktif Supabase
    if (data.action === 'delete' || data.action === 'updateStatus') {
      if (!isAuthorizedAdmin(data.token || data.adminKey)) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "UNAUTHORIZED: Sesi admin tidak valid." }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var matched = executeSheetAction(sheet, data);
      return ContentService.createTextOutput(JSON.stringify({ status: "success", matched: matched }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var nama = String(data.nama || "").trim();
    var email = String(data.email || "").trim();
    var whatsapp = String(data.whatsapp || data.no_hp || "").trim();
    var cabang = String(data.cabang || "").trim();
    var tanggal_foto = String(data.tanggal_foto || "").trim();
    var jam_foto = String(data.jam_foto || "").trim();

    if (!nama || !email || !whatsapp || !tanggal_foto || !jam_foto) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Data wajib belum lengkap." }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var timestamp = Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy HH:mm:ss");
    var tindak_lanjut = "Belum";
    var fileUrl = "Tidak ada";

    if (data.foto && data.foto.indexOf("base64") !== -1) {
      var base64Data = data.foto.split(",")[1];
      var safeName = String(data.filename || "bukti_foto.jpg").replace(/[^a-zA-Z0-9._-]/g, '_');
      var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), MimeType.JPEG, safeName);
      var folder = DriveApp.getRootFolder();
      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      fileUrl = file.getUrl();
    }

    var startRow = getFirstDataRowIndex(sheet);
    var lastRow = sheet.getLastRow();
    var nextNo = lastRow >= startRow ? (lastRow - startRow + 2) : 1;

    sheet.appendRow([
      nextNo,
      "'" + timestamp,
      "'" + tanggal_foto,
      "'" + jam_foto,
      nama,
      "'" + whatsapp,
      email,
      cabang,
      fileUrl,
      tindak_lanjut
    ]);

    return ContentService.createTextOutput(JSON.stringify({ status: "success", url: fileUrl }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var params = (e && e.parameter) ? e.parameter : {};

  // Proteksi pembacaan data pelanggan: wajib memverifikasi token sesi admin ke Supabase
  if (!isAuthorizedAdmin(params.token || params.adminKey)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "unauthorized",
      message: "Akses ditolak. Endpoint ini hanya untuk Admin OH SNAP! yang sedang login."
    })).setMimeType(ContentService.MimeType.JSON);
  }

  if (params.action === 'delete' || params.action === 'updateStatus') {
    var matched = executeSheetAction(sheet, params);
    return ContentService.createTextOutput(JSON.stringify({ status: "success", matched: matched }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var rows = sheet.getDataRange().getValues();
  var displayRows = sheet.getDataRange().getDisplayValues();
  var res = [];

  var counter = 1;
  for (var i = 2; i < rows.length; i++) {
    var row = rows[i];
    var dRow = displayRows[i] || row;
    var rawName = String(row[4] || "").trim();
    if (!rawName || rawName.toUpperCase() === "NAMA") continue;

    res.push({
      _sheetRow: i + 1,
      id: i,
      no: counter++,
      tanggal_masuk: dRow[1] ? String(dRow[1]) : "",
      tanggal_foto: dRow[2] ? String(dRow[2]) : "",
      jam_foto: dRow[3] ? String(dRow[3]) : "",
      nama: dRow[4] ? String(dRow[4]) : "",
      whatsapp: dRow[5] ? String(dRow[5]) : "",
      email: dRow[6] ? String(dRow[6]) : "",
      cabang: dRow[7] ? String(dRow[7]) : "",
      link_foto: row[8] ? String(row[8]) : "",
      tindak_lanjut: dRow[9] ? String(dRow[9]) : "Belum"
    });
  }

  return ContentService.createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}

function renumberRows(sheet) {
  var startRow = getFirstDataRowIndex(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return;
  var numRows = lastRow - startRow + 1;
  var range = sheet.getRange(startRow, 1, numRows, 1);
  var values = [];
  for (var i = 1; i <= numRows; i++) {
    values.push([i]);
  }
  range.setValues(values);
}
