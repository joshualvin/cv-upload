'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createGoogleAuth } = require('./google');
const { EDUCATION_LEVELS } = require('./analyzer');

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
];

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
  ];
}

function googleSheet(config) {
  const { sheets: sheetsApi } = require('@googleapis/sheets');
  const sheets = sheetsApi({ version: 'v4', auth: createGoogleAuth(config) });
  const spreadsheetId = config.sheetId;
  let setup;
  let positionsCache = { at: 0, map: new Map() };

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
        const header = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${APPLICANTS}!A1:A1` });
        if (!header.data.values) {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${APPLICANTS}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [HEADERS] },
          });
        }
        if (missing.includes(POSITIONS)) {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${POSITIONS}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
              values: [
                ['Position', 'Requirements'],
                ['Sales Associate', 'Example: SPM or Diploma; 1+ year retail or customer service; speaks English and Malay'],
              ],
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
    async getRequirements(position) {
      if (!position) return '';
      if (Date.now() - positionsCache.at > 60 * 1000) {
        await ensureSetup();
        const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${POSITIONS}!A2:B` });
        const map = new Map();
        for (const [name, req] of data.values || []) {
          if (name && req) map.set(String(name).trim().toLowerCase(), String(req).trim());
        }
        positionsCache = { at: Date.now(), map };
      }
      return positionsCache.map.get(position.trim().toLowerCase()) || '';
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

module.exports = { createSheet, buildRow, cell, HEADERS };
