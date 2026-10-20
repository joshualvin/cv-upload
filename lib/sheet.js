'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createGoogleAuth } = require('./google');
const { EDUCATION_LEVELS } = require('./analyzer');
const { normalize, splitLines } = require('./jobs');
const { slug } = require('./validate');

const APPLICANTS = 'Applicants';
const POSITIONS = 'Positions';

// The app finds each column by its header name, so the columns can be moved
// around in the sheet freely. This order is used for a new sheet, and a
// header missing from an existing sheet is added at the end of row 1.
// Read left to right: who, for what, the verdict, how to reach them, then details.
const HEADERS = [
  'Submitted',
  'Name',
  'Position',
  'Other role interest',
  'Source',
  'Match score',
  'Match reason',
  'Red flags',
  'Summary',
  'CV',
  'Phone',
  'Email',
  // For the records (and background checks); the AI review does not use them.
  'Social media',
  'Date of birth',
  // Age when they applied: exact from the date of birth, else estimated from school years.
  'Age',
  'Age basis',
  'Religion',
  'Current / last job title',
  'Current / last employer',
  'Total years experience',
  'Relevant years experience',
  'Average years per job',
  'Education level',
  'Highest qualification',
  'Field of study',
  'Institution',
  'Skills',
  'Languages',
  'Certifications',
  'Education rank (0-6)',
  'AI status',
];

/** 0 -> A, 25 -> Z, 26 -> AA */
function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Put a row given in HEADERS order into the sheet's own column order. */
function arrangeRow(row, sheetHeader) {
  const byName = new Map(HEADERS.map((h, i) => [h, row[i]]));
  return sheetHeader.map((h) => (byName.has(h) ? byName.get(h) : ''));
}

/** Turn sheet rows (in the sheet's column order) into HEADERS order. */
function rowsByHeaders(values, sheetHeader) {
  const at = HEADERS.map((h) => sheetHeader.indexOf(h));
  return values.map((cells) => at.map((i) => (i < 0 ? '' : cells[i] ?? '')));
}

// Columns D onwards only feed the public careers page.
const POSITION_HEADERS = [
  'Position',
  'Requirements',
  'Open (yes/no)',
  'Department',
  'Location',
  'Employment type',
  'Description',
  'Responsibilities',
];

/**
 * Turn Positions-tab rows into [{ name, requirements, open }]. Rows whose
 * requirements start with "Example:" are the starter row and are ignored.
 */
function parsePositions(rows = []) {
  const list = [];
  for (const [name = '', requirements = '', open = ''] of rows) {
    const n = String(name).trim();
    const r = String(requirements).trim();
    if (!n || /^example:/i.test(r)) continue;
    list.push({ name: n.slice(0, 100), requirements: r, open: !/^(no|n|closed|false|0)$/i.test(String(open).trim()) });
  }
  return list;
}

/**
 * Turn Positions-tab rows into open job listings for the careers page.
 * Requirements and responsibilities are split on new lines or semicolons.
 */
function parseJobs(rows = []) {
  const jobs = [];
  const ids = new Set();
  for (const row of rows) {
    const [name = '', requirements = '', open = '', department, location, type, summary, responsibilities] = row;
    const [position] = parsePositions([[name, requirements, open]]);
    if (!position || !position.open) continue;
    let id = slug(position.name).toLowerCase() || `job-${jobs.length + 1}`;
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const job = normalize(
      {
        id,
        title: position.name,
        department,
        location,
        type,
        summary,
        responsibilities: splitLines(responsibilities),
        requirements: splitLines(requirements),
      },
      jobs.length
    );
    if (job) jobs.push(job);
  }
  return jobs;
}

/** Stop text that starts with = + - @ being run as a spreadsheet formula. */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function formatDate(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Age on the day of applying: exact from a YYYY-MM-DD date of birth, else from
 * the AI's birth-year estimate (education dates). Returns { age, basis } or null.
 */
function ageAt(result, submittedAt = new Date()) {
  const r = result || {};
  const dob = String(r.candidate_birth_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const on = new Date(submittedAt);
  if (dob) {
    const [y, m, d] = dob.slice(1).map(Number);
    const birthdayPassed = on.getMonth() + 1 > m || (on.getMonth() + 1 === m && on.getDate() >= d);
    const age = on.getFullYear() - y - (birthdayPassed ? 0 : 1);
    if (age > 10 && age < 100) return { age, basis: 'Date of birth' };
  }
  const year = Number(r.estimated_birth_year);
  if (Number.isInteger(year) && year > 1900) {
    const age = on.getFullYear() - year;
    if (age > 10 && age < 100) {
      return { age, basis: `Estimated${r.estimated_birth_year_basis ? `: ${r.estimated_birth_year_basis}` : ' from school years'}` };
    }
  }
  return null;
}

/** Columns whose text gets clickable links. */
const LINKED = ['Phone', 'Email', 'Social media'];

const SITES = 'instagram\\.com|linkedin\\.com|tiktok\\.com|facebook\\.com|fb\\.com|x\\.com|twitter\\.com|youtube\\.com|github\\.com|behance\\.net|dribbble\\.com|t\\.me';
const URL_RE = new RegExp(`(?:https?://\\S+|(?:www\\.)?(?:${SITES})/[^\\s()]+)`, 'i');

/** The link in one line of the Social media cell: { start, end, uri } or null. */
function socialLink(line) {
  const url = line.match(URL_RE);
  if (url) {
    const text = url[0].replace(/[.,;]+$/, '');
    return { start: url.index, end: url.index + text.length, uri: /^https?:\/\//i.test(text) ? text : `https://${text}` };
  }
  const handle = line.match(/@([A-Za-z0-9._]{2,30})/);
  if (!handle) return null;
  const name = handle[1].replace(/\.+$/, '');
  const site = /tiktok/i.test(line) ? `https://www.tiktok.com/@${name}` : /\b(twitter|x\.com|X:)/i.test(line) ? `https://x.com/${name}` : `https://www.instagram.com/${name}`;
  return { start: handle.index, end: handle.index + 1 + name.length, uri: site };
}

/**
 * Links for the text of a Phone, Email or Social media cell: [{ start, end, uri }].
 * A mobile number opens WhatsApp; other numbers are a phone link.
 */
function contactLinks(column, value) {
  const text = String(value || '').replace(/^'/, '');
  if (!text.trim()) return [];
  if (column === 'Phone') {
    const digits = text.replace(/[^\d]/g, '');
    // WhatsApp only for mobile numbers (62 8..., 08...); landlines get a phone link.
    const wa = /^628\d{8,12}$/.test(digits) ? digits : /^08\d{8,12}$/.test(digits) ? `62${digits.slice(1)}` : '';
    if (!wa && digits.length < 6) return [];
    return [{ start: 0, end: text.length, uri: wa ? `https://wa.me/${wa}` : `tel:${text.replace(/[^\d+]/g, '')}` }];
  }
  if (column === 'Email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim()) ? [{ start: 0, end: text.length, uri: `mailto:${text.trim()}` }] : [];
  }
  const links = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const link = socialLink(line);
    if (link) links.push({ start: at + link.start, end: at + link.end, uri: link.uri });
    at += line.length + 1;
  }
  return links;
}

/** A Sheets cell with its text and the links as rich-text runs. */
function linkedCell(text, links) {
  const runs = [];
  for (const { start, end, uri } of links) {
    if (start > 0 && !runs.length) runs.push({ startIndex: 0, format: {} });
    runs.push({ startIndex: start, format: { link: { uri } } });
    if (end < text.length) runs.push({ startIndex: end, format: {} });
  }
  const seen = new Set();
  return {
    userEnteredValue: { stringValue: text },
    textFormatRuns: runs.filter((r) => !seen.has(r.startIndex) && seen.add(r.startIndex)),
  };
}

/** The handles the applicant gave (form, or already in the sheet), then any others the CV lists, one per line. */
function socialLinks(fromForm, fromCv = []) {
  const all = [fromForm, ...(fromCv || [])]
    .flatMap((x) => String(x || '').replace(/^'/, '').split('\n'))
    .map((x) => x.trim())
    .filter(Boolean);
  const key = (x) => x.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/^@/, '').replace(/\/+$/, '');
  return all.filter((x, i) => all.findIndex((y) => key(y) === key(x)) === i).join('\n');
}

/** One spreadsheet row for an applicant. `ai` is the analyzer output or null. */
function buildRow({ submittedAt, data, cvLink }, ai, status, timeZone = 'UTC') {
  const r = (ai && ai.result) || {};
  const level = r.education_level && r.education_level !== 'unknown' ? r.education_level : '';
  const link = cvLink && /^https:\/\//.test(cvLink) ? `=HYPERLINK("${cvLink.replace(/"/g, '')}","Open CV")` : cell(cvLink);
  const age = ageAt(r, submittedAt);
  const cells = {
    Submitted: formatDate(submittedAt, timeZone),
    Name: cell(data.name),
    Email: cell(data.email),
    'Social media': cell(socialLinks(data.social, r.candidate_social_links)),
    'Date of birth': cell(r.candidate_birth_date),
    Age: age ? age.age : '',
    'Age basis': age ? cell(age.basis) : '',
    Religion: cell(r.candidate_religion),
    Phone: cell(data.phone),
    Position: cell(data.position),
    'Match score': typeof r.match_score === 'number' ? r.match_score : '',
    'Match reason': cell(r.match_reason),
    'Education level': cell(level),
    'Education rank (0-6)': level ? EDUCATION_LEVELS.indexOf(level) - 1 : '',
    'Highest qualification': cell(r.highest_qualification),
    'Field of study': cell(r.field_of_study),
    Institution: cell(r.institution),
    'Total years experience': typeof r.total_years_experience === 'number' ? r.total_years_experience : '',
    'Relevant years experience': typeof r.relevant_years_experience === 'number' ? r.relevant_years_experience : '',
    'Current / last job title': cell(r.current_or_last_job_title),
    'Current / last employer': cell(r.current_or_last_employer),
    Skills: cell((r.skills || []).join(', ')),
    Languages: cell((r.languages || []).join(', ')),
    Certifications: cell((r.certifications || []).join(', ')),
    Summary: cell(r.summary),
    CV: link,
    'AI status': cell(status),
    'Other role interest': cell(data.otherInterest),
    Source: cell(data.source || 'Online'),
    // "None" marks a CV that was reviewed and had no flags; blank = not reviewed.
    'Red flags': ai && ai.result ? cell((r.red_flags || []).join('\n') || 'None') : '',
    'Average years per job': typeof r.average_years_per_job === 'number' ? r.average_years_per_job : '',
  };
  return HEADERS.map((h) => cells[h]);
}

function googleSheet(config) {
  const { sheets: sheetsApi } = require('@googleapis/sheets');
  const sheets = sheetsApi({ version: 'v4', auth: createGoogleAuth(config) });
  const spreadsheetId = config.sheetId;
  let setup;
  let positionsCache = { at: 0, list: [], jobs: [] };

  async function readPositions() {
    if (Date.now() - positionsCache.at > 60 * 1000) {
      await ensureSetup();
      const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${POSITIONS}!A2:H` });
      positionsCache = { at: Date.now(), list: parsePositions(data.values), jobs: parseJobs(data.values) };
    }
    return positionsCache.list;
  }

  /** Row 1 of Applicants, trailing blanks removed. */
  async function readHeader() {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${APPLICANTS}!1:1` });
    const row = ((data.values || [])[0] || []).map((h) => String(h).trim());
    while (row.length && !row[row.length - 1]) row.pop();
    return row;
  }

  function ensureSetup() {
    if (!setup) {
      setup = (async () => {
        const { data } = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets.properties(title,sheetId,gridProperties.columnCount)',
        });
        const titles = data.sheets.map((s) => s.properties.title);
        const missing = [APPLICANTS, POSITIONS].filter((t) => !titles.includes(t));
        if (missing.length) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: missing.map((title) => ({
                addSheet: {
                  properties: title === APPLICANTS ? { title, gridProperties: { columnCount: Math.max(26, HEADERS.length + 4) } } : { title },
                },
              })),
            },
          });
        }
        // Applicants: keep the sheet's own column order and add any missing
        // header at the end. Positions is read by position, so its header is fixed.
        const current = await readHeader();
        const absent = HEADERS.filter((h) => !current.includes(h));
        // A new sheet has 26 columns (A-Z); widen it when the headers need more.
        const tab = data.sheets.find((t) => t.properties.title === APPLICANTS);
        const have = tab && tab.properties.gridProperties ? tab.properties.gridProperties.columnCount : Infinity;
        const need = current.length + absent.length;
        if (tab && need > have) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', length: need - have } }] },
          });
        }
        const writes = [{ range: `${POSITIONS}!A1`, values: [POSITION_HEADERS] }];
        if (absent.length) writes.push({ range: `${APPLICANTS}!${columnLetter(current.length)}1`, values: [absent] });
        await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: writes } });
        if (missing.includes(POSITIONS)) {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${POSITIONS}!A2`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [['Sales Associate', 'Example: Diploma or higher; 1+ year retail or customer service', 'yes']],
            },
          });
        }
        return data;
      })();
      setup.catch(() => (setup = null));
    }
    return setup;
  }

  return {
    async check() {
      await ensureSetup();
      return `Google Sheet (tabs "${APPLICANTS}" and "${POSITIONS}"; columns matched by name)`;
    },
    async listPositions() {
      return (await readPositions()).filter((p) => p.open).map((p) => p.name);
    },
    async listJobs() {
      await readPositions();
      return positionsCache.jobs;
    },
    async getRequirements(position) {
      if (!position) return '';
      const key = position.trim().toLowerCase();
      const match = (await readPositions()).find((p) => p.name.toLowerCase() === key);
      return match ? match.requirements : '';
    },
    /** Applicant rows from row 2 down in HEADERS order, with formulas (the CV cell is a HYPERLINK). */
    async readApplicants() {
      await ensureSetup();
      const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: APPLICANTS, valueRenderOption: 'FORMULA' });
      const [header = [], ...rows] = data.values || [];
      return rowsByHeaders(rows, header.map((h) => String(h).trim()));
    },
    /**
     * Rewrite the cells of one row named in `names` from a row in HEADERS order
     * (as buildRow makes it). Other cells, including the recruiter's own
     * columns, are left alone.
     */
    async updateRow(row, values, names) {
      await ensureSetup();
      const header = await readHeader();
      const data = names
        .filter((name) => header.includes(name))
        .map((name) => ({ range: `${APPLICANTS}!${columnLetter(header.indexOf(name))}${row}`, values: [[values[HEADERS.indexOf(name)]]] }));
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data } });
    },
    /** Write the Red flags and Average years per job cells of one row. */
    async writeReview(row, [flags, average]) {
      await ensureSetup();
      const header = await readHeader();
      const at = (name) => `${APPLICANTS}!${columnLetter(header.indexOf(name))}${row}`;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: at('Red flags'), values: [[flags]] },
            { range: at('Average years per job'), values: [[average]] },
          ],
        },
      });
    },
    async append(row) {
      await ensureSetup();
      const { data } = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${APPLICANTS}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [arrangeRow(row, await readHeader())] },
      });
      // e.g. "Applicants!A9:AC9"
      const added = Number(((data.updates && data.updates.updatedRange) || '').match(/![A-Z]+(\d+)/)?.[1]);
      if (added) await this.linkContacts([added]).catch((err) => console.warn(`[sheet] links: ${err.message}`));
    },
    /** Make the Phone, Email and Social media cells of these rows clickable. */
    async linkContacts(rowNumbers) {
      await ensureSetup();
      const header = await readHeader();
      const { data: meta } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(title,sheetId)' });
      const tab = meta.sheets.find((t) => t.properties.title === APPLICANTS);
      const requests = [];
      for (const row of rowNumbers) {
        const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${APPLICANTS}!${row}:${row}` });
        const cells = (data.values || [])[0] || [];
        for (const name of LINKED) {
          const col = header.indexOf(name);
          const text = String(cells[col] ?? '');
          const links = col < 0 ? [] : contactLinks(name, text);
          if (!links.length) continue;
          requests.push({
            updateCells: {
              range: { sheetId: tab.properties.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 },
              rows: [{ values: [linkedCell(text, links)] }],
              fields: 'userEnteredValue,textFormatRuns',
            },
          });
        }
      }
      if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
      return requests.length;
    },
  };
}

/** Local stand-in for testing without Google: appends rows to a JSON-lines file. */
function localSheet(config) {
  const file = path.resolve(config.localUploadDir, 'applicants.jsonl');
  return {
    async check() {
      return `local file ${file}`;
    },
    async listPositions() {
      return config.positions || [];
    },
    async getRequirements(position) {
      return (config.localRequirements || {})[String(position || '').toLowerCase()] || '';
    },
    async append(row) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const record = Object.fromEntries(HEADERS.map((h, i) => [h, row[i]]));
      await fs.appendFile(file, JSON.stringify(record) + '\n');
    },
  };
}

function createSheet(config) {
  if (config.driveMode === 'local') return localSheet(config);
  if (!config.sheetId) return null;
  return googleSheet(config);
}

module.exports = { createSheet, buildRow, cell, socialLinks, ageAt, contactLinks, linkedCell, parsePositions, parseJobs, arrangeRow, rowsByHeaders, columnLetter, HEADERS };
