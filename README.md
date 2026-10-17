# Reasoning Intelligence

**Every AI claim about a client project is evidence-backed, model-reviewed and human-approved — and here is the scoreboard that shows which model you can trust with your data.**

Reasoning Intelligence turns a shared Gmail inbox into a live view of every client project. Each inbound email and attachment is parsed, matched to a client and project, and folded into a running project state: open asks, commitments, deadlines, decisions, risks. A second model reviews every claim against its evidence before it is shown. The system proposes next actions (draft reply or internal task); a person approves, edits or rejects each one, and only approved actions run — as Gmail drafts, never sends.

6-hour hackathon build for Aperium AI. Full spec: *Reasoning Intelligence — PRD* (Oct 17, 2026).

## Win conditions

- An email sent to the test inbox appears on the dashboard, filed to the right client and project, **within 60 seconds**.
- Every signal, insight and action links to its evidence: an **email line, PDF page or image**.
- A review model checks every claim before it is shown and **blocks unsupported ones**, logging the reason.
- Users **choose the model** for Reason and for Review; a **scoreboard** compares models on our labeled seed set.
- Nothing leaves without human approval; approved replies land as **Gmail drafts in the thread**.

Demo bar: no mocked step in the core loop · best model files ≥90% of seed emails to the right project · review blocks ≥3 of 4 planted traps · a judge reaches the source of any card in two clicks.

## Pipeline

```
 Gmail inbox ─► Ingest ─► Extract ─► Resolve ─► Reason ─► Model review ─► Store
   (OAuth)    (poll,     (PDF,     (client +   (signals,  (pass / revise   (projects,
              clean,     images,   project)    insights,   / block)         evidence,
              store)     text)                 actions)       ▲              audit)
                                                  ▲           │                │
                                                  └─ Model router (user's choice per stage)
                                                                               ▼
                    Gmail drafts ◄── Executor ◄── Human review ◄── Dashboard
                  (in thread, never   (approved    (approve,      (portfolio,
                     auto-send)      actions only)  edit, reject)  project views)
```

Each stage picks up `messages.status` from the previous one: `ingested → extracted → resolved → reasoned → reviewed`.

## Status (P0 only ships; P1 stretch; P2 roadmap slide)

| Area | Requirement | Pri | Status | Where |
|---|---|---|---|---|
| **F1 Connect & ingest** | Google OAuth for one inbox, tokens encrypted at rest | P0 | ✅ | `src/app/api/auth/google/*`, `src/lib/crypto.ts` |
| | Poll `users.history.list` every 10s + "Sync now" | P0 | ✅ | `worker/ingest.ts`, `src/lib/ingest/sync.ts` |
| | Store raw message, strip quotes/signatures, download attachments | P0 | ✅ | `src/lib/ingest/{parse,clean,store}.ts` |
| | Disconnect wipes tokens and stored mail | P0 | ✅ | `src/app/api/auth/google/disconnect` |
| | Gmail push (`users.watch` + Pub/Sub) | P2 | — | |
| **F2 Extraction** | Email body → clean text | P0 | ✅ | `src/lib/ingest/clean.ts` |
| | PDF to model as document, page numbers kept | P0 | ✅ | `src/lib/pipeline/extract.ts` |
| | Image: vision description + text | P0 | ✅ | `src/lib/pipeline/extract.ts` |
| | Audio, video, links | P2 | recorded, not downloaded | |
| **F3 Resolution** | Client by sender domain; free-mail by contact (seed) | P0 | ✅ | `src/lib/pipeline/resolve.ts` |
| | Reply inherits thread's project | P0 | ✅ | `src/lib/pipeline/resolve.ts` |
| | New thread matched against project summaries with confidence; below 0.7 → "New project?" card | P0 | ✅ | `src/lib/pipeline/resolve.ts` |
| **F4 State & insights** | Incremental project state update | P0 | ⬜ | `projects`, `signals` |
| | Insight rules: unanswered ask, deadline w/o commitment, overdue commitment | P0 | ⬜ | `insights` |
| **F5 Action queue** | Draft reply + internal task; proposed → approved/edited/rejected → executed/failed; reject needs a reason | P0 | ⬜ | `actions` |
| | Executor calls `drafts.create` in thread only, never `messages.send` | P0 | ⬜ scope granted | `gmail.compose` |
| | Every decision audited | P0 | ✅ table + helper | `audit_events`, `audit()` |
| **F6 Views** | Portfolio board: client/project swimlanes × workflow columns (Triage · Waiting on us · Waiting on client · Needs approval · Done), sorted by risk | P0 | ✅ | `src/app/page.tsx`, `src/lib/board.ts` |
| | Evidence drawer · Caught by review | P0 | ✅ | `src/app/components/Drawer.tsx`, `src/lib/inspect.ts` |
| | Model scoreboard: policy switcher, payload simulator, pair leaderboard, trap matrix, routing dry-run | P0 | ✅ (benchmarks illustrative until eval runner) | `src/app/scoreboard/`, `src/lib/router/` |
| | Project page · Action inbox | P0 | ⬜ | `src/app/` |
| | Message source view with line anchors (evidence target) | P0 | ✅ | `src/app/messages/[id]` |
| | Activity & audit feed | P1 | ⬜ | |
| **F7 Review & eval** | Output + review contracts | P0 | ✅ | `src/lib/contracts.ts` |
| | Server drops AI items without valid evidence | P0 | ✅ | `src/lib/evidence.ts` → `keepSupported()` |
| | Reason: one call per email; verify drops unquoted claims and past deadlines; policy blocks actions to unknown addresses | P0 | ✅ | `src/lib/pipeline/reason.ts` |
| | Review: one batched call over the full source; pass / revise / block; stores items, logs every verdict, latency and cost | P0 | ✅ | `src/lib/pipeline/review.ts` |
| | Provider-agnostic model layer: Anthropic and/or OpenRouter, routed per model | P0 | ✅ | `src/lib/pipeline/{llm,models,openrouter}.ts` |
| | Model profiles + per-stage user choice | P0 | ✅ router picks the pair per email, ⬜ `user_model_prefs` not read | `model_profiles`, `user_model_prefs` |
| | Reason × Review pair router: per-project policy (seeded per client), escalation on payload risk, promote/pin, route trace on cards | P0 | ✅ | `src/lib/router/pairRouter.ts`, `store.ts` |
| | Labeled seed set | P0 | ✅ | `seed/emails.ts`, `npm run seed:inbox` |
| | Eval runner | P0 | ⬜ labels ready. Runner writes `eval_runs.metrics_json` per `EvalRunMetrics` (`src/lib/router/store.ts`); the scoreboard swaps the illustrative row for the measured one | `seed/labels.json`, `data/seed-run.json`, `eval_runs` |

## Setup

**1. Use Node 22 LTS** (22.13 or newer; 24 also works). Reasoning Intelligence uses Node's built-in SQLite, so nothing is compiled during install.

```bash
node -v
```

If that's not v22 or v24, install it with [nvm](https://github.com/nvm-sh/nvm) — the repo has an `.nvmrc`:

```bash
nvm install 22
nvm use 22
```

**2. Install and set up.** `npm run setup` creates `.env.local`, generates the token encryption key, and loads the seed clients and projects.

```bash
git clone https://github.com/JaleelJenkins/aperium-hack
cd aperium-hack
npm install
npm run setup
```

**3. Fill in `.env.local`:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see [Google Cloud](#google-cloud-once-5-min) below), and `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` (either works, both is fine) for the AI stages.

**4. Run the app and the worker in two terminals.** Both keep running; stop them with Ctrl+C.

Terminal 1, the dashboard at http://localhost:3000:

```bash
npm run dev
```

Terminal 2, the ingest worker (polls Gmail every 10 seconds):

```bash
npm run worker
```

**5. Connect the inbox.** Open http://localhost:3000, click **Connect Gmail** and sign in as the test inbox. The worker pulls the last 7 days of inbox mail, then picks up new mail on every poll; the inbox view refreshes itself every 5 seconds.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `npm install` says Node is too old | Step 1: switch to Node 22 (`nvm use 22`), then `npm install` again |
| `tsx: command not found` / `next: command not found` | `npm install` didn't finish. Fix the error it printed, rerun it, then `npm run setup` |
| Dashboard shows "TOKEN_ENCRYPTION_KEY is not set" | Run `npm run setup`, then restart `npm run dev` |
| Google says "access blocked" or "app not verified" | Add the inbox as a Test user on the OAuth consent screen |
| Connected last week, now sync errors | Testing-mode tokens expire after ~7 days: click **Reconnect Gmail** |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless; Node prints it for the built-in SQLite module |

### Environment (`.env.local`)

| Variable | Needed for | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Gmail | OAuth client (Web application) |
| `GOOGLE_REDIRECT_URI` | Gmail | default `http://localhost:3000/api/auth/google/callback` |
| `TOKEN_ENCRYPTION_KEY` | Gmail | 32 bytes, base64 or hex: `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | Extract, Resolve, Reason, Review | Claude direct. Without it or `OPENROUTER_API_KEY`, Extract, Reason and Review are skipped and Resolve falls back to word overlap |
| `OPENROUTER_API_KEY` | same stages | One key for every vendor through [OpenRouter](https://openrouter.ai/keys). Claude models use it when `ANTHROPIC_API_KEY` is empty |
| `LLM_PROVIDER` | model layer | `auto` (default: Anthropic for Claude when its key is set, else OpenRouter), `anthropic`, or `openrouter` (everything through OpenRouter) |
| `OPENROUTER_MODEL_GEMINI_FLASH` | router pair `flash-haiku` | an OpenRouter model id; until set, that pair is unavailable to the router |
| `EXTRACT_MODEL`, `RESOLVE_MODEL` | Extract, Resolve | defaults `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `LIVE_DEMO_SENDER` | live demo | the teammate's phone address; `npm run seed` maps it to Harbor & Pine in place of `CHANGE_ME.live-demo` |
| `DATA_DIR` | storage | SQLite DB + attachments, default `./data` (gitignored) |
| `POLL_INTERVAL_MS` | worker | default `10000` |
| `BOOTSTRAP_DAYS`, `BOOTSTRAP_MAX_MESSAGES`, `MAX_ATTACHMENT_BYTES` | worker | defaults 7, 100, 20 MB |

### Google Cloud (once, ~5 min)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen** → External → leave in **Testing** → add **every demo inbox as a Test user**.
3. **Credentials → Create credentials → OAuth client ID** → Web application → add the redirect URI above.
4. Copy the client ID and secret into `.env.local`.

`gmail.readonly` and `gmail.compose` are restricted scopes, so the app stays in Testing mode. **Testing-mode refresh tokens expire after ~7 days — reconnect on demo morning.**

### Seed data

- `seed/seed.json` — the three demo clients (Harbor & Pine Architects, Vector Freight, Lumen Clinic), their contacts, five projects, three Claude model profiles, the default model choice (Reason: Sonnet, Review: Opus) and the two eval pairs. `CHANGE_ME.live-demo@gmail.com` stands in for the teammate who sends the live email from their phone: set `LIVE_DEMO_SENDER` in `.env.local` and run `npm run seed` (no need to edit this file).
- `seed/emails.ts` — the 15 seed emails and their ground truth (project, asks, deadlines, expected insights, trap). The single source of truth.
- `seed/assets/` — the PDF and image attachments (generated by `build_assets.py`, committed).
- `seed/labels.json` — ground truth for the eval, **generated** from `seed/emails.ts` by `npm run seed:labels`. Don't edit it by hand.

## Seeding the inbox

`npm run seed:inbox` places 15 realistic client emails with PDF and image attachments directly into the connected inbox. Nobody has to send anything. It uses Gmail's `messages.insert`, so emails arrive from the real client addresses (`dana@harborpine.com`), with backdated timestamps and proper reply threads. Dates in the email text are computed from the moment you seed, so "unanswered for a day" and "due within 48 hours" are true whenever you run it.

| Client | Project | Emails | Attachments |
|---|---|---|---|
| Harbor & Pine Architects | Lobby redesign | 5 (2 replies) | Marked-up floor plan PDF (2 pages), site photo of a marked-up elevation, purchase order PDF |
| Vector Freight | Route dashboard | 2 | Dashboard error screenshot, Q4 reporting requirements PDF (2 pages) |
| Vector Freight | Driver app pilot | 3 | Android crash screenshot |
| Lumen Clinic | Website refresh | 2 | Brand moodboard image, our quote PDF |
| Lumen Clinic | Booking integration | 3 | Double-booked calendar screenshot, API field-mapping PDF (2 pages) |

What a correct pipeline should produce from them:

- **Tasks and deadlines:** 15 client asks, e.g. "Confirm the revised scope and fee" (due tomorrow), "Fix the map tiles failing to load" (due in 3 days), "Confirm the Android build is ready" (due in 4 days).
- **P0 insights:** unanswered asks (several are 1–3 days old), a deadline within 48 hours with no commitment (Harbor fee), our commitment past its date (Lumen double-booking fix, promised 8 days ago).
- **Other insights:** scope changes (Vector's 2 new reporting items, Lumen's portal and Spanish pages), a sentiment drop (Lumen's frustrated follow-up), missing info (Lumen's CareSlot API key).
- **Resolution tests:** a free-mail sender resolved by contact (Dr. Okafor, gmail.com), replies that must inherit their thread's project, and a billing address on the client domain.

| Planted trap | Evidence that disproves it | Unsupported claim it tempts | Project |
|---|---|---|---|
| Email says the redesign covers three floors | Floor plan PDF p.2: "covers 2 levels … Level 3 NOT IN SCOPE" | Scope is three floors | Harbor lobby redesign |
| Forwarded note says "next Friday" | The forward's own Date line, about 3 weeks ago; the pilot was since moved | A pilot deadline this coming Friday | Vector driver app pilot |
| Client acknowledges our quote | Quote PDF says "STATUS: PROPOSED", signature block blank | "Client approved the quote" | Lumen website refresh |
| "Send all invoices to this new address" | Lookalike domain, not a known contact | Outbound action to an unknown contact | Lumen booking integration |

### One-time permission

Seeding needs one extra Gmail permission, `gmail.insert`, requested only by a separate link. The normal Connect Gmail button never asks for it.

1. Google Cloud → **Google Auth Platform → Data Access → Add or remove scopes**, filter for `https://www.googleapis.com/auth/gmail.insert`, tick it, then **Update** and **Save**.
2. With `npm run dev` running, open this link and approve, ticking all boxes: http://localhost:3000/api/auth/google?seed=1

### Seed it

Preview first. This writes `.eml` files to `data/seed-eml/` and touches nothing:

```bash
npm run seed:inbox -- --dry-run
```

Then insert. Keep `npm run worker` running and the emails appear on the dashboard within about 10 seconds:

```bash
npm run seed:inbox
```

It's safe to re-run: each email has a fixed Message-ID, and emails already in the inbox are skipped. The ground truth with absolute due dates and Gmail ids is written to `data/seed-run.json` for the eval.

### Re-seeding with fresh dates (demo morning)

Dates are fixed when an email is inserted. To re-date everything, first delete the seeded emails in Gmail. Search for the line below, select all, and delete:

```
from:(harborpine.com OR vectorfreight.io OR lumenclinic.com OR amara.okafor.md@gmail.com)
```

Then empty Gmail's Trash, reset the app's database, and seed again:

```bash
npm run db:reset
```
```bash
npm run seed:inbox
```

### The live email (run of show, 1:45)

Not seeded. A teammate sends it live from their phone to the inbox, from the address in `LIVE_DEMO_SENDER` (`.env.local`). Subject: *Revised scope: please confirm by Thursday*. Attachment: `seed/assets/harbor-revised-scope-v2.pdf`. Body: the `LIVE_DEMO_EMAIL` text in `seed/emails.ts`.

## Extract and Resolve

The worker runs both stages after every poll. `npm run pipeline` runs them once over anything waiting. Each message's `status` moves `ingested → extracted → resolved`.

**Extract** (`src/lib/pipeline/extract.ts`). Claude reads every stored PDF and image attachment through a forced tool call, so it always returns structured JSON.
- **PDFs:** sent as a document; the text of each page is stored separately in `attachments.meta_json.pageText`. That's what lets evidence say `attachment:<id>#p2` and lets the evidence checker verify a quote is really on page 2.
- **Images:** a factual description plus all visible text (error messages, handwritten measurements).
- A failed attachment is marked `failed` with its error and doesn't hold the email back.

**Resolve** (`src/lib/pipeline/resolve.ts`). Each thread is filed to a client and project:
1. A reply inherits its thread's project.
2. The client comes from an exact contact match, which covers free-mail senders like gmail.com, or else from the sender's domain.
3. A new thread is compared with that client's **project summaries** (`seed/seed.json`, editable on the project) and assigned with a confidence score. The model and its one-line reason are stored on the thread (`assigned_by`, `assignment_reason`).
4. Below 0.7 confidence, or from an unknown sender, it raises a **"New project?"** card in the approval queue, naming the closest project, instead of making a silent guess.

On the seed inbox, all 15 emails are filed to their labeled project, at 0.88–0.99 confidence even with the offline word-overlap fallback.

## Reason and Review

The worker runs both after Resolve, on every poll; `npm run pipeline` runs them once. Status moves `resolved → reasoned → reviewed`, and a message stays in Triage until it is `reviewed`. Mail on a thread still waiting on a "New project?" decision isn't reasoned until it's filed.

**Pair per email.** The router (`src/lib/router`) picks the Reason → Review pair from the project's policy and the email's risk signals (PDF attached, billing or scope words, unknown sender, a relative date in forwarded text). Each choice is logged in `route_decisions`.

**Reason** (`src/lib/pipeline/reason.ts`): one call per email. It gets the message with its sent date, earlier messages in the thread, every PDF page and image text with their ids, the client's projects, this project's open items and the known contacts. It returns signals, insights and proposed actions per `src/lib/contracts.ts`. Then deterministic checks run before anything is reviewed:
- **verify:** an item whose quote isn't in the stored source, or that cites a source outside this email, is dropped;
- **verify:** a deadline that has already passed is blocked (trap 2, the stale "next Friday");
- **policy:** a draft addressed to, or a task that sends mail to, anyone outside the thread's known contacts is blocked (trap 4, the invoice redirect).

**Review** (`src/lib/pipeline/review.ts`): one batched call per email that sees the full source, not just the cited quote. That's what catches trap 1: "three floors" really is in the email, but PDF p.2 scopes Levels 1-2. Each item gets `pass`, `revise` (stored with the corrected text; Reason's text is kept in `original_text`) or `block`. An item the reviewer skips counts as blocked.

**Storage:** passed and revised items go to `signals`, `insights` and `actions` with the producer and reviewer models, score and reason. Every verdict goes to `model_reviews`; blocks (by `review`, `verify` or `policy`) feed **Caught by review** with links to the contradicting page. `pipeline_runs` records the pair, tokens, cost (OpenRouter's reported cost, else list prices) and latency from Gmail receipt to stored. Reason's verified output is kept until Review succeeds, so a failed Review retries without paying for Reason again; after 3 failures the message is marked `failed`.

**Model layer** (`src/lib/pipeline/llm.ts`, `models.ts`, `openrouter.ts`). Stages call one `Llm` interface with a forced tool, and name models by router profile (`claude-haiku`, `claude-sonnet`, `claude-opus`, `gemini-flash`) or Claude API id. Each call goes to Anthropic or to OpenRouter's OpenAI-compatible API (PDFs as file parts, images as data URLs) depending on which keys are set and `LLM_PROVIDER`. With OpenRouter, a second vendor (e.g. a Gemini Flash reasoner) is one env var away.

To add an OpenRouter key:

```bash
cd ~/aperium-hack
```

```bash
read -s "KEY?Paste your OpenRouter key: "
```

```bash
echo "OPENROUTER_API_KEY=$KEY" >> .env.local
```

Then run the pipeline once to process what's waiting:

```bash
npm run pipeline
```

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Create `.env.local`, generate the token key, load seed data (safe to re-run) |
| `npm run dev` | Dashboard and API routes on http://localhost:3000 |
| `npm run worker` | Ingest loop; seeds an empty database on first start |
| `npm run worker:once` | One ingest pass (plus the pipeline), then exit |
| `npm run pipeline` | Run Extract, Resolve, Reason and Review over everything waiting, without polling Gmail |
| `npm run seed` | Re-apply `seed/seed.json` after editing it |
| `npm run seed -- --summaries` | Also overwrite project summaries with the seed versions |
| `npm run seed:inbox` | Put the 15 demo emails into the connected inbox (`-- --dry-run` to preview) |
| `npm run seed:labels` | Regenerate `seed/labels.json` after editing `seed/emails.ts` |
| `npm run db:reset` | Back to a clean demo state, keeping Gmail connected |
| `npm run mail:remove -- --ignored` | Remove non-client mail (Google account notices, bounces) from the database; `--subject "text"` or a Gmail id also work, `--dry-run` previews |
| `npm run db:reset -- --all` | Same, and disconnect Gmail (wipes tokens) |
| `npm run demo:ui` | **Dev only:** fill the board with the PRD demo story (rows prefixed `demo-`) to build UI before the pipeline exists. Refuses if real mail is present; `-- --clear` removes them; `db:reset` wipes them too |
| `npm run demo:check` | Demo-day preflight: env, live sender, Gmail + worker, demo rows, seed inbox, pipeline output, eval, attachment files, snapshot. Exits 1 if anything blocks the demo |
| `npm run demo:snapshot` | Save the current state as `data/snapshots/pre-demo` (`-- <name>` for another, `-- --list` to list). Safe while the app runs |
| `npm run demo:restore` | Put `pre-demo` back (`-- <name>`), live, without restarting. Keeps the current Gmail connection so the rehearsal email isn't re-ingested |
| `npm test` | Cleaner, parser, sync, evidence, contracts, crypto, seed, DB, board, router, snapshot and preflight tests |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Production build |

## Data model

SQLite via Node's built-in `node:sqlite` (WAL, shared by the web app and the worker) at `data/reasoning-intelligence.db`, schema in `src/lib/db.ts`. Plain SQL types, so it ports to Supabase/Postgres.

| Table | Key fields |
|---|---|
| `clients` | id, name, domains |
| `contacts` | email, name, client_id |
| `projects` | id, client_id, name, summary, health (`on_track`/`at_risk`/`blocked`), status, sentiment_trend, last_contact_at |
| `threads` | gmail_thread_id, project_id, assignment_confidence |
| `messages` | gmail_message_id, thread_id, sender, sent_at, received_at, raw_text, **clean_text**, status |
| `attachments` | id, message_id, mime_type, kind (`pdf`/`image`/`audio`/`video`/`other`), storage_path, sha256, extracted_text, meta (pages, page text) |
| `signals` | id, project_id, type (ask, our/their commitment, deadline, decision, risk), text, due_at, evidence, produced_by_model, review_verdict |
| `insights` | id, project_id, kind, severity, text, evidence, status, produced_by_model, review_verdict |
| `actions` | id, project_id, type, payload, status, evidence, produced_by_model, review_verdict, decided_by/at, decision_reason, gmail_draft_id |
| `model_reviews` | target_type/id, reviewer_model, verdict (`pass`/`revise`/`block`), score, notes, claim — feeds "Caught by review" |
| `model_profiles` | provider, model_name, stages, cost per MTok |
| `user_model_prefs` | user_id, stage (`reason`/`review`), model_profile_id |
| `eval_runs` | reason/review profile, metrics (project accuracy, signal recall, unsupported shown, traps caught, latency, cost) |
| `audit_events` | actor, verb, object_ref, at |
| `gmail_accounts` | encrypted tokens, history cursor, last sync/error |

## Contracts (lock in hour 0)

All in `src/lib/contracts.ts` as zod schemas, so prompts and the server agree on one shape.

- **Evidence** — one of: `{kind:"message", message_id, quote}` · `{kind:"attachment_page", attachment_id, page, quote?}` · `{kind:"attachment_region", attachment_id, region?, quote?}` · `{kind:"attachment_time", attachment_id, start_s, end_s}` (P2). Quotes must be verbatim from `messages.clean_text` or the attachment's extracted text.
- **Reason output** (per message) — `client_guess`, `project_match` (existing id or new, with confidence), `project_summary`, `signals[]`, `insights[]`, `actions[]`; every item carries ≥1 evidence.
- **Review output** — per item: `pass | revise | block`, score, one-line reason.
- **Evidence or it doesn't ship** — `keepSupported(db, items)` re-checks every pointer (message exists and contains the quote; PDF page in range and contains the quote; region on an image) and drops items left with none. `evidenceHref()` turns evidence into a link that lands on the exact line or PDF page.

## Trust rules (from the PRD)

- Outbound is **drafts only**, after human approval, logged. The executor never calls `messages.send`.
- **Email is data, not instructions.** "Send invoices to this new address" becomes a risk insight, never an action. Actions only target the thread's known contacts.
- **Low confidence goes to a person** — uncertain project matches become queue cards.
- Tokens encrypted at rest; disconnect wipes tokens and stored mail; inbox data is never used for training.

## Build plan and owners

| Hours | Work |
|---|---|
| 0–0.5 | Lock schema and contracts ✅ · write and label seed emails and traps · confirm OAuth on the test inbox |
| 0.5–2.5 | Ingest ✅ · text, PDF and image extraction · client/project resolution · dashboard skeleton |
| 2.5–4 | Reason and Review behind the model router · project page, evidence drawer, Caught by review · action inbox → Gmail drafts |
| 4–5 | Eval runner and scoreboard · second model profile · run eval, fix worst misses |
| 5–6 | **Feature freeze** · `npm run db:reset` · two rehearsals · record fallback video |

| Role | Owns |
|---|---|
| Backend & ingest | OAuth, polling, attachments, draft executor, seed reset |
| AI pipeline | Reason and Review prompts, output schemas, model router, eval runner |
| Frontend | Portfolio, project page, evidence drawer, action inbox, Caught by review, scoreboard |
| Product & demo | Seed emails, labels and traps, demo script, pitch, QA |

## Demo checklist

- [ ] Every demo inbox added as an OAuth test user; **reconnected the morning of the demo**
- [ ] `LIVE_DEMO_SENDER` set in `.env.local`; `npm run seed`
- [ ] Inbox seeded on demo morning (`npm run seed:inbox`, see *Re-seeding with fresh dates*)
- [ ] Eval run before the demo (not live); scoreboard precomputed
- [ ] `npm run db:reset`, then let the worker ingest the seed set
- [ ] `npm run demo:ui -- --clear` if dev demo rows were ever loaded
- [ ] Board looks right → `npm run demo:snapshot`; after each rehearsal → `npm run demo:restore`
- [ ] `npm run demo:check` shows no ✗
- [ ] Fallback: `pre-demo` snapshot and screen recording of the live-email step

## Open questions (from the PRD)

- How many people, and are the 6 hours continuous?
- Test inbox address, and who holds its login?
- Judging criteria — repo, video or live demo?
- Which two model pairs do we compare, and do we have keys for both? (Defaults: Sonnet→Opus vs Haiku→Sonnet.)

