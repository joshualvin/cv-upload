'use strict';

const path = require('node:path');

const FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: [0x50, 0x4b, 0x03, 0x04], // ZIP container
  },
  doc: { mimeType: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
};

const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

function startsWith(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

/**
 * Identify the CV type from its extension AND its content, so a renamed
 * executable or image is rejected. Returns { ext, mimeType } or null.
 */
function detectFileType(originalName, buffer) {
  const ext = path.extname(originalName || '').slice(1).toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type || !startsWith(buffer, type.magic)) return null;
  return { ext, mimeType: type.mimeType };
}

/** Dropdown value for candidates open to other opportunities. */
const OTHER_POSITION = 'Other';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+()\-.\s]{6,30}$/;

function clean(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}

/** Validate the text fields of the form. Returns { data, errors }. */
function validateFields(body = {}) {
  const data = {
    name: clean(body.name),
    email: clean(body.email).toLowerCase(),
    phone: clean(body.phone),
    position: clean(body.position),
    otherInterest: '',
  };
  if (data.position.toLowerCase() === OTHER_POSITION.toLowerCase()) {
    data.position = OTHER_POSITION;
    data.otherInterest = clean(body.position_other);
  }
  const errors = {};

  if (!data.name) errors.name = 'Please enter your full name.';
  else if (data.name.length > 100) errors.name = 'Name is too long.';

  if (!data.email) errors.email = 'Please enter your email address.';
  else if (data.email.length > 254 || !EMAIL_RE.test(data.email)) errors.email = 'Please enter a valid email address.';

  if (data.phone && !PHONE_RE.test(data.phone)) errors.phone = 'Please enter a valid phone number.';

  if (data.position.length > 100) errors.position = 'Position is too long.';
  if (data.otherInterest.length > 100) errors.position_other = 'Please keep this under 100 characters.';

  if (!['on', 'yes', 'true'].includes(String(body.consent || '').toLowerCase())) {
    errors.consent = 'Please agree to the privacy notice.';
  }

  return { data, errors };
}

/** "José O'Neil" -> "Jose-O-Neil" */
function slug(value, max = 50) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** 2026-10-12_Jane-Doe_Sales-Manager.pdf */
function buildFileName({ name, position }, ext, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const parts = [day, slug(name) || 'Candidate'];
  if (slug(position)) parts.push(slug(position));
  return `${parts.join('_')}.${ext}`;
}

module.exports = { OTHER_POSITION, ALLOWED_EXTENSIONS, detectFileType, validateFields, slug, buildFileName };
