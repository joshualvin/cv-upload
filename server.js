'use strict';

// Entry point. Kept free of a require.main guard: hosts such as Hostinger load
// this file through a wrapper, so listen() must always run.
require('dotenv').config({ quiet: true });

const { loadConfig } = require('./lib/config');
const { createStorage } = require('./lib/storage');
const { createApp } = require('./app');
const { createAnalyzer } = require('./lib/analyzer');
const { createSheet } = require('./lib/sheet');
const { createProcessor } = require('./lib/processor');

const config = loadConfig();
let storage;
try {
  storage = createStorage(config);
} catch (err) {
  // Keep serving so the problem is visible at /healthz instead of a bare 503.
  console.error(`Configuration error: ${err.message}`);
  storage = {
    mode: 'unconfigured',
    error: `Configuration error: ${err.message}`,
    check: () => Promise.reject(err),
    save: () => Promise.reject(err),
  };
}
storage
  .check()
  .then((where) => console.log(`Storing CVs in ${where}`))
  .catch((err) => console.warn(`Warning: storage check failed: ${err.message}`));

let sheet = null;
let analyzer = null;
try {
  sheet = createSheet(config);
} catch (err) {
  console.error(`Sheet setup error: ${err.message}`);
}
try {
  analyzer = createAnalyzer(config);
} catch (err) {
  console.error(`AI setup error: ${err.message}`);
}
if (analyzer && !sheet) console.warn('Warning: ANTHROPIC_API_KEY is set but GOOGLE_SHEET_ID is not; AI results have nowhere to go.');
const processor = createProcessor({ analyzer, sheet, timeZone: config.timeZone });
console.log(`AI review: ${analyzer ? `on (${analyzer.model})` : 'off'}; results sheet: ${sheet ? 'on' : 'off'}`);

createApp(config, storage, { analyzer, sheet, processor }).listen(config.port, () => {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  console.log(`Job openings:     ${base}/`);
  console.log(`CV upload form:   ${base}/apply`);
  console.log(`Printable QR:     ${base}/qr`);
});
