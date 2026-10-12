'use strict';

/**
 * One-time helper for the OAuth option: signs you in with Google and prints a
 * refresh token so the server can upload into your own (personal) Google Drive.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run get-token
 *
 * The OAuth client must be of type "Desktop app" in Google Cloud Console.
 */
require('dotenv').config({ quiet: true });

const http = require('node:http');
const { auth } = require('@googleapis/drive');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const port = Number(process.env.OAUTH_PORT || 53682);

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the environment) first.');
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const client = new auth.OAuth2(clientId, clientSecret, redirectUri);
const url = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, redirectUri);
  if (pathname !== '/oauth2callback') return res.writeHead(404).end();
  const code = searchParams.get('code');
  if (!code) {
    res.end(`Sign-in failed: ${searchParams.get('error') || 'no code returned'}`);
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    res.end('Done! You can close this tab and return to the terminal.');
    if (!tokens.refresh_token) {
      console.error('\nNo refresh token returned. Remove the app at https://myaccount.google.com/permissions and try again.');
    } else {
      console.log('\nAdd this line to your .env file:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (err) {
    res.end('Token exchange failed, see terminal.');
    console.error(err.message);
  } finally {
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('Open this URL in your browser and sign in with the Google account that owns the Drive folder:\n');
  console.log(url + '\n');
});
