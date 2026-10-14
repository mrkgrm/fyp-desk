# FYP Desk — Fansly FYP Worker + Team Dashboard

21+ only. Consented adult talent. Min age 21.

## Permanent dashboard

Deploy this Next.js app to Vercel:

1. Push this repo to GitHub.
2. Import to Vercel.
3. Set environment variables:
   - `AIRTABLE_TOKEN` = your PAT
   - `TEAM_BOARD_PASSWORD` = FypBoard-Kiara
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = full service account JSON string
4. Deploy. Bookmark the `*.vercel.app` URL.
5. Password: FypBoard-Kiara

Local: `npm run dev` then open /board

## Worker

`npm run kiara` — pulls unused Drive file + unused TOS, burns overlay, creates Ready BOT row in Fansly Ops.

Requires ffmpeg, secrets in data/secrets/.

Never modify Airtable schema. Notes always BOT. Status Ready last. Unique file + TOS per model.