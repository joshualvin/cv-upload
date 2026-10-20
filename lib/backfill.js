'use strict';

// Reviews applications that came in before the "Red flags" and "Average years
// per job" columns existed. Runs on the server shortly after start-up: every
// row whose Red flags cell is empty and that has a CV link is reviewed, one at
// a time, and only those two cells are written. Rows already reviewed say
// "None" or list their flags, so a restart only picks up what is left.

const { HEADERS } = require('./sheet');

const COL = (name) => HEADERS.indexOf(name);

/** Drive file ID from the CV cell (a HYPERLINK formula or a plain link). */
function driveFileId(value) {
  const text = String(value || '');
  const m = text.match(/\/file\/d\/([\w-]+)/) || text.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : '';
}

/**
 * values = applicant rows from row 2 down, with formulas.
 * Returns { todo: [{ row, name, position, otherInterest, fileId }], noCv: [row] }.
 */
function planReviews(values = []) {
  const todo = [];
  const noCv = [];
  values.forEach((cells, i) => {
    const row = i + 2;
    const get = (name) => String(cells[COL(name)] ?? '').trim().replace(/^'/, '');
    if (!cells.some((c) => String(c ?? '').trim())) return; // empty row
    if (get('Red flags')) return; // already reviewed
    const fileId = driveFileId(get('CV'));
    if (!fileId) return noCv.push(row);
    todo.push({ row, name: get('Name'), position: get('Position'), otherInterest: get('Other role interest'), fileId });
  });
  return { todo, noCv };
}

/** The Red flags and Average years per job cells for one review (as buildRow writes them). */
function reviewCells(ai) {
  if (!ai || !ai.result) return [ai && ai.skipped ? `Not reviewed: ${ai.skipped}` : '', ''];
  const r = ai.result;
  return [(r.red_flags || []).join('\n') || 'None', typeof r.average_years_per_job === 'number' ? r.average_years_per_job : ''];
}

async function reviewExisting({ analyzer, sheet, storage, log = console }) {
  if (!analyzer || !sheet || !sheet.readApplicants || !storage || !storage.download) return { reviewed: 0, total: 0 };
  const { todo, noCv } = planReviews(await sheet.readApplicants());
  if (noCv.length) log.log(`[review-existing] no CV link, skipped rows ${noCv.join(', ')}`);
  if (!todo.length) return { reviewed: 0, total: 0 };
  log.log(`[review-existing] reviewing ${todo.length} earlier application(s) for red flags`);

  let reviewed = 0;
  for (const t of todo) {
    try {
      const { buffer, name } = await storage.download(t.fileId);
      const requirements = await sheet.getRequirements(t.position).catch(() => '');
      const ai = await analyzer.analyze({
        buffer,
        ext: String(name).split('.').pop().toLowerCase(),
        position: t.position,
        requirements,
        otherInterest: t.otherInterest,
      });
      await sheet.writeReview(t.row, reviewCells(ai));
      reviewed += 1;
      log.log(`[review-existing] row ${t.row} (${t.name}): done`);
    } catch (err) {
      // Left blank, so the next start-up tries again.
      log.error(`[review-existing] row ${t.row} (${t.name}): ${String(err.message || err).slice(0, 200)}`);
    }
  }
  log.log(`[review-existing] reviewed ${reviewed} of ${todo.length}`);
  return { reviewed, total: todo.length };
}

module.exports = { reviewExisting, planReviews, reviewCells, driveFileId };
