import { extract, generate } from "./claude";
import {
  cleanEmailBody,
  extractEmailAddress,
  isSkippableSender,
} from "./email-cleanup";
import { handleFabricInquiry, handleStockReply } from "./fabric-pipeline";
import { lookupOrderAcrossSheets } from "./matching";
import { decideReplyMode } from "./safety";
import type {
  ExtractionResult,
  LookupResult,
  ProcessEmailRequest,
  ProcessEmailResponse,
} from "./types";

const NO_MATCH: ProcessEmailResponse["match"] = {
  found: false,
  confidence: "none",
  multipleMatches: false,
};

function isDryRun(): boolean {
  return (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
}

/**
 * Linear pipeline: cleanup -> extract -> lookup -> safety gate -> generate.
 * No branching tree. Lookup ALWAYS runs when identifiers exist — this is the
 * core fix for the Zapier failure where answerable emails never got looked up.
 */
export async function processEmail(
  req: ProcessEmailRequest
): Promise<ProcessEmailResponse> {
  const dryRun = isDryRun();
  const base = {
    messageId: req.messageId,
    threadId: req.threadId,
    dryRun,
  };

  // Self-protection: never process automated/no-reply senders.
  if (isSkippableSender(req.from)) {
    return {
      ...base,
      reply_mode: "ignore",
      intent: "spam_or_unrelated",
      extracted: null,
      match: NO_MATCH,
      reason: `Sender "${req.from}" is on the automated/no-reply skip list.`,
      askedForInfo: false,
    };
  }

  // Warehouse (Jose) or mill replying to one of our stock inquiries?
  // Identified by the [MOSS-REF ...] tag quoted in their reply. Runs BEFORE
  // everything else — these are operational emails, not customer emails.
  const stockReply = await handleStockReply(base, req.textBody);
  if (stockReply) return stockReply;

  const cleaned = cleanEmailBody(req.textBody);

  // Never answer the same question twice: if one of OUR replies is embedded
  // in this email (a forward or FYI of an answered thread) and the sender
  // added no new text of their own, stay silent. A customer replying with
  // requested info (e.g. an order number) HAS new text and proceeds normally.
  if (cleaned.containsOwnReply && cleaned.newContent.length === 0) {
    return {
      ...base,
      reply_mode: "ignore",
      intent: "unclear",
      extracted: null,
      match: NO_MATCH,
      reason:
        "This email contains one of our previous replies with no new message from the sender (forward/FYI) — already answered, not replying again.",
      askedForInfo: false,
    };
  }

  // 1. Extract
  let extraction: ExtractionResult;
  try {
    extraction = await extract({
      from: req.from,
      subject: req.subject,
      body: cleaned.text,
      isForwarded: cleaned.isForwarded,
    });
  } catch (err) {
    return {
      ...base,
      reply_mode: "human_review",
      intent: "unknown",
      extracted: null,
      match: NO_MATCH,
      reason: "Extraction failed validation — routing to human review.",
      askedForInfo: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Misclassification guard: a "fabric_status" email naming fabrics but NO
  // order identifier is really a stock/availability question.
  if (
    extraction.intent === "fabric_status" &&
    extraction.fabricRequests.length > 0 &&
    !extraction.ampOrderNumber &&
    !extraction.poNumber &&
    !extraction.invoiceNumber
  ) {
    extraction = { ...extraction, intent: "fabric_stock_inquiry" };
  }

  // Fabric stock / availability inquiries take their own path (BarCloud,
  // warehouse, mill) — no order lookup involved.
  if (extraction.intent === "fabric_stock_inquiry") {
    try {
      return await handleFabricInquiry(base, extraction);
    } catch (err) {
      return {
        ...base,
        reply_mode: "human_review",
        intent: extraction.intent,
        extracted: extraction,
        match: NO_MATCH,
        reason: "Fabric stock flow failed — routing to human review.",
        askedForInfo: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 2. Lookup — prefer the embedded original sender for forwarded emails.
  // Searches MASTER + Basics first, then the archive sheets.
  const senderEmail =
    extraction.customerEmail ??
    cleaned.embeddedSender ??
    extractEmailAddress(req.from);

  let lookup: LookupResult;
  try {
    lookup = await lookupOrderAcrossSheets(extraction, senderEmail);
  } catch (err) {
    return {
      ...base,
      reply_mode: "human_review",
      intent: extraction.intent,
      extracted: extraction,
      match: NO_MATCH,
      reason: "Smartsheet lookup failed — routing to human review.",
      askedForInfo: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const matchSummary: ProcessEmailResponse["match"] = {
    found: lookup.found,
    matchType: lookup.matchType,
    matchedKey: lookup.matchedKey,
    matchedColumn: lookup.matchedColumn,
    rowId: lookup.rowId,
    confidence: lookup.confidence,
    multipleMatches: lookup.multipleMatches,
    candidateCount: lookup.candidateCount,
  };

  // 3. Deterministic safety gate
  const decision = decideReplyMode(extraction, lookup);

  // 4. Generate a reply only when it could be sent or drafted
  let reply: string | undefined;
  if (decision.reply_mode === "auto_reply" || decision.reply_mode === "draft_only") {
    try {
      reply = await generate({
        fromName: extraction.senderName,
        subject: req.subject,
        body: cleaned.text,
        extraction,
        lookup,
        useShippedLanguage: decision.useShippedLanguage,
        askForInfo: decision.askForInfo,
        comMode: decision.comMode,
      });
    } catch (err) {
      return {
        ...base,
        reply_mode: "human_review",
        intent: extraction.intent,
        extracted: extraction,
        match: matchSummary,
        reason: "Reply generation failed lint after retry — routing to human review.",
        askedForInfo: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    ...base,
    reply_mode: decision.reply_mode,
    intent: extraction.intent,
    extracted: extraction,
    match: matchSummary,
    reply,
    reason: decision.reason,
    askedForInfo: decision.askForInfo,
  };
}
