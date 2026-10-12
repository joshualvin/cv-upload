'use strict';

// Entry point. Kept free of a require.main guard: hosts such as Hostinger load
// this file through a wrapper, so listen() must always run.
require('dotenv').config({ quiet: true });

const { loadConfig } = require('./lib/config');
const { createStorage } = require('./lib/storage');
const { createApp } = require('./app');

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

createApp(config, storage).listen(config.port, () => {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  console.log(`CV upload form:   ${base}/`);
  console.log(`Printable QR:     ${base}/qr`);
});
