import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAuthorized } from "../../../lib/auth";
import { processEmail } from "../../../lib/pipeline";
import { buildAuditRecord, findExisting, logAudit } from "../../../lib/supabase";
import type { ProcessEmailResponse } from "../../../lib/types";

// Two Claude calls + a full-sheet fetch can exceed default limits.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().default(""),
  subject: z.string().default(""),
  textBody: z.string().default(""),
  htmlBody: z.string().optional(),
  date: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: `invalid request body: ${err instanceof Error ? err.message : err}` },
      { status: 400 }
    );
  }

  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

  // Soft dedupe (defense in depth — the real gate is the Gmail label in n8n).
  const existing = await findExisting(body.messageId);
  if (existing) {
    const dupe: ProcessEmailResponse = {
      messageId: body.messageId,
      threadId: body.threadId,
      reply_mode: "ignore",
      intent: "unknown",
      extracted: null,
      match: { found: false, confidence: "none", multipleMatches: false },
      reason: `Duplicate: message already processed (prior reply_mode: ${existing.reply_mode}).`,
      askedForInfo: false,
      dryRun,
    };
    return NextResponse.json(dupe);
  }

  // Never throw an unhandled error to n8n.
  let response: ProcessEmailResponse;
  try {
    response = await processEmail(body);
  } catch (err) {
    response = {
      messageId: body.messageId,
      threadId: body.threadId,
      reply_mode: "human_review",
      intent: "unknown",
      extracted: null,
      match: { found: false, confidence: "none", multipleMatches: false },
      reason: "Unhandled pipeline error — routing to human review.",
      askedForInfo: false,
      dryRun,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Always log, even on failure.
  await logAudit(buildAuditRecord(body, response));

  return NextResponse.json(response);
}
