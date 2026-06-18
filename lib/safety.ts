import { COLUMN_TITLES } from "./smartsheet-columns";
import type {
  ExtractionResult,
  Intent,
  LookupResult,
  OrderRow,
  ReplyMode,
} from "./types";

/** Intents eligible for auto-reply when an order is found. */
const AUTO_REPLY_INTENTS: Intent[] = [
  "order_status",
  "tracking_status",
  "estimated_completion",
  "po_status",
  "invoice_status",
  "client_project_lookup",
];

/** Intents that may get an automatic "please send your order number" reply
 *  when no order could be found. ONLY genuine order inquiries — never general
 *  chatter, acknowledgments, or non-CS requests (those would produce robotic
 *  "send your order number" replies to people who never asked about an order). */
const ASK_FOR_INFO_INTENTS: Intent[] = [
  ...AUTO_REPLY_INTENTS,
  "com_received_status",
];

/** Intents that never warrant any automated reply — stay silent. */
const SILENT_INTENTS: Intent[] = [
  "spam_or_unrelated",
  "acknowledgment",
  "not_customer_service",
];

/** Intents that always need a human in v1. */
const DRAFT_OR_REVIEW_INTENTS: Intent[] = [
  "quote_request",
  "yardage_request",
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
  /** True when the reply should ask the customer for an order/invoice number. */
  askForInfo: boolean;
  /** True when the reply should report per-item COM fabric receipt status. */
  comMode?: boolean;
};

/**
 * Deterministic COM receipt status per line item, derived from the sheet:
 * a line item with a "Fabric Location" has its fabric checked in; a line item
 * still in "Pending Materials" does not. Anything else is ambiguous.
 */
export function summarizeComStatus(rows: OrderRow[]): {
  received: OrderRow[];
  pending: OrderRow[];
  ambiguous: OrderRow[];
} {
  const received: OrderRow[] = [];
  const pending: OrderRow[] = [];
  const ambiguous: OrderRow[] = [];
  for (const row of rows) {
    const location = row.cells[COLUMN_TITLES.fabricLocation] ?? "";
    if (location) received.push(row);
    else if (PENDING_MATERIALS_RE.test(getStatus(row))) pending.push(row);
    else ambiguous.push(row);
  }
  return { received, pending, ambiguous };
}

function getStatus(row: OrderRow): string {
  return row.cells[COLUMN_TITLES.orderStatus] ?? "";
}

function getTracking(row: OrderRow): string {
  return (
    row.cells[COLUMN_TITLES.tracking] ??
    row.cells[COLUMN_TITLES.trackingNumber] ??
    ""
  );
}

function getEstimatedShipping(row: OrderRow): string {
  // Archive sheets title this column in all caps.
  return (
    row.cells[COLUMN_TITLES.estimatedShipping] ??
    row.cells["ESTIMATED SHIPPING"] ??
    ""
  );
}

/** Internal raw ship date (e.g. "2025-10-03") paired with the fuzzy
 *  customer-facing Estimated Shipping ("Early October"). Used only to detect a
 *  past estimate — never surfaced to the customer. */
function getEstShipWeek(row: OrderRow): string {
  return (
    row.cells[COLUMN_TITLES.estShipWeek] ??
    row.cells["Est Ship Week"] ??
    row.cells["EST SHIP DATE WEEK"] ??
    ""
  );
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Parse a concrete calendar date from the raw "Est Ship Week" cell
 * (e.g. "2025-10-03" or "10/3/2025"). This is the qualifier for the
 * past-estimate check. Returns null when the cell holds no parseable date.
 */
export function parseShipDate(estShipWeek: string): Date | null {
  const wk = (estShipWeek ?? "").trim();
  if (!wk) return null;
  let m = wk.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = wk.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(y, +m[1] - 1, +m[2]);
  }
  return null;
}

/** True when any line item's "Est Ship Week" date is before today. */
function isEstimateInPast(rows: OrderRow[], now: Date): boolean {
  const today = startOfDay(now);
  for (const row of rows) {
    const d = parseShipDate(getEstShipWeek(row));
    if (d && d.getTime() < today) return true;
  }
  return false;
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

const HOLD = { useShippedLanguage: false, askForInfo: false };

/**
 * Deterministic reply-mode gate. Runs AFTER extraction and lookup,
 * BEFORE generation. Never left to the model.
 */
export function decideReplyMode(
  extraction: ExtractionResult,
  lookup: LookupResult,
  now: Date = new Date()
): SafetyDecision {
  // Spam, acknowledgments ("thanks!"), and non-customer-service requests
  // (website edits, internal staff tasks) get NO reply — staying silent is
  // the correct, human behavior here.
  if (SILENT_INTENTS.includes(extraction.intent)) {
    return {
      reply_mode: "ignore",
      reason: `Intent "${extraction.intent}" needs no reply (spam, acknowledgment, or not a customer-service request).`,
      ...HOLD,
    };
  }

  // Unsafe signals always win
  const unsafe = anyUnsafe(extraction);
  if (unsafe) {
    return {
      reply_mode: "human_review",
      reason: `Unsafe signal detected: ${unsafe}.`,
      ...HOLD,
    };
  }

  // COM / quotes / yardage / fabric / new accounts -> human in v1
  if (DRAFT_OR_REVIEW_INTENTS.includes(extraction.intent)) {
    return {
      reply_mode: "human_review",
      reason: `Intent "${extraction.intent}" requires human handling in v1 (no confirmed receipt-status/quote data in sheet).`,
      ...HOLD,
    };
  }

  // Multiple DISTINCT orders matched. Exception: when every matched row
  // belongs to the SAME customer and every row already has tracking (e.g.
  // PO "7776" hitting both "7776/MJT" and "7776/SHOWROOM" for Bohlert
  // Massey), it is safe to reply listing each shipped order's tracking.
  // Anything else goes to a human rather than guessing.
  if (lookup.multipleMatches) {
    const rows = lookup.rows ?? [];
    const customers = new Set(
      rows
        .map((r) => (r.cells[COLUMN_TITLES.customer] ?? "").toLowerCase().trim())
        .filter(Boolean)
    );
    const allTracked = rows.length > 0 && rows.every((r) => getTracking(r));
    if (
      customers.size === 1 &&
      allTracked &&
      AUTO_REPLY_INTENTS.includes(extraction.intent)
    ) {
      return {
        reply_mode: "auto_reply",
        reason: `"${lookup.matchedKey}" matched ${lookup.candidateCount} rows across multiple orders, but all belong to the same customer and all have tracking — replying with each order's tracking.`,
        useShippedLanguage: true,
        askForInfo: false,
      };
    }
    return {
      reply_mode: "human_review",
      reason: `Multiple distinct orders (${lookup.candidateCount} rows) matched "${lookup.matchedKey}" — needs human disambiguation.`,
      ...HOLD,
    };
  }

  // No match at all: auto-reply asking for an order/invoice number when the
  // request is a routine lookup. Never goes silent, never invents data.
  if (!lookup.found) {
    if (ASK_FOR_INFO_INTENTS.includes(extraction.intent)) {
      return {
        reply_mode: "auto_reply",
        reason: lookup.identifierWithoutRow
          ? `Identifier "${
              extraction.ampOrderNumber ?? extraction.poNumber ?? extraction.invoiceNumber
            }" not found in current open orders — auto-replying to ask the customer to verify it or share an alternate order/invoice number.`
          : "No order matched — auto-replying to ask for an order, PO, or invoice number.",
        useShippedLanguage: false,
        askForInfo: true,
      };
    }
    return {
      reply_mode: "human_review",
      reason: `No order matched and intent "${extraction.intent}" is not a routine lookup — needs a human.`,
      ...HOLD,
    };
  }

  // ---- Aggregate across line items (one row per line item in the sheet) ----
  const lineItems =
    lookup.rows && lookup.rows.length > 0
      ? lookup.rows
      : lookup.row
        ? [lookup.row]
        : [];

  // Matched on an ARCHIVE sheet: the order shipped/closed. With tracking we
  // can answer; without it there is nothing safe to say about an old order.
  if (lookup.isArchive) {
    const archTracking = lineItems.map(getTracking).filter(Boolean);
    if (archTracking.length > 0) {
      return {
        reply_mode: "auto_reply",
        reason: `Order found on archive sheet "${lookup.fromSheet}" with tracking — replying with shipped/tracking language.`,
        useShippedLanguage: true,
        askForInfo: false,
      };
    }
    return {
      reply_mode: "human_review",
      reason: `Order found on archive sheet "${lookup.fromSheet}" (shipped/closed) but no tracking on file — needs a human.`,
      ...HOLD,
    };
  }

  // COM receipt questions: answerable deterministically per line item
  // (Fabric Location set = checked in; Pending Materials = not yet received).
  if (extraction.intent === "com_received_status") {
    if (lineItems.some((r) => CANCELLED_STATUS_RE.test(getStatus(r)))) {
      return {
        reply_mode: "human_review",
        reason: "COM question on an order with cancelled line items — needs a human.",
        ...HOLD,
      };
    }
    const com = summarizeComStatus(lineItems);
    if (com.ambiguous.length > 0) {
      return {
        reply_mode: "human_review",
        reason: `COM receipt unclear for ${com.ambiguous.length}/${lineItems.length} line items (no Fabric Location and not pending materials) — needs a human.`,
        ...HOLD,
      };
    }
    return {
      reply_mode: "auto_reply",
      reason: `COM status derived from sheet: ${com.received.length} item(s) with fabric received, ${com.pending.length} still awaiting fabric.`,
      useShippedLanguage: false,
      askForInfo: false,
      comMode: true,
    };
  }

  // Exact-key matches are highest trust; single-order name/email matches are
  // deterministic contains-matches and may also auto-reply.
  if (!AUTO_REPLY_INTENTS.includes(extraction.intent)) {
    return {
      reply_mode: "draft_only",
      reason: `Order matched but intent "${extraction.intent}" is outside the v1 auto-reply scope.`,
      ...HOLD,
    };
  }

  const statuses = lineItems.map(getStatus);
  const trackings = lineItems.map(getTracking).filter(Boolean);
  const shipEstimates = [
    ...new Set(lineItems.map(getEstimatedShipping).filter(Boolean)),
  ];

  // Cancelled orders need a human
  if (statuses.some((s) => CANCELLED_STATUS_RE.test(s))) {
    return {
      reply_mode: "human_review",
      reason: `At least one line item has a cancelled status — cancelled orders are not auto-replied.`,
      ...HOLD,
    };
  }

  // Pending materials: do not present the order as proceeding normally
  const pending = statuses.find((s) => PENDING_MATERIALS_RE.test(s));
  if (pending) {
    return {
      reply_mode: "human_review",
      reason: `Order appears to be pending materials ("${pending}"), so auto-reply was withheld.`,
      ...HOLD,
    };
  }

  // Shipped logic: only speak shipped/tracking language when EVERY line item
  // has tracking. Partial shipments go to a human.
  if (trackings.length === lineItems.length && trackings.length > 0) {
    return {
      reply_mode: "auto_reply",
      reason: "All line items have tracking — replying with shipped/tracking language.",
      useShippedLanguage: true,
      askForInfo: false,
    };
  }
  if (trackings.length > 0) {
    return {
      reply_mode: "human_review",
      reason: `Tracking exists on ${trackings.length}/${lineItems.length} line items — partial shipment needs a human.`,
      ...HOLD,
    };
  }
  const shippedStatus = statuses.find((s) => SHIPPED_STATUS_RE.test(s));
  if (shippedStatus) {
    return {
      reply_mode: "human_review",
      reason: `Order appears shipped/completed ("${shippedStatus}") but tracking is missing — not inventing tracking.`,
      ...HOLD,
    };
  }

  // Normal completion-estimate path requires ONE usable, consistent
  // Estimated Shipping value across line items.
  if (shipEstimates.length === 0) {
    return {
      reply_mode: "human_review",
      reason:
        "Order matched but Estimated Shipping is empty or invalid on every line item — nothing safe to tell the customer.",
      ...HOLD,
    };
  }
  if (shipEstimates.length > 1) {
    return {
      reply_mode: "human_review",
      reason: `Line items show different Estimated Shipping values (${shipEstimates.join(", ")}) — needs a human to summarize.`,
      ...HOLD,
    };
  }

  // Estimated ship date already passed: the estimate is stale, so a human
  // should double-check before we quote a date that has come and gone.
  if (isEstimateInPast(lineItems, now)) {
    return {
      reply_mode: "human_review",
      reason: `Estimated ship date appears to be in the past ("${shipEstimates[0]}") — diverting to a human to double-check.`,
      ...HOLD,
    };
  }

  return {
    reply_mode: "auto_reply",
    reason: `Clean WISMO: ${lookup.matchType} match (${lineItems.length} line item${
      lineItems.length === 1 ? "" : "s"
    }), status "${statuses[0] || "n/a"}", Estimated Shipping "${shipEstimates[0]}".`,
    useShippedLanguage: false,
    askForInfo: false,
  };
}
