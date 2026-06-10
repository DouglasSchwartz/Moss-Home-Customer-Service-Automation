# Moss Home USA — CS Email Automation

Automated customer-service email responder. **n8n** watches the Moss CS Gmail inbox
(`support@mosshomeusa.com`) and sends replies; this **Vercel-hosted Next.js app** is the
brain: it classifies the email (Claude), looks up the order in Smartsheet (code, not
nodes), applies a deterministic safety gate, and returns a reply decision.

**v1 scope:** clean WISMO/order-status emails with an exact AMP Order #, Customer PO #,
or Invoice # match auto-reply. Everything else routes to human review. The system starts
in **dry-run mode** (label + log only, no sending).

## Architecture

```
Gmail (support@mosshomeusa.com)
  -> n8n "Moss Home - CS Auto-Reply" (isolated Moss Home USA project)
       1. Gmail Trigger (excludes label cs-auto-processed)
       2. Add label cs-auto-processed immediately (idempotency, closes race)
       3. POST /api/process-email  (Bearer PROCESS_API_SECRET)
       4. Route by reply_mode -> labels (+ Gmail reply when live AND auto_reply)
  -> Vercel brain: cleanup -> extract (Claude) -> Smartsheet lookup -> safety gate
       -> generate (Claude) -> Supabase audit log
```

| reply_mode     | Meaning                                            | n8n action                                  |
|----------------|----------------------------------------------------|---------------------------------------------|
| `auto_reply`   | Safe, exact-match WISMO answer                     | Send reply in-thread (live mode only)       |
| `draft_only`   | Reply generated but needs a human eye              | Label `cs-draft-only`                       |
| `human_review` | Risky/ambiguous (COM, complaints, no match, etc.)  | Label `cs-human-review`                     |
| `ignore`       | Spam/duplicate/no-reply sender                     | Label `cs-ignore`                           |

## Setup

### 1. Deploy this repo to Vercel

1. Import the GitHub repo into Vercel (framework auto-detects Next.js).
2. Set env vars from `.env.example`:
   - `ANTHROPIC_API_KEY` — Moss Anthropic account
   - `SMARTSHEET_API_TOKEN` — token "NBN Customer Service Automation"
   - `SMARTSHEET_SHEET_ID` — numeric ID of "MASTER: Open Orders Sheet" (verify below)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `PROCESS_API_SECRET` — `openssl rand -hex 32`; same value goes in n8n
   - `DRY_RUN=true` — keep true until dry-run review is complete
3. Confirm `GET /api/health` returns `{ "status": "ok", "dryRun": true }`.

### 2. Verify the Smartsheet sheet ID and columns

```bash
cp .env.example .env   # fill in SMARTSHEET_API_TOKEN
npm install
npm run sync-columns   # lists sheets -> set SMARTSHEET_SHEET_ID -> re-run
```

The script prints every sheet the token can see, the live column map, a diff against
`lib/smartsheet-columns.ts`, and 3 sample rows. It fails loudly if a critical column
(AMP Order #, Invoice #, ACCOUNT EMAIL, Order Status, Estimated Shipping) is missing.

### 3. Supabase audit table

Run `supabase/migrations/001_processed_messages.sql` in the Supabase SQL editor.
This table is where the would-be replies are reviewed during dry-run.

### 4. Gmail labels

Create these labels in `support@mosshomeusa.com`:
`cs-auto-processed`, `cs-auto-replied`, `cs-auto-ready`, `cs-dry-run`,
`cs-human-review`, `cs-draft-only`, `cs-ignore`, `cs-error`.

### 5. n8n (isolated Moss Home silo)

1. Create a **Project named `Moss Home USA`** (or a dedicated folder if the plan has no Projects).
2. Create scoped credentials inside it:
   - `Moss Home - Gmail (CS Inbox)` — Gmail OAuth2 for `support@mosshomeusa.com` only
   - `Moss Home - Process API (HTTP Header Auth)` — header `Authorization`, value `Bearer <PROCESS_API_SECRET>`
3. Import `n8n/moss-home-cs-auto-reply.json` into the project.
4. Replace placeholders: Vercel URL, credential IDs, and the Gmail label IDs
   (n8n's label dropdowns resolve them once the Gmail credential is connected).
5. Tag the workflow `client:moss-home`. Activate.

No Smartsheet credential exists in n8n by design — the lookup lives in this repo.

### 6. Dry-run review, then go live

1. With `DRY_RUN=true`, let real emails flow for a review period.
2. Jacq reviews `processed_messages` in Supabase (especially `generated_reply`,
   `reply_mode`, `reason`) and the Gmail labels.
3. Watch for `reason` containing "sync gap" — identifiers that should have matched.
4. When the WISMO path is proven: set `DRY_RUN=false` in Vercel and redeploy.
   n8n then sends only when `reply_mode === "auto_reply"`.

## Development

```bash
npm test          # vitest suite (Claude + Smartsheet mocked)
npm run typecheck
npm run dev       # local Next.js
```

## Key safety rules (enforced in code, not just prompts)

- Ship timing comes from **Estimated Shipping** ("Early July"), never **Est Ship Week**.
- Wording is **"estimated for completion"** — a lint rejects "scheduled to ship",
  em dashes, and internal system names before any reply leaves the building.
- A found order is NEVER asked for its order number.
- Pending Materials / shipped-without-tracking / cancelled / multiple matches / COM /
  quotes / complaints all route to humans in v1.
- Every decision is logged to Supabase, including failures.
