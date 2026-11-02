'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const { loadConfig } = require('../lib/config');
const { HEADERS, positionRows, positionRow } = require('../lib/sheet');
const { driveId } = require('../lib/hrApi');

const TOKEN = 'x'.repeat(30);
const CV_ID = '1AbCdEfGhIjKlMnOpQrStUv';

function applicantRow(fields) {
  return HEADERS.map((h) => (h in fields ? fields[h] : ''));
}

let server;
let base;
let written = null;
const sheet = {
  readPositionRows: async () => positionRows([['Cashier', 'SMA', 'yes', 'Retail'], ['Driver', '', 'no'], ['Sales', 'Example: x', 'yes']]),
  writePositions: async (p) => {
    written = p;
  },
  readApplicants: async () => [
    applicantRow({ Submitted: '2026-11-01 10:00', Name: 'Ani', Email: 'ani@example.com', Position: 'Cashier', 'Match score': 82, CV: `=HYPERLINK("https://drive.google.com/file/d/${CV_ID}/view?usp=drivesdk","Open CV")` }),
    applicantRow({ Submitted: '2026-11-01 11:00', Name: 'Budi', Position: 'Driver' }),
    applicantRow({}),
  ],
  listJobs: async () => [],
};
const storage = {
  mode: 'test',
  check: async () => 'test',
  download: async (id) => ({ buffer: Buffer.from(`cv ${id}`), name: 'cv.pdf' }),
};

before(async () => {
  const config = loadConfig({ DRIVE_MODE: 'local', HR_API_TOKEN: TOKEN });
  server = createApp(config, storage, { sheet }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/hr-api`;
});

after(() => server.close());

const auth = { authorization: `Bearer ${TOKEN}` };

test('the HR API needs the token', async () => {
  assert.equal((await fetch(`${base}/positions`)).status, 401);
  assert.equal((await fetch(`${base}/positions`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
});

test('positions list open and closed rows but not the example row', async () => {
  const { positions } = await (await fetch(`${base}/positions`, { headers: auth })).json();
  assert.deepEqual(positions.map((p) => [p.name, p.open, p.department]), [['Cashier', true, 'Retail'], ['Driver', false, '']]);
});

test('positions are replaced with the checked list', async () => {
  const body = { positions: [{ name: ' Gudang ', requirements: 'SMA', open: false, type: 'Kontrak' }, { name: '' }] };
  const res = await fetch(`${base}/positions`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  assert.equal(written.length, 1);
  assert.equal(written[0].name, 'Gudang');
  assert.deepEqual(positionRow(written[0]).slice(0, 3), ['Gudang', 'SMA', 'no']);
  const dup = await fetch(`${base}/positions`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ positions: [{ name: 'A' }, { name: 'a' }] }) });
  assert.equal(dup.status, 400);
});

test('applicants come with a stable id, the score and the CV id', async () => {
  const { applicants } = await (await fetch(`${base}/applicants`, { headers: auth })).json();
  assert.equal(applicants.length, 2);
  assert.equal(applicants[0].id, CV_ID);
  assert.equal(applicants[0].matchScore, 82);
  assert.equal(applicants[1].cvId, '');
  assert.match(applicants[1].id, /^[0-9a-f]{20}$/);
});

test('only CVs of listed applicants can be downloaded', async () => {
  const ok = await fetch(`${base}/cv/${CV_ID}`, { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal(await ok.text(), `cv ${CV_ID}`);
  assert.equal((await fetch(`${base}/cv/1SomeOtherDriveFile99`, { headers: auth })).status, 404);
});

test('driveId reads both Drive link forms', () => {
  assert.equal(driveId('=HYPERLINK("https://drive.google.com/file/d/abcDEF12345/view","Open CV")'), 'abcDEF12345');
  assert.equal(driveId('https://drive.google.com/open?id=abcDEF12345'), 'abcDEF12345');
  assert.equal(driveId('/local/path.pdf'), '');
});
