'use strict';

const fs = require('node:fs');

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value.map((v) => text(v, 300)).filter(Boolean).slice(0, 30) : [];
}

function normalize(job, index) {
  const title = text(job && job.title, 100);
  if (!title) return null;
  return {
    id: text(job.id, 60) || `job-${index + 1}`,
    title,
    department: text(job.department, 60),
    location: text(job.location, 60),
    type: text(job.type, 40),
    summary: text(job.summary, 500),
    responsibilities: list(job.responsibilities),
    requirements: list(job.requirements),
    postedAt: text(job.postedAt, 10),
  };
}

// Reads the openings file on demand and re-parses only when it changes,
// so HR can edit the JSON without restarting the server.
function createJobs(file) {
  let cache = { mtimeMs: -1, jobs: [] };

  return function getJobs() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    if (stat.mtimeMs === cache.mtimeMs) return cache.jobs;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const jobs = (Array.isArray(raw) ? raw : [])
        .filter((j) => j && j.open !== false)
        .map(normalize)
        .filter(Boolean);
      cache = { mtimeMs: stat.mtimeMs, jobs };
    } catch (err) {
      // Keep serving the last good list; warn once per broken version of the file.
      cache = { mtimeMs: stat.mtimeMs, jobs: cache.jobs };
      console.warn(`Warning: could not read job openings from ${file}: ${err.message}`);
    }
    return cache.jobs;
  };
}

module.exports = { createJobs };
