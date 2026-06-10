import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { ProcessEmailResponse } from "./types";

let _client: SupabaseClient | null = null;

function client(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // logging is best-effort; never block the pipeline
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export type AuditRecord = {
  gmail_message_id: string;
  gmail_thread_id: string;
  sender: string;
  recipient: string;
  subject: string;
  body_preview: string;
  extracted: unknown;
  intent: string;
  match: unknown;
  reply_mode: string;
  generated_reply: string | null;
  reason: string;
  asked_for_info: boolean;
  dry_run: boolean;
  error: string | null;
};

// Prefixed table name: the audit log lives in the shared Expert AI Labs
// Supabase project, so the Moss table carries a client prefix for isolation.
const TABLE = "moss_processed_messages";

/** Returns the prior response if this messageId was already processed. */
export async function findExisting(
  gmailMessageId: string
): Promise<{ reply_mode: string; reason: string } | null> {
  const sb = client();
  if (!sb) return null;
  try {
    const { data } = await sb
      .from(TABLE)
      .select("reply_mode, reason")
      .eq("gmail_message_id", gmailMessageId)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

/** Always-log, never-throw audit write. */
export async function logAudit(record: AuditRecord): Promise<void> {
  const sb = client();
  if (!sb) {
    console.warn("Supabase not configured — audit record:", JSON.stringify(record));
    return;
  }
  try {
    const { error } = await sb.from(TABLE).insert(record);
    if (error) console.error("Supabase audit insert failed:", error.message);
  } catch (err) {
    console.error("Supabase audit insert threw:", err);
  }
}

export function buildAuditRecord(
  req: {
    messageId: string;
    threadId: string;
    from: string;
    to: string;
    subject: string;
    textBody: string;
  },
  res: ProcessEmailResponse
): AuditRecord {
  return {
    gmail_message_id: req.messageId,
    gmail_thread_id: req.threadId,
    sender: req.from,
    recipient: req.to,
    subject: req.subject,
    body_preview: (req.textBody ?? "").slice(0, 500),
    extracted: res.extracted,
    intent: res.intent,
    match: res.match,
    reply_mode: res.reply_mode,
    generated_reply: res.reply ?? null,
    reason: res.reason,
    asked_for_info: res.askedForInfo,
    dry_run: res.dryRun,
    error: res.error ?? null,
  };
}
