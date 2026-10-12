'use strict';

// One Google sign-in shared by Drive and Sheets. The Drive scope also covers
// the Sheets API, so existing refresh tokens keep working.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let cached;

function createGoogleAuth(config) {
  if (cached && cached.config === config) return cached.client;
  const { auth } = require('@googleapis/drive');
  let client;

  if (config.serviceAccountJson || config.serviceAccountKeyFile) {
    client = new auth.GoogleAuth({
      scopes: SCOPES,
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
  cached = { config, client };
  return client;
}

module.exports = { createGoogleAuth, SCOPES };
