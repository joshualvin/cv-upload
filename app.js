'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const { createJobs } = require('./lib/jobs');
const { rateLimit } = require('./lib/rateLimit');
const { OTHER_POSITION, ALLOWED_EXTENSIONS, detectFileType, validateFields, buildFileName } = require('./lib/validate');

// Drive appProperties allow at most 124 bytes per key + value.
function fitBytes(key, value) {
  let v = String(value || '');
  while (Buffer.byteLength(key + v) > 124) v = v.slice(0, -1);
  return v;
}

// Turn Google API errors into a short, actionable message.
function describeError(err) {
  const google = err.response && err.response.data && err.response.data.error;
  const detail = (google && (google.message || google.error_description || google)) || err.message;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (/invalid_grant/i.test(text)) {
    return `${text}: the refresh token is invalid or expired. Run "npm run get-token" again with the same client ID/secret.`;
  }
  if (/invalid_client|unauthorized_client/i.test(text)) {
    return `${text}: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are wrong, or the refresh token came from a different client.`;
  }
  if (/not been used|is disabled/i.test(text)) return `${text}: enable the Google Drive API in Google Cloud Console.`;
  if (/File not found/i.test(text)) {
    return `${text}: check DRIVE_FOLDER_ID, and that the signed-in Google account can access that folder.`;
  }
  return text;
}

// Load an HTML page and stamp its CSS/JS/PNG links with a hash of each file.
// Some CDNs (e.g. Hostinger's) strip Cache-Control from static files, and
// Safari then keeps serving an old stylesheet; a new URL per deploy avoids that.
// The hashes go into `versions`, so only a current URL is cached for a year.
// The public settings go into the page as JSON, which saves phones a request.
function loadPage(publicDir, name, versions, siteConfig) {
  const json = JSON.stringify(siteConfig).replace(/</g, '\\u003c');
  return fs
    .readFileSync(path.join(publicDir, name), 'utf8')
    .replace(/(href|src)="\/([\w-]+\.(?:css|js|png))"/g, (match, attr, file) => {
      const target = path.join(publicDir, file);
      if (!fs.existsSync(target)) return match;
      const hash = crypto.createHash('sha1').update(fs.readFileSync(target)).digest('hex').slice(0, 10);
      versions[file] = hash;
      return `${attr}="/${file}?v=${hash}"`;
    })
    .replace('</head>', `  <script type="application/json" id="site-config">${json}</script>\n</head>`);
}

const YEAR = 'public, max-age=31536000, immutable';

function createApp(config, storage, { analyzer = null, sheet = null, processor = null } = {}) {
  const app = express();
  const getJobs = createJobs(config.jobsFile);
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  const siteConfig = {
    companyName: config.companyName,
    companyUrl: config.companyUrl,
    maxFileMb: config.maxFileMb,
    allowedExtensions: ALLOWED_EXTENSIONS,
  };
  const publicDir = path.join(__dirname, 'public');
  const versions = {};
  const pages = Object.fromEntries(
    ['jobs.html', 'apply.html', 'qr.html'].map((n) => [n, loadPage(publicDir, n, versions, siteConfig)])
  );
  const sendPage = (res, name) => res.type('html').set('Cache-Control', 'no-cache').send(pages[name]);
  app.get('/', (req, res) => {
    // QR codes printed before the job board existed point at /?position=...
    if (req.query.position) {
      const position = String(req.query.position).trim().slice(0, 100);
      return res.redirect(302, `/apply?position=${encodeURIComponent(position)}`);
    }
    sendPage(res, 'jobs.html');
  });
  app.get('/apply', (req, res) => sendPage(res, 'apply.html'));
  app.get('/qr', (req, res) => sendPage(res, 'qr.html'));
  app.use(
    express.static(publicDir, {
      index: false,
      // Versioned files and fonts (version in the file name) never change at
      // their URL; everything else is checked again on each visit.
      setHeaders: (res, filePath) => {
        const file = path.relative(publicDir, filePath).split(path.sep).join('/');
        const current = versions[file] && res.req.query.v === versions[file];
        res.set('Cache-Control', current || file.startsWith('fonts/') ? YEAR : 'no-cache');
      },
    })
  );

  function uploadUrl(req) {
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const position = String(req.query.position || '').trim().slice(0, 100);
    // A general QR opens the job board; a position QR goes straight to the form.
    return position ? `${base}/apply?position=${encodeURIComponent(position)}` : `${base}/`;
  }

  app.get('/api/config', (req, res) => res.json(siteConfig));

  // Dropdown options: open positions from the sheet, else the POSITIONS setting.
  app.get('/api/positions', async (req, res) => {
    let positions = [];
    // "source" and "error" make setup problems visible when opening this URL directly.
    const result = { source: sheet ? 'sheet' : 'off (no GOOGLE_SHEET_ID)' };
    try {
      positions = sheet ? await sheet.listPositions() : [];
    } catch (err) {
      result.error = describeError(err);
      console.warn(`[positions] ${result.error}`);
    }
    if (!positions.length && (config.positions || []).length) {
      positions = config.positions;
      result.source = 'POSITIONS setting';
    }
    res.set('Cache-Control', 'no-store').json({ positions, other: OTHER_POSITION, ...result });
  });

  // Openings come from the sheet's Positions tab when one is connected,
  // otherwise from the JSON file (handy for local testing).
  app.get('/api/jobs', async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    if (!sheet || !sheet.listJobs) return res.json({ jobs: getJobs(), source: 'file' });
    try {
      res.json({ jobs: await sheet.listJobs(), source: 'sheet' });
    } catch (err) {
      const error = describeError(err);
      console.warn(`[jobs] ${error}`);
      res.status(502).json({ jobs: [], source: 'sheet', error });
    }
  });

  app.get('/api/qr-link', (req, res) => res.json({ url: uploadUrl(req) }));

  app.get('/qr.svg', async (req, res, next) => {
    try {
      const svg = await QRCode.toString(uploadUrl(req), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (err) {
      next(err);
    }
  });

  app.get('/qr.png', async (req, res, next) => {
    try {
      const png = await QRCode.toBuffer(uploadUrl(req), { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
      res.type('image/png').set('Cache-Control', 'no-store');
      if (req.query.download) res.attachment('cv-upload-qr.png');
      res.send(png);
    } catch (err) {
      next(err);
    }
  });

  // Checks the storage connection for real, so setup problems show up here
  // instead of only as a failed upload.
  app.get('/healthz', async (req, res) => {
    if (storage.error) return res.status(503).json({ ok: false, error: storage.error });
    const report = { ok: true, ai: analyzer ? `on (${analyzer.model})` : 'off (no ANTHROPIC_API_KEY)' };
    try {
      report.storage = await storage.check();
    } catch (err) {
      Object.assign(report, { ok: false, storage: storage.mode, error: describeError(err) });
    }
    if (!sheet) report.sheet = 'off (no GOOGLE_SHEET_ID)';
    else {
      try {
        report.sheet = await sheet.check();
      } catch (err) {
        Object.assign(report, { ok: false, sheet: 'error', sheetError: describeError(err) });
      }
    }
    res.status(report.ok ? 200 : 503).json(report);
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 1, fields: 10, fieldSize: 2000 },
  });

  app.post(
    '/api/upload',
    rateLimit({ max: config.rateLimitPerHour }),
    upload.single('cv'),
    async (req, res, next) => {
      try {
        // Honeypot: real users never see or fill this field.
        if (req.body && req.body.website) return res.json({ ok: true });

        const { data, errors } = validateFields(req.body);
        let type = null;
        if (!req.file) errors.cv = 'Silakan pilih file CV Anda.';
        else {
          type = detectFileType(req.file.originalname, req.file.buffer);
          if (!type) errors.cv = `CV harus berupa file ${ALLOWED_EXTENSIONS.join(', ').toUpperCase()}.`;
        }
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Mohon periksa kembali formulir Anda.', errors });

        const submittedAt = new Date();
        const fileName = buildFileName(data, type.ext, submittedAt);
        const description = [
          `Name: ${data.name}`,
          `Email: ${data.email}`,
          data.phone && `Phone: ${data.phone}`,
          data.position && `Position: ${data.position}`,
          data.otherInterest && `Interested in: ${data.otherInterest}`,
          `Submitted: ${submittedAt.toISOString()}`,
          `Original file: ${req.file.originalname}`,
        ]
          .filter(Boolean)
          .join('\n');
        const properties = {
          name: fitBytes('name', data.name),
          email: fitBytes('email', data.email),
          phone: fitBytes('phone', data.phone),
          position: fitBytes('position', data.position),
          source: 'cv-upload-qr',
        };

        const saved = await storage.save({
          buffer: req.file.buffer,
          fileName,
          mimeType: type.mimeType,
          description,
          properties,
          position: data.position,
        });
        console.log(`[upload] ${fileName} -> ${saved.id}`);
        res.json({ ok: true, fileName });

        // AI review + spreadsheet row happen after the candidate has their answer.
        if (processor) {
          processor.enqueue({ buffer: req.file.buffer, ext: type.ext, fileName, submittedAt, data, cvLink: saved.link });
        }
      } catch (err) {
        next(err);
      }
    }
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Ukuran file terlalu besar. Maksimal ${config.maxFileMb} MB.`
          : 'File tidak dapat diproses. Silakan coba lagi.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    console.error('[error]', describeError(err));
    res.status(500).json({ error: 'Maaf, terjadi kesalahan saat menyimpan CV Anda. Silakan coba lagi sebentar lagi.' });
  });

  return app;
}

module.exports = { createApp };
