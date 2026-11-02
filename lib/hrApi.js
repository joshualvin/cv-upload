'use strict';

// API for the company's HR system (WAU-HR): it reads and replaces the job
// openings in the Positions tab, lists applicants and downloads their CVs.
// Off until HR_API_TOKEN (at least 24 characters) is set; every call sends
// "Authorization: Bearer <token>".

const crypto = require('node:crypto');
const express = require('express');
const { HEADERS } = require('./sheet');

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** Bearer-token check; after 10 wrong tokens from one address it refuses for 15 minutes. */
function requireToken(token) {
  const want = crypto.createHash('sha256').update(token).digest();
  const failures = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const seen = failures.get(req.ip);
    if (seen && seen.reset > now && seen.count >= 10) return res.status(429).json({ error: 'Too many wrong tokens; try again in 15 minutes.' });
    const [scheme, given = ''] = String(req.get('authorization') || '').split(' ');
    const got = crypto.createHash('sha256').update(scheme === 'Bearer' ? given : '').digest();
    if (given && crypto.timingSafeEqual(want, got)) return next();
    const entry = seen && seen.reset > now ? seen : { count: 0, reset: now + 15 * 60 * 1000 };
    entry.count += 1;
    failures.set(req.ip, entry);
    res.status(401).json({ error: 'Wrong or missing HR API token.' });
  };
}

/** The Drive file ID in a CV cell (=HYPERLINK("https://drive.google.com/file/d/ID/view","Open CV")). */
function driveId(cvCell) {
  const m = String(cvCell || '').match(/\/d\/([\w-]{10,})|[?&]id=([\w-]{10,})/);
  return m ? m[1] || m[2] : '';
}

function num(value) {
  return value === '' || value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value);
}

/** Applicant rows (HEADERS order) as objects. `id` stays the same when the sheet is sorted. */
function applicantsFrom(rows) {
  const at = (row, name) => String(row[HEADERS.indexOf(name)] ?? '').replace(/^'/, '');
  return rows
    .map((row, i) => {
      const cvId = driveId(at(row, 'CV'));
      const name = at(row, 'Name');
      return {
        id: cvId || crypto.createHash('sha1').update(`${at(row, 'Submitted')}|${at(row, 'Email')}|${name}`).digest('hex').slice(0, 20),
        row: i + 2,
        submitted: at(row, 'Submitted'),
        name,
        email: at(row, 'Email'),
        phone: at(row, 'Phone'),
        position: at(row, 'Position'),
        otherInterest: at(row, 'Other role interest'),
        source: at(row, 'Source'),
        matchScore: num(at(row, 'Match score')),
        matchReason: at(row, 'Match reason'),
        redFlags: at(row, 'Red flags'),
        summary: at(row, 'Summary'),
        age: num(at(row, 'Age')),
        education: [at(row, 'Highest qualification'), at(row, 'Field of study'), at(row, 'Institution')].filter(Boolean).join(', '),
        experience: num(at(row, 'Total years experience')),
        lastJob: [at(row, 'Current / last job title'), at(row, 'Current / last employer')].filter(Boolean).join(' – '),
        aiStatus: at(row, 'AI status'),
        cvId,
      };
    })
    .filter((a) => a.name);
}

/** A position from the HR system, checked and trimmed to what the sheet holds. */
function positionFrom(p) {
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const name = text(p && p.name, 100);
  if (!name) return null;
  return {
    name,
    requirements: text(p.requirements, 3000),
    open: p.open !== false,
    department: text(p.department, 60),
    location: text(p.location, 60),
    type: text(p.type, 40),
    description: text(p.description, 2000),
    responsibilities: text(p.responsibilities, 3000),
  };
}

function createHrApi({ token, sheet, storage }) {
  const router = express.Router();
  router.use(requireToken(token));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!sheet || !sheet.readPositionRows) return res.status(503).json({ error: 'No Google Sheet connected (GOOGLE_SHEET_ID).' });
    next();
  });

  router.get('/positions', async (req, res, next) => {
    try {
      res.json({ positions: await sheet.readPositionRows() });
    } catch (err) {
      next(err);
    }
  });

  // Replaces every opening in the Positions tab with the list sent.
  router.put('/positions', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const sent = req.body && Array.isArray(req.body.positions) ? req.body.positions : null;
      if (!sent) return res.status(400).json({ error: 'Send { "positions": [...] }.' });
      const positions = sent.map(positionFrom).filter(Boolean);
      const names = new Set();
      for (const p of positions) {
        const key = p.name.toLowerCase();
        if (names.has(key)) return res.status(400).json({ error: `Position "${p.name}" is listed twice.` });
        names.add(key);
      }
      await sheet.writePositions(positions);
      res.json({ ok: true, written: positions.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/applicants', async (req, res, next) => {
    try {
      res.json({ applicants: applicantsFrom(await sheet.readApplicants()) });
    } catch (err) {
      next(err);
    }
  });

  // Only CVs listed in the Applicants tab, not any file the Google account can reach.
  router.get('/cv/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!applicantsFrom(await sheet.readApplicants()).some((a) => a.cvId === id)) return res.status(404).json({ error: 'No applicant has this CV.' });
      const file = await storage.download(id);
      const ext = (file.name.match(/\.(\w+)$/) || [])[1];
      res.type(MIME[String(ext).toLowerCase()] || 'application/octet-stream');
      res.attachment(file.name);
      res.send(file.buffer);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createHrApi, applicantsFrom, positionFrom, driveId };
