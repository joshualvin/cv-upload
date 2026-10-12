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

1. In the `cv-upload` folder, install the dependencies: `npm install`. Then copy the config template: `cp .env.example .env`.
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

## AI review in a Google Sheet (optional)

When it's turned on, every uploaded CV is read by Claude and added to a Google Sheet as one row per applicant. The candidate gets the "thank you" screen right away, and the analysis runs in the background, usually within a minute.

Each row has:
- the applicant's name, email, phone and position
- a **match score (0–100)** with a short reason
- education level and an education rank (0 = none … 6 = doctorate), qualification, field and institution
- total and relevant years of experience, plus their current or last job title and employer
- skills, languages, certifications, a short summary, an **Open CV** link and the AI status

Sort or filter by any column, for example by match score from highest to lowest.

**Setup:**
1. Create an empty Google Sheet with the same Google account that owns the Drive folder. Copy its ID from the URL (`https://docs.google.com/spreadsheets/d/THIS_PART/edit`) into `GOOGLE_SHEET_ID`.
2. In Google Cloud Console, go to **APIs & Services → Library → Google Sheets API → Enable**. Your existing refresh token already covers Sheets, so you don't need to run `get-token` again.
3. Put your Anthropic API key in `ANTHROPIC_API_KEY`. Optionally set `TIMEZONE`, for example `Asia/Kuala_Lumpur`.
4. Restart or redeploy, then open `/healthz`. It should show `"ai": "on (claude-opus-5-5)"` and the sheet. The app creates the **Applicants** and **Positions** tabs automatically.

**Requirements per position:** in the **Positions** tab, put the position name in column A, spelled the same as on the QR code, and its requirements in plain words in column B. For example: `Diploma or higher; 2+ years retail; speaks English and Malay`. Changes apply within a minute, with no redeploy. Positions without requirements are scored against what the role typically needs, and the reason says "(No requirements set)".

**Notes:**
- **Cost:** with Claude Opus 5.5, expect roughly $0.05–0.06 per CV. Set `AI_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5` to pay less.
- **File types:** PDF and DOCX are analysed. Old `.doc` files are saved but marked for manual review.
- **Fairness:** the AI is told to use only job-relevant facts. It must ignore age, gender, race, religion, marital status, health and photos, and must ignore instructions written inside a CV. Use the score to sort and shortlist, and have a person make every decision. AI in hiring is regulated in some places, so check your local rules. When AI is on, the consent text tells candidates that AI helps review their CV.
- **Without an API key:** if only `GOOGLE_SHEET_ID` is set, applicants are still listed in the sheet, just without AI fields.

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
| `ANTHROPIC_API_KEY` | – | Turns on AI review of each CV |
| `AI_MODEL` | `claude-opus-5-5` | Claude model used for the review |
| `GOOGLE_SHEET_ID` | – | Sheet that receives one row per applicant |
| `TIMEZONE` | `UTC` | Time zone of the "Submitted" column |
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
