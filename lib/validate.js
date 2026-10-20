'use strict';

const path = require('node:path');

const FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    magic: [0x50, 0x4b, 0x03, 0x04], // ZIP container
  },
  doc: { mimeType: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  // Photos and scans of paper CVs, accepted on the staff page only.
  jpg: { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  png: { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
};

/** File types on the public form. */
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'doc'];
/** File types on the staff page for offline applications. */
const OFFLINE_EXTENSIONS = [...ALLOWED_EXTENSIONS, 'jpg', 'jpeg', 'png'];

function startsWith(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

/**
 * Identify the CV type from its extension AND its content, so a renamed
 * executable or image is rejected. Returns { ext, mimeType } or null.
 */
function detectFileType(originalName, buffer, allowed = ALLOWED_EXTENSIONS) {
  const ext = path.extname(originalName || '').slice(1).toLowerCase();
  const type = allowed.includes(ext) && FILE_TYPES[ext];
  if (!type || !startsWith(buffer, type.magic)) return null;
  return { ext, mimeType: type.mimeType };
}

/** Dropdown value for candidates open to other opportunities. */
const OTHER_POSITION = 'Other';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Indonesian mobile (HP / WhatsApp) number in any common way of writing it:
 * 0812-3456-7890, 812 3456 7890, 62812..., +62 812..., +62 (0)812...
 * Returns it as "+62 812-3456-7890", or '' when it is not one.
 */
function normalizePhone(value) {
  let digits = String(value || '').replace(/[\s().\-]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+62')) return '';
    digits = digits.slice(3);
  } else if (digits.startsWith('62')) digits = digits.slice(2);
  digits = digits.replace(/^0/, '');
  // Mobile numbers start with 8 and have 9 to 12 digits after the 0 / +62.
  if (!/^8\d{8,11}$/.test(digits)) return '';
  return `+62 ${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}

/**
 * Validate the text fields of the form. Returns { data, errors }.
 * emailRequired: false on the staff page, where a paper CV may have no email.
 */
function validateFields(body = {}, { emailRequired = true } = {}) {
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

  if (!data.name) errors.name = 'Silakan isi nama lengkap Anda.';
  else if (data.name.length > 100) errors.name = 'Nama terlalu panjang.';

  if (!data.email) {
    if (emailRequired) errors.email = 'Silakan isi alamat email Anda.';
  } else if (data.email.length > 254 || !EMAIL_RE.test(data.email)) errors.email = 'Silakan isi alamat email yang valid.';

  if (!data.phone) errors.phone = 'Silakan isi nomor WA/HP Anda.';
  else if (!normalizePhone(data.phone)) errors.phone = 'Gunakan nomor HP Indonesia, misalnya 0812-3456-7890.';
  else data.phone = normalizePhone(data.phone);

  if (data.position.length > 100) errors.position = 'Nama posisi terlalu panjang.';
  if (data.otherInterest.length > 100) errors.position_other = 'Maksimal 100 karakter.';

  if (!['on', 'yes', 'true'].includes(String(body.consent || '').toLowerCase())) {
    errors.consent = 'Silakan centang persetujuan.';
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

module.exports = { OTHER_POSITION, ALLOWED_EXTENSIONS, OFFLINE_EXTENSIONS, detectFileType, normalizePhone, validateFields, slug, buildFileName };
