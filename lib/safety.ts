import { COLUMN_TITLES } from "./smartsheet-columns";
import type {
  ExtractionResult,
  Intent,
  LookupResult,
  OrderRow,
  ReplyMode,
} from "./types";

/** Intents eligible for auto-reply in v1 (clean WISMO only). */
const AUTO_REPLY_INTENTS: Intent[] = [
  "order_status",
  "tracking_status",
  "estimated_completion",
  "po_status",
  "invoice_status",
];

/** Intents that always need a human in v1. */
const DRAFT_OR_REVIEW_INTENTS: Intent[] = [
  "quote_request",
  "yardage_request",
  "com_received_status",
  "fabric_status",
  "new_account",
];

const PENDING_MATERIALS_RE =
  /pending\s*materials|com\s*pending|awaiting\s*(fabric|material)|waiting\s*on\s*com|material\s*not\s*received/i;

const SHIPPED_STATUS_RE = /shipped|completed|delivered/i;
const CANCELLED_STATUS_RE = /cancell?ed/i;

export type SafetyDecision = {
  reply_mode: ReplyMode;
  reason: string;
  /** True when the generated reply may be sent with shipped/tracking language. */
  useShippedLanguage: boolean;
};

function getStatus(row: OrderRow | undefined): string {
  return row?.cells[COLUMN_TITLES.orderStatus] ?? "";
}

function getTracking(row: OrderRow | undefined): string {
  if (!row) return "";
  return (
    row.cells[COLUMN_TITLES.tracking] ??
    row.cells[COLUMN_TITLES.trackingNumber] ??
    ""
  );
}

function getEstimatedShipping(row: OrderRow | undefined): string {
  return row?.cells[COLUMN_TITLES.estimatedShipping] ?? "";
}

function anyUnsafe(e: ExtractionResult): string | null {
  const s = e.unsafeSignals;
  if (s.legalOrChargeback) return "legal/chargeback language";
  if (s.angryOrEscalated) return "angry/escalated tone";
  if (s.complaint) return "complaint";
  if (s.damage) return "damage reported";
  if (s.returnOrRefund) return "return/refund request";
  if (s.cancellation) return "cancellation request";
  if (s.addressChange) return "address change request";
  return null;
}

/**
 * Deterministic reply-mode gate. Runs AFTER extraction and lookup,
 * BEFORE generation. Never left to the model.
 */
export function decideReplyMode(
  extraction: ExtractionResult,
  lookup: LookupResult
): SafetyDecision {
  // Spam / unrelated
  if (extraction.intent === "spam_or_unrelated") {
    return {
      reply_mode: "ignore",
      reason: "Classified as spam or unrelated to customer service.",
      useShippedLanguage: false,
    };
  }

  // Unsafe signals always win
  const unsafe = anyUnsafe(extraction);
  if (unsafe) {
    return {
      reply_mode: "human_review",
      reason: `Unsafe signal detected: ${unsafe}.`,
      useShippedLanguage: false,
    };
  }

  // COM / quotes / yardage / fabric / new accounts -> human in v1
  if (DRAFT_OR_REVIEW_INTENTS.includes(extraction.intent)) {
    return {
      reply_mode: "human_review",
      reason: `Intent "${extraction.intent}" requires human handling in v1 (no confirmed receipt-status/quote data in sheet).`,
      useShippedLanguage: false,
    };
  }

  // Multiple matches: confirm with a human rather than guess
  if (lookup.multipleMatches) {
    return {
      reply_mode: "human_review",
      reason: `Multiple Smartsheet rows (${lookup.candidateCount}) matched "${lookup.matchedKey}" — needs human disambiguation.`,
      useShippedLanguage: false,
    };
  }

  // No match at all
  if (!lookup.found) {
    if (lookup.identifierWithoutRow) {
      return {
        reply_mode: "human_review",
        reason:
          "Valid-format identifier found but no Smartsheet row matched — possible Data Shuttle sync gap. Do not ask the customer for info they already gave.",
        useShippedLanguage: false,
      };
    }
    return {
      reply_mode: "human_review",
      reason: "No identifiers extracted and no row matched.",
      useShippedLanguage: false,
    };
  }

  // Found a row, but via a low-confidence key (client name / email only)
  const exactKey =
    lookup.matchType === "amp_order" ||
    lookup.matchType === "customer_po" ||
    lookup.matchType === "invoice";

  if (!exactKey || lookup.confidence !== "high") {
    return {
      reply_mode: "human_review",
      reason: `Row matched via ${lookup.matchType} (confidence: ${lookup.confidence}) — only exact AMP/PO/Invoice matches may auto-reply in v1.`,
      useShippedLanguage: false,
    };
  }

  // Exact match — but is the intent in scope for auto-reply?
  if (!AUTO_REPLY_INTENTS.includes(extraction.intent)) {
    return {
      reply_mode: "draft_only",
      reason: `Exact row match but intent "${extraction.intent}" is outside the v1 auto-reply scope.`,
      useShippedLanguage: false,
    };
  }

  const row = lookup.row;
  const status = getStatus(row);
  const tracking = getTracking(row);
  const estShipping = getEstimatedShipping(row);

  // Cancelled orders need a human
  if (CANCELLED_STATUS_RE.test(status)) {
    return {
      reply_mode: "human_review",
      reason: `Order Status is "${status}" — cancelled orders are not auto-replied.`,
      useShippedLanguage: false,
    };
  }

  // Pending materials: do not present the order as proceeding normally
  if (PENDING_MATERIALS_RE.test(status)) {
    return {
      reply_mode: "human_review",
      reason: `Order appears to be pending materials ("${status}"), so auto-reply was withheld.`,
      useShippedLanguage: false,
    };
  }

  // Shipped logic
  if (tracking) {
    return {
      reply_mode: "auto_reply",
      reason: "Exact match with tracking available — replying with shipped/tracking language.",
      useShippedLanguage: true,
    };
  }
  if (SHIPPED_STATUS_RE.test(status)) {
    return {
      reply_mode: "human_review",
      reason: `Order appears shipped/completed ("${status}") but tracking field is missing — not inventing tracking.`,
      useShippedLanguage: false,
    };
  }

  // Normal completion-estimate path requires a usable Estimated Shipping value
  if (!estShipping) {
    return {
      reply_mode: "human_review",
      reason:
        "Exact match but Estimated Shipping is empty or invalid (#INVALID DATA TYPE) — nothing safe to tell the customer.",
      useShippedLanguage: false,
    };
  }

  return {
    reply_mode: "auto_reply",
    reason: `Clean WISMO: exact ${lookup.matchType} match, status "${status || "n/a"}", Estimated Shipping "${estShipping}".`,
    useShippedLanguage: false,
  };
}
