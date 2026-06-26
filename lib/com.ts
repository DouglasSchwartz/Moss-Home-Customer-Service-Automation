import { summarizeComStatus } from "./safety";
import { COLUMN_TITLES } from "./smartsheet-columns";
import type { OrderRow } from "./types";

/**
 * Stable phrase included in our COM-tracking request so we can detect — in a
 * later turn — that we already asked, and avoid asking again in a loop.
 */
export const COM_TRACKING_REQUEST_MARKER =
  /tracking number for your COM(?:\s+fabric)?\s+shipment/i;

/**
 * Sender is alluding that the COM fabric was already sent to us / should have
 * arrived (deterministic fallback to the AI `comShipmentClaimed` flag).
 */
export const COM_PUSHBACK_RE =
  /(should\s+have\s+(?:it|been|already|received|gotten|arrived)|you\s+should\s+have|already\s+(?:sent|shipped|delivered|mailed|been\s+(?:received|delivered))|we\s+(?:sent|shipped|mailed|dropped\s+off)|it\s+(?:shipped|was\s+sent|was\s+delivered|arrived|has\s+arrived|left)|been\s+(?:sent|delivered|received)|delivered\s+(?:it|on|to)|on\s+its\s+way|sent\s+(?:it|the\s+fabric|the\s+com|our\s+com))/i;

const CANCELLED_RE = /cancell?ed/i;

/** Does the thread look like it concerns COM (Customer's Own Material)? */
export function mentionsCom(text: string): boolean {
  return /\bC\.?\s?O\.?\s?M\b|customer'?s\s+own\s+material/i.test(text ?? "");
}

/** A tracking-number-looking token the sender may have pasted into their reply. */
export function looksLikeTrackingNumber(text: string): boolean {
  const t = text ?? "";
  if (/\b1Z[0-9A-Z]{16}\b/i.test(t)) return true; // UPS
  if (/\b\d{12,22}\b/.test(t)) return true; // FedEx (12/15) / USPS (20-22)
  if (/\btracking\s*(?:#|number|no\.?)\s*[:#]?\s*[A-Z0-9]{8,}\b/i.test(t)) return true;
  return false;
}

/** First name for the greeting, from the signature or the From display name. */
export function greetingFirstName(
  senderName: string | null,
  from: string
): string | null {
  let candidate = senderName?.trim() ?? "";
  if (!candidate && from.includes("<")) candidate = from.split("<")[0].trim();
  if (!candidate || candidate.includes("@")) return null;
  return candidate.split(/\s+/)[0] || null;
}

/** Deterministic reply that requests the COM shipment tracking number. */
export function buildComTrackingRequest(firstName: string | null): string {
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";
  return [
    greeting,
    "",
    "Thanks for letting us know. On our end, we are not showing your COM fabric checked in just yet. So we can track it down, could you please reply with the tracking number for your COM fabric shipment? Once we have that, we will trace it and confirm receipt right away.",
    "",
    "Best,",
    "Moss Home Customer Service",
  ].join("\n");
}

export type ComClaimOutcome = "ask_tracking" | "human_trace" | "human_unclear";

/**
 * Given the matched order's line items and the sender's reply, decide how to
 * handle a COM "you should have received it" pushback. Returns null when this
 * is not a clean "we don't show it received" case (caller falls back to the
 * normal COM status flow).
 */
export function evaluateComShipmentClaim(input: {
  lineItems: OrderRow[];
  newContent: string;
  fullText: string;
}): ComClaimOutcome | null {
  const { lineItems, newContent, fullText } = input;
  if (lineItems.length === 0) return null;

  if (
    lineItems.some((r) => CANCELLED_RE.test(r.cells[COLUMN_TITLES.orderStatus] ?? ""))
  ) {
    return "human_unclear";
  }

  const com = summarizeComStatus(lineItems);
  // Some fabric already shows received — not a clean "we don't have it" case.
  if (com.received.length > 0) return null;
  // Receipt status unclear on any item — let a human look.
  if (com.ambiguous.length > 0 || com.pending.length === 0) return "human_unclear";

  // All items still awaiting fabric AND the sender says it was sent. If we
  // already asked for tracking in this thread, or they pasted a tracking
  // number, hand to a human to trace rather than asking again.
  if (COM_TRACKING_REQUEST_MARKER.test(fullText)) return "human_trace";
  if (looksLikeTrackingNumber(newContent)) return "human_trace";
  return "ask_tracking";
}
