'use strict';

/**
 * One-off: rewrite the Phone column of the Applicants tab in the format the
 * form now saves (+62 812-3456-7890). Shows what would change; nothing is
 * written without --apply. Numbers that are not Indonesian mobile numbers are
 * listed and left as they are.
 *
 *   GOOGLE_SHEET_ID=... npm run format-phones            # dry run
 *   GOOGLE_SHEET_ID=... npm run format-phones -- --apply # write the changes
 */
require('dotenv').config({ quiet: true });

const { normalizePhone } = require('../lib/validate');
const { columnLetter } = require('../lib/sheet');

const TAB = 'Applicants';

/**
 * values = the Phone column from row 2 down, as the Sheets API returns it.
 * Returns { updates: [{ row, from, to }], skipped: [{ row, value }] }.
 */
function planPhoneUpdates(values = []) {
  const updates = [];
  const skipped = [];
  values.forEach(([phone = ''], i) => {
    const row = i + 2;
    const from = String(phone).replace(/^'/, '').trim();
    if (!from) return;
    const to = normalizePhone(from);
    if (!to) skipped.push({ row, value: from });
    else if (to !== from) updates.push({ row, from, to });
  });
  return { updates, skipped };
}

async function main() {
  const { loadConfig } = require('../lib/config');
  const { createGoogleAuth } = require('../lib/google');
  const { sheets: sheetsApi } = require('@googleapis/sheets');

  const config = loadConfig();
  if (!config.sheetId) throw new Error('Set GOOGLE_SHEET_ID (in .env or the environment) first.');
  const apply = process.argv.includes('--apply');
  const sheets = sheetsApi({ version: 'v4', auth: createGoogleAuth(config) });
  const spreadsheetId = config.sheetId;

  // Columns can be in any order: find Phone by its header.
  const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
  const at = ((head.data.values || [])[0] || []).indexOf('Phone');
  if (at < 0) throw new Error(`No "Phone" column in row 1 of ${TAB}.`);
  const COLUMN = columnLetter(at);
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!${COLUMN}2:${COLUMN}` });
  const { updates, skipped } = planPhoneUpdates(data.values);

  for (const u of updates) console.log(`row ${u.row}: ${u.from}  ->  ${u.to}`);
  for (const s of skipped) console.log(`row ${s.row}: ${s.value}  (not an Indonesian mobile number, left as is)`);
  console.log(`\n${updates.length} to change, ${skipped.length} left as is.`);

  if (!updates.length) return;
  if (!apply) return console.log('Dry run: nothing written. Run again with --apply to write these changes.');

  // RAW keeps "+62 ..." as text, so no formula guard is needed.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map((u) => ({ range: `${TAB}!${COLUMN}${u.row}`, values: [[u.to]] })),
    },
  });
  console.log(`Written: ${updates.length} cells.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { planPhoneUpdates };
