'use strict';

// Pieces shared by the upload routes and the background review: the details
// stored with a CV in Drive, and the applicant's contact details read from a CV.

const { normalizePhone } = require('./validate');

/** AI status of a staff upload saved while the AI review was not available. */
const WAITING_FOR_AI = 'Waiting for AI';

/** AI status a recruiter sets to have the server review a row again at its next start. */
const REVIEW_AGAIN = 'Review again';

// Drive appProperties allow at most 124 bytes per key + value.
function fitBytes(key, value) {
  let v = String(value || '');
  while (Buffer.byteLength(key + v) > 124) v = v.slice(0, -1);
  return v;
}

/** Drive description and properties for one application. */
function fileDetails(data, submittedAt, originalName, source) {
  const description = [
    `Name: ${data.name}`,
    data.email && `Email: ${data.email}`,
    data.phone && `Phone: ${data.phone}`,
    data.social && `Social: ${data.social}`,
    data.position && `Position: ${data.position}`,
    data.otherInterest && `Interested in: ${data.otherInterest}`,
    `Source: ${data.source}`,
    `Submitted: ${submittedAt.toISOString()}`,
    `Original file: ${originalName}`,
  ]
    .filter(Boolean)
    .join('\n');
  const properties = {
    name: fitBytes('name', data.name),
    email: fitBytes('email', data.email),
    phone: fitBytes('phone', data.phone),
    position: fitBytes('position', data.position),
    source,
  };
  return { description, properties };
}

const oneLine = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Name, email and phone from the AI's reading of a CV. `stem` (the original
 * file name without extension) stands in when no name could be read.
 */
function contactFromCv(result, stem) {
  const r = result || {};
  const email = oneLine(r.candidate_email, 254).toLowerCase();
  const phone = oneLine(r.candidate_phone, 30);
  return {
    name: oneLine(r.candidate_name, 100) || `(nama tidak terbaca) ${stem}`,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    phone: normalizePhone(phone) || phone,
  };
}

module.exports = { WAITING_FOR_AI, REVIEW_AGAIN, fitBytes, fileDetails, oneLine, contactFromCv };
