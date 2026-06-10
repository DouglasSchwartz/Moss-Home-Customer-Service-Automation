-- Audit log for every email the Moss CS automation processes.
-- Run this in the Supabase SQL editor (or via supabase db push).

create table if not exists processed_messages (
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

create index if not exists idx_processed_messages_created_at
  on processed_messages (created_at desc);

create index if not exists idx_processed_messages_reply_mode
  on processed_messages (reply_mode);

-- Service-role access only; no anon policies. RLS on, no public policies.
alter table processed_messages enable row level security;
