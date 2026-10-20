'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createGoogleAuth } = require('./google');
const { EDUCATION_LEVELS } = require('./analyzer');
const { normalize, splitLines } = require('./jobs');
const { slug } = require('./validate');

const APPLICANTS = 'Applicants';
const POSITIONS = 'Positions';

const HEADERS = [
  'Submitted',
  'Name',
  'Email',
  'Phone',
  'Position',
  'Match score',
  'Match reason',
  'Education level',
  'Education rank (0-6)',
  'Highest qualification',
  'Field of study',
  'Institution',
  'Total years experience',
  'Relevant years experience',
  'Current / last job title',
  'Current / last employer',
  'Skills',
  'Languages',
  'Certifications',
  'Summary',
  'CV',
  'AI status',
  'Other role interest',
  // New columns go at the end, so rows written before them stay aligned.
  'Red flags',
  'Average years per job',
];

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

/** One spreadsheet row for an applicant. `ai` is the analyzer output or null. */
function buildRow({ submittedAt, data, cvLink }, ai, status, timeZone = 'UTC') {
  const r = (ai && ai.result) || {};
  const level = r.education_level && r.education_level !== 'unknown' ? r.education_level : '';
  const link = cvLink && /^https:\/\//.test(cvLink) ? `=HYPERLINK("${cvLink.replace(/"/g, '')}","Open CV")` : cell(cvLink);
  return [
    formatDate(submittedAt, timeZone),
    cell(data.name),
    cell(data.email),
    cell(data.phone),
    cell(data.position),
    typeof r.match_score === 'number' ? r.match_score : '',
    cell(r.match_reason),
    cell(level),
    level ? EDUCATION_LEVELS.indexOf(level) - 1 : '',
    cell(r.highest_qualification),
    cell(r.field_of_study),
    cell(r.institution),
    typeof r.total_years_experience === 'number' ? r.total_years_experience : '',
    typeof r.relevant_years_experience === 'number' ? r.relevant_years_experience : '',
    cell(r.current_or_last_job_title),
    cell(r.current_or_last_employer),
    cell((r.skills || []).join(', ')),
    cell((r.languages || []).join(', ')),
    cell((r.certifications || []).join(', ')),
    cell(r.summary),
    link,
    cell(status),
    cell(data.otherInterest),
    // "None" marks a CV that was reviewed and had no flags; blank = not reviewed.
    ai && ai.result ? cell((r.red_flags || []).join('\n') || 'None') : '',
    typeof r.average_years_per_job === 'number' ? r.average_years_per_job : '',
  ];
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

  function ensureSetup() {
    if (!setup) {
      setup = (async () => {
        const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
        const titles = data.sheets.map((s) => s.properties.title);
        const missing = [APPLICANTS, POSITIONS].filter((t) => !titles.includes(t));
        if (missing.length) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
          });
        }
        // Header rows are rewritten on startup so new columns appear in older sheets.
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              { range: `${APPLICANTS}!A1`, values: [HEADERS] },
              { range: `${POSITIONS}!A1`, values: [POSITION_HEADERS] },
            ],
          },
        });
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
      return `Google Sheet (tabs "${APPLICANTS}" and "${POSITIONS}")`;
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
    async append(row) {
      await ensureSetup();
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${APPLICANTS}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
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

module.exports = { createSheet, buildRow, cell, parsePositions, parseJobs, HEADERS };
