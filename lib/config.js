'use strict';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    // Public URL the QR code points to, e.g. https://cv.example.com
    // If empty, it is derived from the incoming request.
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    companyName: env.COMPANY_NAME || 'Our Company',
    maxFileMb: int(env.MAX_FILE_MB, 10),
    rateLimitPerHour: int(env.RATE_LIMIT_PER_HOUR, 10),
    trustProxy: bool(env.TRUST_PROXY, false),

    // "google" uploads to Google Drive, "local" saves to disk (for testing).
    driveMode: (env.DRIVE_MODE || 'google').toLowerCase(),
    driveFolderId: env.DRIVE_FOLDER_ID || '',
    subfolderPerPosition: bool(env.DRIVE_SUBFOLDER_PER_POSITION, false),
    localUploadDir: env.LOCAL_UPLOAD_DIR || 'uploads',

    // Optional: AI review of each CV, written to a Google Sheet.
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    aiModel: env.AI_MODEL || 'claude-opus-5-5',
    sheetId: env.GOOGLE_SHEET_ID || '',
    // Fallback dropdown options when there is no Positions tab, e.g. "Cashier, Driver"
    positions: (env.POSITIONS || '').split(',').map((p) => p.trim()).filter(Boolean),
    timeZone: env.TIMEZONE || 'UTC',

    // Option A: service account (requires a Shared Drive folder)
    serviceAccountKeyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '',
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    // Option B: OAuth client + refresh token (works with a personal My Drive)
    oauthClientId: env.GOOGLE_CLIENT_ID || '',
    oauthClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    oauthRefreshToken: env.GOOGLE_REFRESH_TOKEN || '',
  };
}

module.exports = { loadConfig };
