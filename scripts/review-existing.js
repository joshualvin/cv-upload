'use strict';

/**
 * One-off: run the AI review on applications that came in before the
 * "Red flags" and "Average years per job" columns existed, and fill in only
 * those two columns. Every other cell stays as it is.
 *
 * A row is reviewed when its Red flags cell is empty and it has a CV link.
 * Shows the list and stops unless --apply is given. Each review costs about
 * US$0.05 with Claude Opus 5.5.
 *
 *   npm run review-existing                      # dry run
 *   npm run review-existing -- --apply           # review every row listed
 *   npm run review-existing -- --apply --limit 3 # only the first 3
 *
 * Needs the same settings as the server: GOOGLE_SHEET_ID, the Google sign-in
 * and ANTHROPIC_API_KEY (in .env or the environment).
 */
require('dotenv').config({ quiet: true });

const { HEADERS } = require('../lib/sheet');

const TAB = 'Applicants';
const COL = (name) => HEADERS.indexOf(name);
const LETTER = (name) => String.fromCharCode(65 + COL(name));

/** Drive file ID from the CV cell (a HYPERLINK formula or a plain link). */
function driveFileId(value) {
  const m = String(value || '').match(/\/file\/d\/([\w-]+)/) || String(value || '').match(/[?&]id=([\w-]+)/);
  return m ? m[1] : '';
}

/**
 * values = rows from row 2 down, with formulas (valueRenderOption FORMULA).
 * Returns { todo: [{ row, name, position, otherInterest, fileId }], noCv: [row] }.
 */
function planReviews(values = []) {
  const todo = [];
  const noCv = [];
  values.forEach((cells, i) => {
    const row = i + 2;
    const get = (name) => String(cells[COL(name)] ?? '').trim();
    if (!cells.some((c) => String(c ?? '').trim())) return; // empty row
    if (get('Red flags')) return; // already reviewed
    const fileId = driveFileId(get('CV'));
    if (!fileId) return noCv.push(row);
    todo.push({
      row,
      name: get('Name').replace(/^'/, ''),
      position: get('Position').replace(/^'/, ''),
      otherInterest: get('Other role interest').replace(/^'/, ''),
      fileId,
    });
  });
  return { todo, noCv };
}

/** The two cells to write for one review result (same as buildRow). */
function reviewCells(ai) {
  if (!ai || !ai.result) return [ai && ai.skipped ? `Not reviewed: ${ai.skipped}` : '', ''];
  const r = ai.result;
  return [(r.red_flags || []).join('\n') || 'None', typeof r.average_years_per_job === 'number' ? r.average_years_per_job : ''];
}

async function main() {
  const { loadConfig } = require('../lib/config');
  const { createGoogleAuth } = require('../lib/google');
  const { createAnalyzer } = require('../lib/analyzer');
  const { createSheet } = require('../lib/sheet');
  const { sheets: sheetsApi } = require('@googleapis/sheets');
  const { drive: driveApi } = require('@googleapis/drive');

  const config = loadConfig();
  if (!config.sheetId) throw new Error('Set GOOGLE_SHEET_ID (in .env or the environment) first.');
  const apply = process.argv.includes('--apply');
  const limitAt = process.argv.indexOf('--limit');
  const limit = limitAt > -1 ? Number(process.argv[limitAt + 1]) : Infinity;

  const auth = createGoogleAuth(config);
  const sheets = sheetsApi({ version: 'v4', auth });
  const drive = driveApi({ version: 'v3', auth });
  const spreadsheetId = config.sheetId;

  const last = LETTER('Average years per job');
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TAB}!A2:${last}`,
    valueRenderOption: 'FORMULA',
  });
  const { todo, noCv } = planReviews(data.values);
  const batch = todo.slice(0, limit);

  for (const t of batch) console.log(`row ${t.row}: ${t.name} (${t.position || 'no position'})`);
  if (noCv.length) console.log(`No CV link, skipped: rows ${noCv.join(', ')}`);
  console.log(`\n${batch.length} to review (about US$${(batch.length * 0.05).toFixed(2)}).`);
  if (!batch.length) return;
  if (!apply) return console.log('Dry run: nothing reviewed or written. Run again with --apply.');

  const analyzer = createAnalyzer(config);
  if (!analyzer) throw new Error('Set ANTHROPIC_API_KEY (in .env or the environment) first.');
  const sheet = createSheet(config);

  let done = 0;
  for (const t of batch) {
    try {
      const { data: meta } = await drive.files.get({ fileId: t.fileId, fields: 'name', supportsAllDrives: true });
      const ext = String(meta.name).split('.').pop().toLowerCase();
      const { data: bytes } = await drive.files.get(
        { fileId: t.fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      const requirements = await sheet.getRequirements(t.position).catch(() => '');
      const ai = await analyzer.analyze({
        buffer: Buffer.from(bytes),
        ext,
        position: t.position,
        requirements,
        otherInterest: t.otherInterest,
      });
      const cells = reviewCells(ai);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${TAB}!${LETTER('Red flags')}${t.row}:${last}${t.row}`,
        valueInputOption: 'RAW',
        requestBody: { values: [cells] },
      });
      done += 1;
      console.log(`row ${t.row}: ${String(cells[0]).replace(/\n/g, ' | ')}`);
    } catch (err) {
      console.error(`row ${t.row}: failed, left blank (${err.message || err})`);
    }
  }
  console.log(`\nReviewed ${done} of ${batch.length}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { planReviews, reviewCells, driveFileId };
