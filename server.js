'use strict';

require('dotenv').config({ quiet: true });

const path = require('node:path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const { loadConfig } = require('./lib/config');
const { createJobs } = require('./lib/jobs');
const { createStorage } = require('./lib/storage');
const { rateLimit } = require('./lib/rateLimit');
const { ALLOWED_EXTENSIONS, detectFileType, validateFields, buildFileName } = require('./lib/validate');

// Drive appProperties allow at most 124 bytes per key + value.
function fitBytes(key, value) {
  let v = String(value || '');
  while (Buffer.byteLength(key + v) > 124) v = v.slice(0, -1);
  return v;
}

function createApp(config, storage) {
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
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });

  const publicDir = path.join(__dirname, 'public');
  app.get('/', (req, res) => {
    // QR codes printed before the job board existed point at /?position=...
    if (req.query.position) {
      const position = String(req.query.position).trim().slice(0, 100);
      return res.redirect(302, `/apply?position=${encodeURIComponent(position)}`);
    }
    res.sendFile(path.join(publicDir, 'jobs.html'));
  });
  app.get('/apply', (req, res) => res.sendFile(path.join(publicDir, 'apply.html')));
  app.get('/qr', (req, res) => res.sendFile(path.join(publicDir, 'qr.html')));
  app.use(express.static(publicDir, { index: false }));

  function uploadUrl(req) {
    const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
    const position = String(req.query.position || '').trim().slice(0, 100);
    // A general QR opens the job board; a position QR goes straight to the form.
    return position ? `${base}/apply?position=${encodeURIComponent(position)}` : `${base}/`;
  }

  app.get('/api/config', (req, res) => {
    res.json({
      companyName: config.companyName,
      maxFileMb: config.maxFileMb,
      allowedExtensions: ALLOWED_EXTENSIONS,
    });
  });

  app.get('/api/jobs', (req, res) => {
    res.set('Cache-Control', 'no-cache').json({ jobs: getJobs() });
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

  app.get('/healthz', (req, res) => res.json({ ok: true, storage: storage.mode }));

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
    console.error('[error]', err);
    res.status(500).json({ error: 'Sorry, something went wrong saving your CV. Please try again in a moment.' });
  });

  return app;
}

if (require.main === module) {
  const config = loadConfig();
  let storage;
  try {
    storage = createStorage(config);
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  storage
    .check()
    .then((where) => console.log(`Storing CVs in ${where}`))
    .catch((err) => console.warn(`Warning: storage check failed: ${err.message}`));

  createApp(config, storage).listen(config.port, () => {
    const base = config.publicUrl || `http://localhost:${config.port}`;
    console.log(`Job openings:     ${base}/`);
    console.log(`CV upload form:   ${base}/apply`);
    console.log(`Printable QR:     ${base}/qr`);
  });
}

module.exports = { createApp };
