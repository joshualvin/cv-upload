'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../app');
const { loadConfig } = require('../lib/config');
const { createStorage } = require('../lib/storage');
const { buildFileName, slug, detectFileType } = require('../lib/validate');

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

let server;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-upload-test-'));
  const config = loadConfig({
    DRIVE_MODE: 'local',
    LOCAL_UPLOAD_DIR: dir,
    MAX_FILE_MB: '1',
    RATE_LIMIT_PER_HOUR: '6',
    COMPANY_NAME: 'Acme',
    PUBLIC_URL: 'https://cv.example.com/',
  });
  server = createApp(config, createStorage(config)).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set('cv', new Blob([file.buffer]), file.name);
  return fd;
}

const valid = { name: 'José Pérez', email: 'jose@example.com', phone: '+1 555 0100', position: 'Sales Associate', consent: 'yes' };

test('builds a readable, safe file name', () => {
  const date = new Date('2026-10-12T10:00:00Z');
  assert.equal(buildFileName({ name: 'José O\'Neil', position: 'Sales / Ops' }, 'pdf', date), '2026-10-12_Jose-O-Neil_Sales-Ops.pdf');
  assert.equal(buildFileName({ name: '张伟', position: '' }, 'docx', date), '2026-10-12_Candidate.docx');
  assert.equal(slug('../../etc/passwd'), 'etc-passwd');
});

test('detects file type by content, not just extension', () => {
  assert.equal(detectFileType('cv.pdf', PDF).ext, 'pdf');
  assert.equal(detectFileType('cv.DOCX', DOCX).ext, 'docx');
  assert.equal(detectFileType('cv.pdf', EXE), null);
  assert.equal(detectFileType('cv.exe', EXE), null);
  assert.equal(detectFileType('cv.docx', PDF), null);
});

test('serves the form, poster and config', async () => {
  for (const p of ['/', '/qr', '/style.css', '/upload.js', '/qr.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.companyName, 'Acme');
  assert.equal(cfg.maxFileMb, 1);
});

test('QR code points at the public upload URL', async () => {
  const link = await (await fetch(base + '/api/qr-link?position=Sales%20%26%20Ops')).json();
  assert.equal(link.url, 'https://cv.example.com/?position=Sales%20%26%20Ops');

  const svg = await fetch(base + '/qr.svg');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await svg.text(), /^<svg/);

  const png = await fetch(base + '/qr.png?download=1');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /attachment/);
});

test('accepts a valid PDF and stores it with candidate details', async () => {
  const res = await fetch(base + '/api/upload', { method: 'POST', body: form(valid, { buffer: PDF, name: 'my cv.pdf' }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.fileName, /^\d{4}-\d{2}-\d{2}_Jose-Perez_Sales-Associate\.pdf$/);

  const saved = fs.readdirSync(dir).find((f) => f.endsWith('Jose-Perez_Sales-Associate.pdf'));
  assert.ok(saved);
  assert.deepEqual(fs.readFileSync(path.join(dir, saved)), PDF);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, saved + '.json'), 'utf8'));
  assert.match(meta.description, /Email: jose@example.com/);
  assert.equal(meta.properties.position, 'Sales Associate');
});

test('rejects a disguised executable', async () => {
  const res = await fetch(base + '/api/upload', { method: 'POST', body: form(valid, { buffer: EXE, name: 'cv.pdf' }) });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors.cv);
});

test('reports missing fields and consent', async () => {
  const res = await fetch(base + '/api/upload', { method: 'POST', body: form({ email: 'nope' }) });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.deepEqual(Object.keys(errors).sort(), ['consent', 'cv', 'email', 'name']);
});

test('rejects files over the size limit', async () => {
  const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 1)]);
  const res = await fetch(base + '/api/upload', { method: 'POST', body: form(valid, { buffer: big, name: 'cv.pdf' }) });
  assert.equal(res.status, 413);
});

test('silently drops honeypot submissions', async () => {
  const before = fs.readdirSync(dir).length;
  const res = await fetch(base + '/api/upload', {
    method: 'POST',
    body: form({ ...valid, website: 'spam.example' }, { buffer: PDF, name: 'cv.pdf' }),
  });
  assert.equal(res.status, 200);
  assert.equal(fs.readdirSync(dir).length, before);
});

test('rate limits repeated uploads', async () => {
  let last;
  for (let i = 0; i < 4; i++) {
    last = await fetch(base + '/api/upload', { method: 'POST', body: form({}) });
  }
  assert.equal(last.status, 429);
});
