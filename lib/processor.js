'use strict';

const { buildRow } = require('./sheet');

/**
 * Runs after the candidate has already been answered: analyse the CV with AI
 * (if configured) and add a row to the sheet. Jobs run one at a time so a burst
 * of uploads doesn't hit API rate limits.
 */
function createProcessor({ analyzer, sheet, timeZone, log = console }) {
  if (!sheet) return null;
  let chain = Promise.resolve();
  let pending = 0;

  async function run(job) {
    let ai = null;
    let status = 'AI not configured';
    if (analyzer) {
      try {
        const requirements = await sheet.getRequirements(job.data.position).catch(() => '');
        ai = await analyzer.analyze({
          buffer: job.buffer,
          ext: job.ext,
          position: job.data.position,
          requirements,
          otherInterest: job.data.otherInterest,
        });
        status = ai.skipped || `Analysed by ${ai.model || analyzer.model}`;
      } catch (err) {
        ai = null;
        status = `AI failed: ${String(err.message || err).slice(0, 200)}`;
        log.error(`[ai] ${job.fileName}: ${err.message || err}`);
      }
    }
    await sheet.append(buildRow(job, ai, status, timeZone));
    log.log(`[sheet] ${job.fileName}: ${status}`);
  }

  return {
    get pending() {
      return pending;
    },
    enqueue(job) {
      pending += 1;
      chain = chain
        .then(() => run(job))
        .catch((err) => log.error(`[sheet] ${job.fileName}: ${err.message || err}`))
        .finally(() => (pending -= 1));
      return chain;
    },
  };
}

module.exports = { createProcessor };
