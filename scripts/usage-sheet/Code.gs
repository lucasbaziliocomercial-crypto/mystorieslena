/**
 * MyStoriesLena — coletor central de consumo de tokens (Google Apps Script).
 *
 * Web App que recebe os eventos de uso enviados pelos apps das roteiristas
 * (lib/usage-log.ts → forwarder) e anexa cada um como uma linha na aba
 * "eventos". Deduplica por `id` (idempotente: retries de rede não duplicam).
 *
 * Só guarda NÚMEROS de tokens + metadados (roteirista, roteiro, categoria,
 * passo, modelo, data). Nenhum texto de história trafega.
 *
 * Deploy: ver README.md nesta pasta. Lembre de trocar TOKEN abaixo e usar o
 * MESMO valor em USAGE_SHEET_TOKEN no app.
 */

// ⚠️ TROQUE por uma senha qualquer e use a MESMA no app (USAGE_SHEET_TOKEN).
var TOKEN = "TROQUE_ESTE_TOKEN";

var SHEET_NAME = "eventos";
var HEADERS = [
  "id",
  "ts",
  "writer",
  "roteiroId",
  "category",
  "step",
  "model",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return json_({ ok: false, error: "lock timeout" });
  }
  try {
    var body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      body = {};
    }
    if (!body || body.token !== TOKEN) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var events = body.events && body.events.length ? body.events : [];
    if (!events.length) return json_({ ok: true, written: 0 });

    var sheet = getSheet_();
    var lastRow = sheet.getLastRow();

    // ids já gravados (coluna A, pulando o header) — pra deduplicar.
    var existing = {};
    if (lastRow > 1) {
      var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) existing[ids[i][0]] = true;
    }

    var rows = [];
    for (var j = 0; j < events.length; j++) {
      var ev = events[j] || {};
      if (!ev.id || existing[ev.id]) continue;
      existing[ev.id] = true;
      rows.push([
        ev.id,
        ev.ts || "",
        ev.writer || "",
        ev.roteiroId || "",
        ev.category || "",
        ev.step || "",
        ev.model || "",
        num_(ev.input),
        num_(ev.output),
        num_(ev.cacheRead),
        num_(ev.cacheWrite),
      ]);
    }

    if (rows.length) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length)
        .setValues(rows);
    }
    return json_({ ok: true, written: rows.length });
  } finally {
    lock.releaseLock();
  }
}

// Health check rápido (abrir a URL no navegador deve responder ok:true).
function doGet() {
  return json_({ ok: true, service: "mystorieslena-usage" });
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
