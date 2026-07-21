/**
 * Feedback sink for the Local Genres Research app.
 *
 * Bound to a Google Sheet (Extensions > Apps Script); writes to that sheet.
 * Deployed as a web app with "Anyone" access = one public URL that does two
 * things:
 *
 *   - doPost  — the app POSTs a batch; we append it as one row.
 *   - doGet   — no params: a liveness message. With ?pull=<PULL_TOKEN>: return
 *               every row not yet pulled as JSON and stamp them "Pulled" so the
 *               next pull only sees new ones. This is what lets a local script
 *               sync new feedback into the repo automatically. Add ?peek=1 to
 *               read without marking (for debugging).
 *
 * Row shape: [Received, Filename, Comment (markdown), Pulled].
 */

var SHEET_NAME = 'Feedback'

// Shared secret for the pull endpoint. Stored in Script Properties (Project
// Settings > Script Properties: add a property named PULL_TOKEN) so it is NOT
// committed to this public repo. Must match "token" in feedback/.pull.json.
function pullToken_() {
  return PropertiesService.getScriptProperties().getProperty('PULL_TOKEN')
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet()
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME)
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Received', 'Filename', 'Comment (markdown)', 'Pulled'])
    sh.setFrozenRows(1)
  }
  return sh
}

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}')
    sheet_().appendRow([new Date(), data.filename || '', data.markdown || '', ''])
    return json_({ ok: true })
  } catch (err) {
    return json_({ ok: false, error: String(err) })
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {}
  if (!params.pull) {
    return ContentService.createTextOutput('Genre feedback endpoint is live.')
  }
  var expected = pullToken_()
  if (!expected || params.pull !== expected) {
    return json_({ ok: false, error: 'bad token' })
  }

  var sh = sheet_()
  var last = sh.getLastRow()
  var rows = []
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, 4).getValues()
    for (var i = 0; i < values.length; i++) {
      if (values[i][3]) continue // already pulled
      rows.push({
        row: i + 2,
        received: values[i][0],
        filename: values[i][1],
        markdown: values[i][2],
      })
    }
  }

  // Mark returned rows as pulled unless this is a peek.
  if (!params.peek) {
    var stamp = new Date()
    for (var j = 0; j < rows.length; j++) {
      sh.getRange(rows[j].row, 4).setValue(stamp)
    }
  }

  return json_({ ok: true, count: rows.length, rows: rows })
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}
