'use strict';

/**
 * One-off: move the Applicants columns into the order of HEADERS in
 * lib/sheet.js. Whole columns move (header, data and formatting together), so
 * no value changes place within its column. Columns the recruiter added stay,
 * after the app's own. Row 1 and the Submitted / Name columns are frozen.
 * Shows the new order and stops unless --apply is given.
 *
 *   GOOGLE_SHEET_ID=... npm run reorder-columns            # dry run
 *   GOOGLE_SHEET_ID=... npm run reorder-columns -- --apply
 */
require('dotenv').config({ quiet: true });

const { HEADERS } = require('../lib/sheet');

const TAB = 'Applicants';

/**
 * The column moves that turn `current` (row 1) into HEADERS order, filling
 * from the left. Returns [{ from, to, name }] with 0-based indexes as the
 * Sheets API expects them at the time of each move.
 */
function planMoves(current) {
  const order = [...current];
  const moves = [];
  HEADERS.filter((h) => order.includes(h)).forEach((name, to) => {
    const from = order.indexOf(name);
    if (from === to) return;
    moves.push({ from, to, name });
    order.splice(to, 0, ...order.splice(from, 1));
  });
  return { moves, result: order };
}

async function main() {
  const { loadConfig } = require('../lib/config');
  const { createGoogleAuth } = require('../lib/google');
  const { sheets: sheetsApi } = require('@googleapis/sheets');

  const config = loadConfig();
  if (!config.sheetId) throw new Error('Set GOOGLE_SHEET_ID (in .env or the environment) first.');
  const sheets = sheetsApi({ version: 'v4', auth: createGoogleAuth(config) });
  const spreadsheetId = config.sheetId;

  const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const tab = meta.sheets.find((s) => s.properties.title === TAB);
  if (!tab) throw new Error(`No "${TAB}" tab.`);
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` });
  const current = ((data.values || [])[0] || []).map((h) => String(h).trim());

  const { moves, result } = planMoves(current);
  console.log('New order:');
  result.forEach((h, i) => console.log(`  ${String(i + 1).padStart(2)}. ${h}${HEADERS.includes(h) ? '' : '  (your own column, kept)'}`));
  console.log(`\n${moves.length} column moves.`);
  if (!process.argv.includes('--apply')) return console.log('Dry run: nothing changed. Run again with --apply.');

  const sheetId = tab.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        ...moves.map(({ from, to }) => ({
          moveDimension: {
            source: { sheetId, dimension: 'COLUMNS', startIndex: from, endIndex: from + 1 },
            destinationIndex: to,
          },
        })),
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } },
            fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
          },
        },
      ],
    },
  });
  console.log('Columns moved; row 1 and the first two columns are frozen.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { planMoves };
