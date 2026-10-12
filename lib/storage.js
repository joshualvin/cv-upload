'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function createDriveClient(config) {
  // Loaded lazily so local mode does not need the Google client at all.
  const { drive, auth } = require('@googleapis/drive');
  const scopes = ['https://www.googleapis.com/auth/drive'];
  let client;

  if (config.serviceAccountJson || config.serviceAccountKeyFile) {
    client = new auth.GoogleAuth({
      scopes,
      ...(config.serviceAccountJson
        ? { credentials: JSON.parse(config.serviceAccountJson) }
        : { keyFile: config.serviceAccountKeyFile }),
    });
  } else if (config.oauthClientId && config.oauthClientSecret && config.oauthRefreshToken) {
    client = new auth.OAuth2(config.oauthClientId, config.oauthClientSecret);
    client.setCredentials({ refresh_token: config.oauthRefreshToken });
  } else {
    throw new Error(
      'No Google credentials configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE / GOOGLE_SERVICE_ACCOUNT_JSON, ' +
        'or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN, or use DRIVE_MODE=local.'
    );
  }
  return drive({ version: 'v3', auth: client });
}

function escapeQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function googleStorage(config) {
  if (!config.driveFolderId) throw new Error('DRIVE_FOLDER_ID is required when DRIVE_MODE=google.');
  const drive = createDriveClient(config);
  const folderCache = new Map();

  async function folderFor(position) {
    if (!config.subfolderPerPosition || !position) return config.driveFolderId;
    const name = position.slice(0, 100);
    const key = name.toLowerCase();
    if (folderCache.has(key)) return folderCache.get(key);

    const pending = (async () => {
      const { data } = await drive.files.list({
        q: `'${escapeQuery(config.driveFolderId)}' in parents and name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
        corpora: 'allDrives',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      if (data.files && data.files.length) return data.files[0].id;
      const created = await drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [config.driveFolderId] },
        fields: 'id',
        supportsAllDrives: true,
      });
      return created.data.id;
    })();
    folderCache.set(key, pending);
    pending.catch(() => folderCache.delete(key));
    return pending;
  }

  return {
    mode: 'google',
    async check() {
      const { data } = await drive.files.get({
        fileId: config.driveFolderId,
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      });
      if (data.mimeType !== FOLDER_MIME) throw new Error('DRIVE_FOLDER_ID is not a folder.');
      return `Google Drive folder "${data.name}"`;
    },
    async save({ buffer, fileName, mimeType, description, properties, position }) {
      const parent = await folderFor(position);
      const { data } = await drive.files.create({
        requestBody: { name: fileName, parents: [parent], description, appProperties: properties },
        media: { mimeType, body: Readable.from(buffer) },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      });
      return { id: data.id, link: data.webViewLink };
    },
  };
}

function localStorage(config) {
  const root = path.resolve(config.localUploadDir);
  return {
    mode: 'local',
    async check() {
      await fs.mkdir(root, { recursive: true });
      return `local folder ${root}`;
    },
    async save({ buffer, fileName, description, properties, position }) {
      const dir = config.subfolderPerPosition && position ? path.join(root, position.replace(/[^\w .-]+/g, '-')) : root;
      await fs.mkdir(dir, { recursive: true });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const target = path.join(dir, `${id}_${fileName}`);
      await fs.writeFile(target, buffer);
      await fs.writeFile(`${target}.json`, JSON.stringify({ description, properties }, null, 2));
      return { id, link: target };
    },
  };
}

function createStorage(config) {
  if (config.driveMode === 'local') return localStorage(config);
  if (config.driveMode === 'google') return googleStorage(config);
  throw new Error(`Unknown DRIVE_MODE "${config.driveMode}" (use "google" or "local").`);
}

module.exports = { createStorage };
