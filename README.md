# CV Upload

A small web app for recruiting events, shop windows and job posters. Job seekers scan a QR code with their phone, fill in a short form and upload their CV. The file lands straight in a Google Drive folder.

- **`/qr`**: a printable poster with the QR code. You can tag it with a position, such as "Sales Associate", and download it as a PNG.
- **`/`**: the mobile-friendly upload form. It asks for name, email, phone, position, the CV (PDF, DOC or DOCX) and consent.
- **Google Drive**: each CV is saved as `2026-10-12_Jane-Doe_Sales-Associate.pdf`. The candidate's details go in the file description. You can also file CVs into one subfolder per position.

The server checks each file's size, extension and actual content, so a renamed `.exe` is rejected. It also rate-limits uploads per device and uses a hidden honeypot field to block simple spam bots.

## Quick start (no Google account needed)

```bash
npm install
npm run dev          # DRIVE_MODE=local: CVs are saved to ./uploads
```

Open http://localhost:3000/qr for the poster and http://localhost:3000/ for the form.

To test from your phone, both devices must be on the same Wi-Fi. Set `PUBLIC_URL=http://<your-computer-ip>:3000` so the QR code points at your computer.

## Connecting Google Drive

1. Copy the config template: `cp .env.example .env`.
2. Create a folder in Google Drive for the CVs and open it. Copy the ID at the end of the URL (`https://drive.google.com/drive/folders/THIS_PART`) into `DRIVE_FOLDER_ID`.
3. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or choose an existing one). Then go to **APIs & Services → Library → Google Drive API → Enable**.
4. Choose one way to sign in:

### Option A: your own Google account (easiest, works with a personal Gmail Drive)

1. Go to **APIs & Services → OAuth consent screen**. Choose *External*, fill in the app name and your email, and add yourself as a **test user**. Then click **Publish app**. While the app is in "Testing" mode, refresh tokens expire after 7 days. Publishing it for your own use avoids that, and you can skip the verification warning when you sign in.
2. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID** and choose **Desktop app**. Put the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. Run `npm run get-token`. Open the link it prints and sign in with the account that owns the folder. Copy the `GOOGLE_REFRESH_TOKEN=...` line it prints into `.env`.

### Option B: service account (Google Workspace with a Shared Drive)

Service accounts have no storage of their own, so they can't upload into a personal "My Drive". The folder must be inside a **Shared Drive**.

1. Go to **IAM & Admin → Service accounts → Create**, then open the new account and go to **Keys → Add key → JSON**.
2. Add the service account's email to the Shared Drive as a **Content manager**.
3. Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/path/to/key.json`, or paste the JSON on one line into `GOOGLE_SERVICE_ACCOUNT_JSON`.

Then start the server:

```bash
npm start
```

On startup the server checks that it can reach the folder, for example: `Storing CVs in Google Drive folder "CVs"`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PUBLIC_URL` | derived from request | The address the QR code points to, e.g. `https://cv.example.com` |
| `COMPANY_NAME` | `Our Company` | Shown on the form, the poster and the consent text |
| `DRIVE_MODE` | `google` | `google` or `local` |
| `DRIVE_FOLDER_ID` | – | Target Drive folder |
| `DRIVE_SUBFOLDER_PER_POSITION` | `false` | File CVs into one subfolder per position |
| `MAX_FILE_MB` | `10` | Maximum CV size |
| `RATE_LIMIT_PER_HOUR` | `10` | Upload attempts per IP address per hour |
| `TRUST_PROXY` | `false` | Set to `true` behind nginx, Cloud Run, Render and similar, so rate limiting sees each candidate's real IP |
| `PORT` | `3000` | HTTP port |

See `.env.example` for the Google sign-in variables.

## Deploying

Phones need to reach the app over **HTTPS** at a public address. Any Node.js host works, for example Render, Railway, Fly.io, Google Cloud Run or a VPS behind nginx. Set the environment variables from `.env.example` there, set `PUBLIC_URL` to the public address, and set `TRUST_PROXY=true`.

With Docker:

```bash
docker compose up -d --build
```

## Privacy

CVs contain personal data. Make sure the consent text and your retention practices match local law, such as GDPR or PDPA. Limit who can access the Drive folder. The app keeps nothing on its own server in `google` mode: files are held in memory only while they upload.

## Development

```bash
npm test
```
