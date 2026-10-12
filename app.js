'use strict';

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

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

function createApp(config, storage, { analyzer = null, sheet = null, processor = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  const publicDir = path.join(__dirname, 'public');
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/qr', (req, res) => res.sendFile(path.join(publicDir, 'qr.html')));
  app.use(express.static(publicDir, { index: false }));

  function uploadUrl(req) {
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const position = String(req.query.position || '').trim().slice(0, 100);
    return position ? `${base}/?position=${encodeURIComponent(position)}` : `${base}/`;
  }

  app.get('/api/config', (req, res) => {
    res.json({
      companyName: config.companyName,
      maxFileMb: config.maxFileMb,
      allowedExtensions: ALLOWED_EXTENSIONS,
      aiEnabled: Boolean(analyzer),
    });
  });

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
        if (!req.file) errors.cv = 'Please choose your CV file.';
        else {
          type = detectFileType(req.file.originalname, req.file.buffer);
          if (!type) errors.cv = `Your CV must be a ${ALLOWED_EXTENSIONS.join(', ').toUpperCase()} file.`;
        }
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Please check the form.', errors });

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
          ? `Your file is too large. The maximum size is ${config.maxFileMb} MB.`
          : 'The upload could not be processed. Please try again.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    console.error('[error]', describeError(err));
    res.status(500).json({ error: 'Sorry, something went wrong saving your CV. Please try again in a moment.' });
  });

  return app;
}

module.exports = { createApp };
