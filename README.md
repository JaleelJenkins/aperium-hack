# Client Pulse

Turns a shared Gmail inbox into a live view of every client project, where each AI claim is evidence-backed, model-reviewed and human-approved. Built for the Aperium hackathon.

```
Gmail inbox → Ingest → Extract → Resolve → Reason → Model review → Store → Dashboard → Human review → Executor → Gmail drafts
   ✅ built     ✅ built   next
```

This repo currently implements the first two stages: **Gmail inbox** (OAuth to one test inbox) and **Ingest** (history poll, clean, store).

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm run dev                     # dashboard on http://localhost:3000
npm run worker                  # second terminal: polls Gmail every 10s
```

Open the dashboard, click **Connect Gmail**, sign in as the test inbox. The worker pulls the last 7 days of inbox mail, then picks up new mail on every poll. Send an email to the test inbox and it shows up within one poll (≈10s) — the dashboard refreshes itself every 5s.

### Google Cloud setup (once, ~5 min)

1. console.cloud.google.com → new project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen** → External, Testing mode → add the test inbox under **Test users**.
3. **Credentials → Create credentials → OAuth client ID** → Web application → add redirect URI `http://localhost:3000/api/auth/google/callback`.
4. Copy the client ID/secret into `.env.local`.

Scopes requested: `gmail.readonly` (ingest) and `gmail.compose` (approved replies become drafts later; nothing is ever sent).

## How ingest works

| Step | Where | What happens |
|---|---|---|
| Connect | `src/app/api/auth/google/*` | OAuth with CSRF state cookie; refresh token stored in `gmail_accounts`. |
| Bootstrap | `src/lib/ingest/sync.ts` | First sync reads the current `historyId`, then ingests `in:inbox newer_than:7d`, oldest first. |
| Poll | `src/lib/ingest/sync.ts` | `users.history.list` since the cursor, `messageAdded` on `INBOX` only. Drafts and our own sent mail are skipped. Cursor only advances when the whole batch stored; failures retry next poll. Expired cursor (Gmail 404) → automatic re-bootstrap. |
| Parse | `src/lib/ingest/parse.ts` | Walks MIME parts; prefers `text/plain`, falls back to HTML→text; decodes charsets; parses address lists; finds attachments and inline images. |
| Clean | `src/lib/ingest/clean.ts` | Strips quoted history (Gmail “On … wrote:”, Outlook headers, `>` lines), signatures and mobile footers. Keeps forwarded content. `body_raw` keeps the original. |
| Store | `src/lib/ingest/store.ts` | Idempotent insert (`INSERT OR IGNORE` on Gmail id; existing ids are never refetched). PDFs and images are downloaded to `data/attachments/` with sha256; other types, oversized files and tiny inline logos are recorded as `skipped`. Every ingest writes an `audit_log` row. |

### Data model (`src/lib/db.ts`)

SQLite (WAL, shared by the web app and worker) at `data/client-pulse.db`. Plain SQL types so it ports to Supabase/Postgres.

- `gmail_accounts` — tokens, history cursor, last sync/error
- `emails` — headers, `body_raw`, `body_clean`, `status`, `client_id`/`project_id` (filled by Resolve)
- `attachments` — kind `pdf|image|other`, `status stored|skipped|failed`, `storage_path`, `sha256`
- `audit_log` — who did what, when

### Handoff to Extract

Extract should pick up `SELECT * FROM emails WHERE status = 'ingested'` plus their `attachments WHERE status = 'stored'`, then set `status = 'extracted'`. Status flow: `ingested → extracted → resolved → reasoned → reviewed`.

### Evidence anchors (`src/lib/evidence.ts`)

Every downstream signal must cite one of these, and each resolves to a dashboard URL in one click:

- `email:<id>#L4-L6` → `/emails/<id>#L4` (lines of `body_clean`, highlighted on the email page)
- `attachment:<id>#p3` → `/api/attachments/<id>#page=3`
- `attachment:<id>` → the image

## Scripts

```bash
npm run worker          # poll loop
npm run worker:once     # single pass
npm run db:reset        # clear mail + cursor (keeps Gmail connection); add -- --all to disconnect too
npm test                # parser, cleaner, sync (fake Gmail), evidence refs
npm run typecheck
```
