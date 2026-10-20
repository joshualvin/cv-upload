'use strict';

// Runs on the server shortly after start-up and catches up, one row at a time:
// - applications from before the "Red flags" column: every row whose Red flags
//   cell is empty and that has a CV link gets only those two cells written;
// - staff uploads saved while the AI was off ("Waiting for AI"): the CV is read
//   in full, name / email / phone and the whole review are filled in, and the
//   Drive file gets its proper name;
// - rows whose AI status a recruiter set to "Review again": the review is done
//   again, and only the AI's own columns are rewritten.
// Rows already done say "None" or list their flags, so a restart only picks up
// what is left.

const { HEADERS, buildRow } = require('./sheet');
const { buildFileName } = require('./validate');
const { WAITING_FOR_AI, REVIEW_AGAIN, fileDetails, contactFromCv } = require('./details');

const COL = (name) => HEADERS.indexOf(name);

/** Drive file ID from the CV cell (a HYPERLINK formula or a plain link). */
function driveFileId(value) {
  const text = String(value || '');
  const m = text.match(/\/file\/d\/([\w-]+)/) || text.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : '';
}

/**
 * values = applicant rows from row 2 down, with formulas.
 * Returns { todo: [{ row, name, position, otherInterest, source, waiting, redo, fileId, cells }], noCv: [row] }.
 */
function planReviews(values = []) {
  const todo = [];
  const noCv = [];
  values.forEach((cells, i) => {
    const row = i + 2;
    const get = (name) => String(cells[COL(name)] ?? '').trim().replace(/^'/, '');
    if (!cells.some((c) => String(c ?? '').trim())) return; // empty row
    const redo = get('AI status') === REVIEW_AGAIN;
    if (get('Red flags') && !redo) return; // already reviewed
    const fileId = driveFileId(get('CV'));
    if (!fileId) return noCv.push(row);
    todo.push({
      row,
      name: get('Name'),
      position: get('Position'),
      otherInterest: get('Other role interest'),
      source: get('Source'),
      waiting: get('AI status') === WAITING_FOR_AI,
      redo,
      fileId,
      cells: HEADERS.map((h) => String(cells[COL(h)] ?? '').trim()),
    });
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
      const { buffer, name, description = '' } = await storage.download(t.fileId);
      const ext = String(name).split('.').pop().toLowerCase();
      const requirements = await sheet.getRequirements(t.position).catch(() => '');
      const ai = await analyzer.analyze({ buffer, ext, position: t.position, requirements, otherInterest: t.otherInterest });
      if (t.waiting) await completeWaiting(t, ai, { name, description, ext });
      else if (t.redo) await reviewAgain(t, ai);
      else await sheet.writeReview(t.row, reviewCells(ai));
      reviewed += 1;
      log.log(`[review-existing] row ${t.row} (${t.name}): done`);
    } catch (err) {
      // Left as it is, so the next start-up tries again.
      log.error(`[review-existing] row ${t.row} (${t.name}): ${String(err.message || err).slice(0, 200)}`);
    }
  }

  /** A staff upload saved without the AI: fill in the applicant and the whole review. */
  async function completeWaiting(t, ai, file) {
    const original = (file.description.match(/^Original file: (.+)$/m) || [])[1] || file.name;
    const stem = original.replace(/\.[^.]+$/, '');
    const day = (file.name.match(/^\d{4}-\d{2}-\d{2}/) || [])[0];
    const submittedAt = day ? new Date(`${day}T12:00:00Z`) : new Date();
    // What the AI read, else what the row already had (filled in by hand or from a list).
    const read = contactFromCv(ai && ai.result, stem);
    const had = (h) => ((t.cells || [])[COL(h)] || '').replace(/^'/, '');
    const unread = /^\((menunggu AI|nama tidak terbaca)\)/;
    const contact = {
      name: unread.test(read.name) && had('Name') && !unread.test(had('Name')) ? had('Name') : read.name,
      email: read.email || had('Email'),
      phone: read.phone || had('Phone'),
      social: had('Social media'), // the CV's links are added to these by buildRow
    };
    const data = { position: t.position, otherInterest: t.otherInterest, source: t.source || 'Offline', ...contact };
    const status = ai.skipped || `Analysed by ${ai.model || analyzer.model}`;
    const values = buildRow({ submittedAt, data, cvLink: '' }, ai, status);
    values[COL('Red flags')] = reviewCells(ai)[0];
    // Submitted, CV and the staff's choices (position, source) stay as they are,
    // and so does anything already filled in (by hand, or from a registration
    // list) that the AI found nothing for, e.g. an email the CV does not show.
    const keep = ['Submitted', 'CV', 'Position', 'Other role interest', 'Source'];
    const write = HEADERS.filter((h, i) => {
      if (keep.includes(h)) return false;
      const before = (t.cells || [])[i] || '';
      const after = String(values[i] ?? '').trim();
      const aiFoundNothing = !after || (h === 'Name' && unread.test(after));
      return !(aiFoundNothing && before && !unread.test(before));
    });
    await sheet.updateRow(t.row, values, write);
    await storage.rename(t.fileId, {
      fileName: buildFileName(data, file.ext, submittedAt),
      ...fileDetails(data, submittedAt, original, 'offline'),
    });
  }

  /**
   * A row marked "Review again": rewrite the AI's own columns only. The
   * applicant's details (name, contact, social media, position, source) and
   * the Drive file stay as they are.
   */
  async function reviewAgain(t, ai) {
    const had = (h) => ((t.cells || [])[COL(h)] || '').replace(/^'/, '');
    const data = { name: had('Name'), email: had('Email'), phone: had('Phone'), position: t.position, otherInterest: t.otherInterest, source: t.source };
    const status = ai.skipped || `Analysed by ${ai.model || analyzer.model}`;
    const values = buildRow({ submittedAt: new Date(), data, cvLink: '' }, ai, status);
    values[COL('Red flags')] = reviewCells(ai)[0];
    const keep = ['Submitted', 'CV', 'Name', 'Email', 'Phone', 'Social media', 'Position', 'Other role interest', 'Source'];
    // A field the AI finds nothing for keeps what the row had (e.g. a date of birth filled in by hand).
    const write = HEADERS.filter((h, i) => !keep.includes(h) && !(String(values[i] ?? '').trim() === '' && (t.cells || [])[i]));
    await sheet.updateRow(t.row, values, write);
  }

  log.log(`[review-existing] reviewed ${reviewed} of ${todo.length}`);
  return { reviewed, total: todo.length };
}

module.exports = { reviewExisting, planReviews, reviewCells, driveFileId };
