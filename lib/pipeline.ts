import { extract, generate } from "./claude";
import {
  COM_PUSHBACK_RE,
  buildComTrackingRequest,
  evaluateComShipmentClaim,
  greetingFirstName,
  mentionsCom,
} from "./com";
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

  // Misclassification guard: the model sometimes labels a stock/availability
  // question as fabric_status / quote_request / yardage_request while still
  // populating fabricRequests. When the email names fabrics, carries no order
  // identifier, and reads like an availability question, route it through the
  // fabric stock flow. Pure pricing quotes (no stock language) are left alone.
  const STOCK_LANGUAGE_RE =
    /\b(in stock|stock|available|availability|on hand|do you have|carry|inventory|how many yards|enough)\b/i;
  const REDIRECTABLE_INTENTS = [
    "fabric_status",
    "quote_request",
    "yardage_request",
    "general_customer_service",
  ];
  if (
    REDIRECTABLE_INTENTS.includes(extraction.intent) &&
    extraction.fabricRequests.length > 0 &&
    !extraction.ampOrderNumber &&
    !extraction.poNumber &&
    !extraction.invoiceNumber &&
    STOCK_LANGUAGE_RE.test(`${req.subject}\n${cleaned.text}`)
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

  // COM follow-up: the sender is replying to one of our messages in a COM
  // thread, pushing back that the fabric should already be here, while our
  // records still show it NOT received. Ask for the COM shipment tracking
  // number (or hand to a human to trace) instead of repeating "not received".
  const newText = cleaned.newContent || cleaned.text;
  const claimsComShipped =
    cleaned.containsOwnReply &&
    mentionsCom(req.textBody) &&
    (extraction.comShipmentClaimed || COM_PUSHBACK_RE.test(newText));
  if (claimsComShipped && lookup.found) {
    const lineItems =
      lookup.rows && lookup.rows.length > 0
        ? lookup.rows
        : lookup.row
          ? [lookup.row]
          : [];
    const outcome = evaluateComShipmentClaim({
      lineItems,
      newContent: newText,
      fullText: req.textBody,
    });
    if (outcome === "ask_tracking") {
      return {
        ...base,
        reply_mode: "auto_reply",
        intent: extraction.intent,
        extracted: extraction,
        match: matchSummary,
        reply: buildComTrackingRequest(
          greetingFirstName(extraction.senderName, req.from)
        ),
        reason:
          "COM not received on file but sender indicates it was sent — asking for the COM shipment tracking number.",
        askedForInfo: false,
      };
    }
    if (outcome === "human_trace") {
      return {
        ...base,
        reply_mode: "human_review",
        intent: extraction.intent,
        extracted: extraction,
        match: matchSummary,
        reason:
          "COM not received on file; sender already gave or was already asked for tracking — needs a human to trace the shipment.",
        askedForInfo: false,
      };
    }
    if (outcome === "human_unclear") {
      return {
        ...base,
        reply_mode: "human_review",
        intent: extraction.intent,
        extracted: extraction,
        match: matchSummary,
        reason:
          "COM receipt status is mixed/unclear/cancelled while the sender disputes it — needs a human.",
        askedForInfo: false,
      };
    }
    // outcome === null -> fall through to the normal COM/status handling below.
  }

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
        readyForPickupSoon: decision.readyForPickupSoon,
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
