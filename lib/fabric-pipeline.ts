/**
 * Orchestration for the Fabric Stock / Availability flow.
 * Called from the main pipeline for:
 *   - customer fabric_stock_inquiry emails
 *   - warehouse (Jose) replies carrying a [MOSS-REF warehouse|...] tag
 *   - mill replies carrying a [MOSS-REF mill|...] tag
 */

import { classifyStockReply } from "./claude";
import {
  buildMillEmail,
  buildWarehouseEmail,
  findMillContact,
  parseRefTag,
  searchBarcloud,
  type RefTag,
} from "./fabric";
import { LEAD_TIME_BUFFER_WEEKS, warehouseContactEmail } from "./sheets-config";
import { estimateYardage } from "./yardage";
import type {
  ExtractionResult,
  OutboundEmail,
  ProcessEmailResponse,
} from "./types";

type Base = Pick<ProcessEmailResponse, "messageId" | "threadId" | "dryRun">;

const NO_MATCH = {
  found: false,
  confidence: "none" as const,
  multipleMatches: false,
};

/** Resolve yardage for a fabric request: explicit > furniture chart > null. */
export function resolveYards(
  requestedYards: number | null,
  furnitureItem: string | null
): { yards: number | null; source: string } {
  if (requestedYards && requestedYards > 0) {
    return { yards: requestedYards, source: "customer-specified" };
  }
  if (furnitureItem) {
    const est = estimateYardage(furnitureItem);
    if (est) return { yards: est.yards, source: `chart: ${est.item} = ${est.yards} yds` };
  }
  return { yards: null, source: "unknown" };
}

/**
 * Handle a CUSTOMER fabric stock inquiry. Returns a full response:
 * either a customer reply (in stock / need yardage), or outbound
 * warehouse/mill emails with NO customer reply yet.
 */
export async function handleFabricInquiry(
  base: Base,
  extraction: ExtractionResult
): Promise<ProcessEmailResponse> {
  const greetName = extraction.senderName?.split(/\s+/)[0] ?? null;
  const requests = extraction.fabricRequests;

  if (requests.length === 0) {
    return {
      ...base,
      reply_mode: "auto_reply",
      intent: extraction.intent,
      extracted: extraction,
      match: NO_MATCH,
      reply: [
        greetName ? `Hi ${greetName},` : "Hello,",
        ``,
        `Happy to check fabric availability for you. Could you let me know which fabric (pattern and color) you're looking for, and how many yards you need?`,
        ``,
        `Best,`,
        `Moss Home Customer Service`,
      ].join("\n"),
      reason: "Fabric stock inquiry without a fabric name — asking for it.",
      askedForInfo: true,
    };
  }

  const inStock: string[] = [];
  const needYards: string[] = [];
  const notFound: string[] = [];
  const outbound: OutboundEmail[] = [];
  const escalated: string[] = [];
  /** Fabric names we had to escalate — surfaced in the customer holding reply. */
  const checking: string[] = [];

  for (const req of requests) {
    const { yards } = resolveYards(req.yards, extraction.furnitureItem);

    if (yards === null) {
      needYards.push(req.fabric);
      continue;
    }

    const bar = await searchBarcloud(req.fabric, yards);

    if (bar.status === "in_stock") {
      inStock.push(`${bar.matchedPatternColor ?? req.fabric} (${yards} yds)`);
      continue;
    }

    if (bar.status === "maybe_in_stock") {
      const mail = buildWarehouseEmail({
        fabric: req.fabric,
        patternColor: bar.matchedPatternColor ?? req.fabric,
        yards,
        customerMessageId: base.messageId,
        lots: bar.rows,
      });
      outbound.push({ to: warehouseContactEmail(), ...mail });
      escalated.push(`${req.fabric}: dye-lot check with warehouse`);
      checking.push(bar.matchedPatternColor ?? req.fabric);
      continue;
    }

    // insufficient or not_found -> straight to the mill
    const mill = await findMillContact(req.fabric);
    if (mill && mill.companyEmail) {
      const mail = buildMillEmail({
        millContact: mill,
        yards,
        customerMessageId: base.messageId,
      });
      outbound.push({ to: mill.companyEmail, ...mail });
      escalated.push(`${req.fabric}: stock check with mill ${mill.company || mill.companyEmail}`);
      checking.push(req.fabric);
    } else {
      notFound.push(req.fabric);
    }
  }

  // Any fabric without a resolvable yardage -> ask the customer first.
  if (needYards.length > 0) {
    return {
      ...base,
      reply_mode: "auto_reply",
      intent: extraction.intent,
      extracted: extraction,
      match: NO_MATCH,
      reply: [
        greetName ? `Hi ${greetName},` : "Hello,",
        ``,
        `Happy to check on ${needYards.join(", ")} for you. How many yards do you need? If you're not sure, let me know what piece it's for and we can figure out the yardage from there.`,
        ``,
        `Best,`,
        `Moss Home Customer Service`,
      ].join("\n"),
      reason: `Fabric inquiry for ${needYards.join(", ")} without yardage — asking the customer.`,
      askedForInfo: true,
    };
  }

  // Fabric not in BarCloud and not in the Fabric Master either -> human.
  // (An unknown fabric needs a person, even if other fabrics were actionable.)
  if (notFound.length > 0) {
    return {
      ...base,
      reply_mode: "human_review",
      intent: extraction.intent,
      extracted: extraction,
      match: NO_MATCH,
      reason: `Fabric(s) not found in BarCloud or the Fabric Master Sheet: ${notFound.join(", ")} — needs a human.`,
      askedForInfo: false,
    };
  }

  // Build ONE customer reply: confirm what is in stock now, and tell them we're
  // checking on anything we had to escalate to the warehouse/mill. We NEVER
  // leave a fabric inquiry on silent — a held reply looks like we ignored them.
  if (inStock.length > 0 || checking.length > 0) {
    const lines = [greetName ? `Hi ${greetName},` : "Hello,", ``];
    if (inStock.length === 1) {
      lines.push(`Good news! We do have ${inStock[0]} in stock.`);
    } else if (inStock.length > 1) {
      lines.push(
        `Good news! The following are in stock:\n${inStock.map((f) => `- ${f}`).join("\n")}`
      );
    }
    if (checking.length > 0) {
      const lead = inStock.length > 0 ? "I'm also checking on" : "Let me check on";
      lines.push(
        `${lead} ${checking.join(", ")} and I'll get right back to you as soon as I hear back.`
      );
    }
    lines.push(``, `Best,`, `Moss Home Customer Service`);

    return {
      ...base,
      reply_mode: "auto_reply",
      intent: extraction.intent,
      extracted: extraction,
      match: NO_MATCH,
      reply: lines.join("\n").replace(/\n{3,}/g, "\n\n"),
      outboundEmails: outbound.length > 0 ? outbound : undefined,
      reason:
        outbound.length > 0
          ? `Sent ${outbound.length} inquiry email(s): ${escalated.join("; ")}. Customer got a holding acknowledgment.${inStock.length ? ` In stock now: ${inStock.join("; ")}.` : ""}`
          : `BarCloud shows sufficient single-lot stock: ${inStock.join("; ")}.`,
      askedForInfo: false,
    };
  }

  // Nothing resolvable at all -> let a human take it.
  return {
    ...base,
    reply_mode: "human_review",
    intent: extraction.intent,
    extracted: extraction,
    match: NO_MATCH,
    reason: "Fabric inquiry could not be resolved from inventory data — needs a human.",
    askedForInfo: false,
  };
}

/**
 * Handle a reply from the warehouse (Jose) or a mill, identified by the
 * [MOSS-REF ...] tag quoted in their reply. Produces either a customer
 * reply (cross-thread via replyToMessageId) or the next escalation email.
 */
export async function handleStockReply(
  base: Base,
  rawBody: string
): Promise<ProcessEmailResponse | null> {
  const tag: RefTag | null = parseRefTag(rawBody);
  if (!tag) return null;

  const intent = tag.stage === "warehouse" ? "internal_stock_reply" : "mill_stock_reply";

  let cls;
  try {
    cls = await classifyStockReply(rawBody);
  } catch (err) {
    return {
      ...base,
      reply_mode: "human_review",
      intent,
      extracted: null,
      match: NO_MATCH,
      reason: `Could not classify the ${tag.stage} reply about ${tag.fabric} — needs a human.`,
      askedForInfo: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (cls.answer === "unclear") {
    return {
      ...base,
      reply_mode: "human_review",
      intent,
      extracted: null,
      match: NO_MATCH,
      reason: `${tag.stage} reply about ${tag.fabric} was ambiguous ("${cls.notes}") — needs a human.`,
      askedForInfo: false,
    };
  }

  // ---- Warehouse said YES: fabric in stock, tell the customer ----
  if (tag.stage === "warehouse" && cls.answer === "yes") {
    return {
      ...base,
      reply_mode: "auto_reply",
      intent,
      extracted: null,
      match: NO_MATCH,
      replyToMessageId: tag.customerMessageId,
      reply: [
        `Hello,`,
        ``,
        `Good news! We do have ${tag.yards} yds of ${tag.fabric} in stock.`,
        ``,
        `Best,`,
        `Moss Home Customer Service`,
      ].join("\n"),
      reason: `Warehouse confirmed ${tag.yards} yds of ${tag.fabric} in matching dye lot.`,
      askedForInfo: false,
    };
  }

  // ---- Warehouse said NO: escalate to the mill ----
  if (tag.stage === "warehouse" && cls.answer === "no") {
    const mill = await findMillContact(tag.fabric);
    if (!mill || !mill.companyEmail) {
      return {
        ...base,
        reply_mode: "human_review",
        intent,
        extracted: null,
        match: NO_MATCH,
        reason: `Warehouse says no matching dye lot for ${tag.fabric}, and no mill contact found in the Fabric Master Sheet — needs a human.`,
        askedForInfo: false,
      };
    }
    const mail = buildMillEmail({
      millContact: mill,
      yards: tag.yards,
      customerMessageId: tag.customerMessageId,
    });
    return {
      ...base,
      reply_mode: "ignore",
      intent,
      extracted: null,
      match: NO_MATCH,
      outboundEmails: [{ to: mill.companyEmail, ...mail }],
      reason: `Warehouse says no matching dye lot for ${tag.fabric} — asking mill ${mill.company || mill.companyEmail}. Customer reply still held.`,
      askedForInfo: false,
    };
  }

  // ---- Mill replied ----
  if (cls.answer === "yes") {
    return {
      ...base,
      reply_mode: "auto_reply",
      intent,
      extracted: null,
      match: NO_MATCH,
      replyToMessageId: tag.customerMessageId,
      reply: [
        `Hello,`,
        ``,
        `Good news! ${tag.fabric} is in stock at the mill, so we can get ${tag.yards} yds for your project.`,
        ``,
        `Best,`,
        `Moss Home Customer Service`,
      ].join("\n"),
      reason: `Mill confirmed ${tag.yards} yds of ${tag.fabric} available.`,
      askedForInfo: false,
    };
  }

  // Mill says NO -> backordered; quote their lead time + buffer.
  const leadDesc = cls.leadTimeWeeks
    ? `approximately ${cls.leadTimeWeeks + LEAD_TIME_BUFFER_WEEKS} weeks`
    : cls.leadTimeText
      ? `${cls.leadTimeText} plus about ${LEAD_TIME_BUFFER_WEEKS} weeks for processing`
      : null;

  if (!leadDesc) {
    return {
      ...base,
      reply_mode: "human_review",
      intent,
      extracted: null,
      match: NO_MATCH,
      reason: `Mill says ${tag.fabric} is not in stock but gave no usable lead time — needs a human.`,
      askedForInfo: false,
    };
  }

  return {
    ...base,
    reply_mode: "auto_reply",
    intent,
    extracted: null,
    match: NO_MATCH,
    replyToMessageId: tag.customerMessageId,
    reply: [
      `Hello,`,
      ``,
      `Thank you for your patience. ${tag.fabric} is currently backordered. The expected availability is ${leadDesc}.`,
      ``,
      `Let us know if you'd like us to proceed, or if you'd like help finding an alternate fabric.`,
      ``,
      `Best,`,
      `Moss Home Customer Service`,
    ].join("\n"),
    reason: `Mill: ${tag.fabric} backordered, lead time "${cls.leadTimeText ?? cls.leadTimeWeeks + " weeks"}" + ${LEAD_TIME_BUFFER_WEEKS} weeks buffer.`,
    askedForInfo: false,
  };
}
