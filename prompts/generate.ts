import { COLUMN_TITLES } from "../lib/smartsheet-columns";
import type { ExtractionResult, LookupResult } from "../lib/types";

export const GENERATE_SYSTEM_PROMPT = `You are the Moss Home USA customer service assistant writing a reply email. Tone: professional, warm, concise, solution-oriented. The recipients are interior designers and trade reps.

HARD RULES — violating any of these is a failure:
1. Use ONLY the facts provided in the ORDER DATA section. Never invent dates, tracking numbers, policies, discounts, delays, or internal reasons.
2. NEVER ask for an order number, PO number, or invoice number — a matching order was already found.
3. For ship timing, use the "Estimated Shipping" value EXACTLY as given (e.g. "Early July" stays "Early July"; if it is a date, phrase it as an estimate).
4. Say "estimated for completion" — NEVER say "scheduled to ship".
   Correct: "Your order is currently estimated for completion in Early July."
5. If TRACKING data is provided, say the order has shipped and include the tracking value. Do NOT use "estimated for completion" language.
6. If a field is empty or not provided, say that information is not yet available — never fill the gap with a guess.
7. Answer the customer's primary question AND every question listed in SECONDARY QUESTIONS.
8. Do not use em dashes anywhere in the reply.
9. Do not mention Smartsheet, AMP, internal systems, or this automation.
10. Output ONLY the reply body text. No subject line, no markdown, no commentary.
11. Sign off exactly as:

Best,
Moss Home Customer Service`;

export function buildGenerateUserMessage(input: {
  fromName: string | null;
  subject: string;
  body: string;
  extraction: ExtractionResult;
  lookup: LookupResult;
  useShippedLanguage: boolean;
}): string {
  const row = input.lookup.row;
  const cells = row?.cells ?? {};

  const orderData: Record<string, string> = {
    "AMP Order #": cells[COLUMN_TITLES.ampOrderNumber] ?? "",
    "Customer PO #": cells[COLUMN_TITLES.customerPo] ?? "",
    "Invoice #": cells[COLUMN_TITLES.invoiceNumber] ?? "",
    "Item Name": cells[COLUMN_TITLES.itemName] ?? "",
    "Order Status": cells[COLUMN_TITLES.orderStatus] ?? "",
    "Estimated Shipping": cells[COLUMN_TITLES.estimatedShipping] ?? "",
    Tracking:
      cells[COLUMN_TITLES.tracking] ?? cells[COLUMN_TITLES.trackingNumber] ?? "",
    "Shipped Date": cells[COLUMN_TITLES.shippedDate] ?? "",
  };

  const dataLines = Object.entries(orderData)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return [
    `CUSTOMER EMAIL (from ${input.fromName ?? "customer"}):`,
    `Subject: ${input.subject}`,
    input.body,
    ``,
    `MATCHED VIA: ${input.lookup.matchType} = ${input.lookup.matchedKey}`,
    ``,
    `ORDER DATA (the only facts you may use):`,
    dataLines || "(none)",
    ``,
    `SECONDARY QUESTIONS TO ADDRESS: ${
      input.extraction.secondaryQuestions.length
        ? input.extraction.secondaryQuestions.join(" | ")
        : "(none)"
    }`,
    ``,
    input.useShippedLanguage
      ? `MODE: This order HAS SHIPPED. Use shipped/tracking language. Do not use "estimated for completion".`
      : `MODE: This order is in production. Use the Estimated Shipping value with "estimated for completion" phrasing.`,
  ].join("\n");
}
