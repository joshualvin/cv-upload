'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const { createJobs } = require('./lib/jobs');
const { rateLimit } = require('./lib/rateLimit');
const { WAITING_FOR_AI, fileDetails, oneLine, contactFromCv } = require('./lib/details');
const { buildRow } = require('./lib/sheet');
const {
  OTHER_POSITION,
  ALLOWED_EXTENSIONS,
  OFFLINE_EXTENSIONS,
  detectFileType,
  validateFields,
  buildFileName,
} = require('./lib/validate');

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

/**
 * Password check for the staff page (HTTP Basic auth; any user name). After
 * 10 wrong passwords from one address it refuses for 15 minutes.
 */
function requireStaff(password) {
  const want = crypto.createHash('sha256').update(password).digest();
  const failures = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const seen = failures.get(req.ip);
    if (seen && seen.reset > now && seen.count >= 10) {
      return res.status(429).type('text').send('Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
    }
    const [scheme, encoded = ''] = String(req.get('authorization') || '').split(' ');
    const given = scheme === 'Basic' ? Buffer.from(encoded, 'base64').toString('utf8').replace(/^[^:]*:/, '') : '';
    const got = crypto.createHash('sha256').update(given).digest();
    if (given && crypto.timingSafeEqual(want, got)) return next();
    if (given) {
      const entry = seen && seen.reset > now ? seen : { count: 0, reset: now + 15 * 60 * 1000 };
      entry.count += 1;
      failures.set(req.ip, entry);
    }
    res.set('WWW-Authenticate', 'Basic realm="Staf", charset="UTF-8"');
    res.status(401).type('text').send('Masuk dengan kata sandi staf.');
  };
}

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
    ['jobs.html', 'apply.html', 'qr.html', 'admin.html'].map((n) => [n, loadPage(publicDir, n, versions, siteConfig)])
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

  /** Save one application to Drive, answer, then queue the AI review and sheet row. */
  async function saveApplication(res, { file, type, data, source }) {
    const submittedAt = new Date();
    const fileName = buildFileName(data, type.ext, submittedAt);
    const { description, properties } = fileDetails(data, submittedAt, file.originalname, source);

    const saved = await storage.save({
      buffer: file.buffer,
      fileName,
      mimeType: type.mimeType,
      description,
      properties,
      position: data.position,
    });
    console.log(`[upload] ${fileName} -> ${saved.id}`);
    res.json({ ok: true, fileName });

    // AI review + spreadsheet row happen after the answer has been sent.
    if (processor) {
      processor.enqueue({ buffer: file.buffer, ext: type.ext, fileName, submittedAt, data, cvLink: saved.link });
    }
  }

  function checkFile(file, errors, extensions, missing) {
    if (!file) {
      errors.cv = missing;
      return null;
    }
    const type = detectFileType(file.originalname, file.buffer, extensions);
    if (!type) errors.cv = `CV harus berupa file ${extensions.join(', ').toUpperCase()}.`;
    return type;
  }

  app.post(
    '/api/upload',
    rateLimit({ max: config.rateLimitPerHour }),
    upload.single('cv'),
    async (req, res, next) => {
      try {
        // Honeypot: real users never see or fill this field.
        if (req.body && req.body.website) return res.json({ ok: true });

        const { data, errors } = validateFields(req.body);
        const type = checkFile(req.file, errors, ALLOWED_EXTENSIONS, 'Silakan pilih file CV Anda.');
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Mohon periksa kembali formulir Anda.', errors });
        data.source = 'Online';
        await saveApplication(res, { file: req.file, type, data, source: 'cv-upload-qr' });
      } catch (err) {
        next(err);
      }
    }
  );

  // Staff page for applications that came in on paper or by hand. Off until
  // ADMIN_PASSWORD (at least 8 characters) is set.
  if (config.adminPassword.length >= 8) {
    const staff = requireStaff(config.adminPassword);
    app.get('/admin', staff, (req, res) => sendPage(res, 'admin.html'));
    // Staff only add the CV (file, scan or photo). It is saved at once under a
    // temporary name; the AI then reads name, email and phone from it, and the
    // file is renamed and its sheet row written with those details. Without the
    // AI (no ANTHROPIC_API_KEY) the row is written as "Waiting for AI", and the
    // server that has the key completes it at its next start (lib/backfill.js).
    app.post('/admin/api/upload', staff, upload.single('cv'), async (req, res, next) => {
      try {
        if (!sheet) return res.status(503).json({ error: 'Sheet belum diatur (GOOGLE_SHEET_ID).' });
        const errors = {};
        const type = checkFile(req.file, errors, OFFLINE_EXTENSIONS, 'Pilih file CV atau foto CV.');
        if (!['on', 'yes', 'true'].includes(String(req.body.consent || '').toLowerCase())) {
          errors.consent = 'Centang persetujuan pelamar.';
        }
        if (Object.keys(errors).length) return res.status(400).json({ error: errors.cv || errors.consent, errors });

        const chosen = oneLine(req.body.position, 100);
        const note = oneLine(req.body.note, 100);
        const data = {
          name: '',
          email: '',
          phone: '',
          position: chosen.toLowerCase() === OTHER_POSITION.toLowerCase() ? OTHER_POSITION : chosen,
          otherInterest: '',
          source: note ? `Offline: ${note}` : 'Offline',
        };
        const file = req.file;
        const submittedAt = new Date();
        const stem = path.parse(file.originalname).name;
        const tempName = buildFileName({ name: `Offline ${stem}`, position: data.position }, type.ext, submittedAt);
        const placeholder = { ...data, name: `(menunggu AI) ${stem}` };
        const saved = await storage.save({
          buffer: file.buffer,
          fileName: tempName,
          mimeType: type.mimeType,
          ...fileDetails(placeholder, submittedAt, file.originalname, 'offline'),
          position: data.position,
        });
        console.log(`[staff] ${tempName} -> ${saved.id}`);

        if (!analyzer || !processor) {
          await sheet.append(buildRow({ submittedAt, data: placeholder, cvLink: saved.link }, null, WAITING_FOR_AI, config.timeZone));
          return res.json({ ok: true, file: file.originalname, waiting: true });
        }
        res.json({ ok: true, file: file.originalname });

        processor.enqueue({
          buffer: file.buffer,
          ext: type.ext,
          fileName: tempName,
          submittedAt,
          data,
          cvLink: saved.link,
          fromCv: async (result) => {
            Object.assign(data, contactFromCv(result, stem));
            const fileName = buildFileName(data, type.ext, submittedAt);
            await storage.rename(saved.id, { fileName, ...fileDetails(data, submittedAt, file.originalname, 'offline') });
          },
        });
      } catch (err) {
        next(err);
      }
    });
  } else {
    if (config.adminPassword) console.warn('ADMIN_PASSWORD is shorter than 8 characters; the staff page stays off.');
    app.get('/admin', (req, res) =>
      res.status(404).type('text').send('Halaman staf belum aktif. Isi ADMIN_PASSWORD (minimal 8 karakter) di pengaturan server.')
    );
  }

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
