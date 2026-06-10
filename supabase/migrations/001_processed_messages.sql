-- Audit log for every email the Moss CS automation processes.
-- Table is prefixed moss_ because it lives in the shared Expert AI Labs
-- Supabase project; the prefix keeps Moss data clearly siloed.

create table if not exists moss_processed_messages (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text unique not null,
  gmail_thread_id text,
  sender text,
  recipient text,
  subject text,
  body_preview text,
  extracted jsonb,
  intent text,
  match jsonb,
  reply_mode text,
  generated_reply text,
  reason text,
  asked_for_info boolean default false,
  dry_run boolean default true,
  error text,
  created_at timestamptz default now()
);

create index if not exists idx_moss_processed_messages_created_at
  on moss_processed_messages (created_at desc);

create index if not exists idx_moss_processed_messages_reply_mode
  on moss_processed_messages (reply_mode);

-- Service-role access only; RLS on with no public policies.
alter table moss_processed_messages enable row level security;
