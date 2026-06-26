import { COLUMN_TITLES } from "../lib/smartsheet-columns";
import { summarizeComStatus } from "../lib/safety";
import type { ExtractionResult, LookupResult } from "../lib/types";

export const GENERATE_SYSTEM_PROMPT = `You are the Moss Home USA customer service assistant writing a reply email. Tone: professional, warm, concise, solution-oriented. The recipients are interior designers and trade reps.

HARD RULES — violating any of these is a failure:
1. Use ONLY the facts provided in the ORDER DATA section. Never invent dates, tracking numbers, policies, discounts, delays, or internal reasons.
2. When ORDER DATA is present, NEVER ask for an order number, PO number, or invoice number — a matching order was already found.
3. For ship timing, use the "Estimated Shipping" value EXACTLY as given (e.g. "Early July" stays "Early July"; if it is a date, phrase it as an estimate).
4. Say "estimated for completion" — NEVER say "scheduled to ship".
   Correct: "Your order is currently estimated for completion in Early July."
5. If TRACKING data is provided, say the order has shipped and include the tracking value. Do NOT use "estimated for completion" language.
6. If a field is empty or not provided, say that information is not yet available — never fill the gap with a guess.
7. Answer the customer's primary question AND every question listed in SECONDARY QUESTIONS.
8. Do not use em dashes anywhere in the reply.
9. Do not mention Smartsheet, AMP, internal systems, or this automation.
10. Output ONLY the reply body text. No subject line, no markdown, no commentary.
11. If the order has multiple line items, give ONE consolidated answer for the order (they share the same estimate); only list items individually if the customer asked about specific items.
12. Greet the sender BY FIRST NAME when SENDER NAME is provided (e.g. "Hi Marie," for Marie Richards). If no name is available, open with "Hello," — never use a company name as a greeting and never guess a name.
13. Write like a real, helpful person on the Moss Home team: natural and warm, no template-sounding filler like "Thank you for reaching out" in every message, no robotic repetition of the customer's words.
14. Sign off exactly as:

Best,
Moss Home Customer Service`;

function describeRow(cells: Record<string, string>): string {
  const fields: [string, string][] = [
    ["Item Name", cells[COLUMN_TITLES.itemName] ?? ""],
    ["Qty", cells[COLUMN_TITLES.qty] ?? ""],
    ["Order Status", cells[COLUMN_TITLES.orderStatus] ?? ""],
    ["Estimated Shipping", cells[COLUMN_TITLES.estimatedShipping] ?? ""],
    [
      "Tracking",
      cells[COLUMN_TITLES.tracking] ?? cells[COLUMN_TITLES.trackingNumber] ?? "",
    ],
    ["Shipped Date", cells[COLUMN_TITLES.shippedDate] ?? ""],
  ];
  return fields
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");
}

export function buildGenerateUserMessage(input: {
  fromName: string | null;
  subject: string;
  body: string;
  extraction: ExtractionResult;
  lookup: LookupResult;
  useShippedLanguage: boolean;
  askForInfo?: boolean;
  comMode?: boolean;
  readyForPickupSoon?: boolean;
}): string {
  const header = [
    `CUSTOMER EMAIL:`,
    `SENDER NAME: ${input.extraction.senderName ?? input.fromName ?? "(unknown)"}`,
    `SENDER COMPANY: ${input.extraction.senderCompany ?? "(unknown)"}`,
    `Subject: ${input.subject}`,
    input.body,
    ``,
  ];

  // ---- No-order-found mode: politely ask for an identifier ----
  if (input.askForInfo || !input.lookup.found) {
    const given =
      input.extraction.ampOrderNumber ??
      input.extraction.poNumber ??
      input.extraction.invoiceNumber;
    return [
      ...header,
      `ORDER DATA (the only facts you may use):`,
      `(no matching order was found in the current open orders)`,
      ``,
      given
        ? `MODE: The customer provided the identifier "${given}", but it does not match any current open order. Politely say you could not locate it in the current open orders, ask them to double-check it, and ask for the order number or invoice number from their confirmation so you can pull it up. Do not speculate about why it was not found.`
        : `MODE: No order number, PO number, or invoice number could be identified. Politely ask the customer to reply with their order number, PO number, or invoice number so you can look up the status. Do not guess or invent any order information.`,
    ].join("\n");
  }

  // ---- Order found: build consolidated order data ----
  const lineItems =
    input.lookup.rows && input.lookup.rows.length > 0
      ? input.lookup.rows
      : input.lookup.row
        ? [input.lookup.row]
        : [];
  const first = lineItems[0]?.cells ?? {};

  // ---- COM receipt mode: report per-item fabric status ----
  if (input.comMode) {
    const com = summarizeComStatus(lineItems);
    const itemLabel = (r: { cells: Record<string, string> }) => {
      const name = r.cells[COLUMN_TITLES.itemName] || "Item";
      const style = r.cells[COLUMN_TITLES.comStyleName];
      return style ? `${name} (${style})` : name;
    };
    return [
      ...header,
      `MATCHED VIA: ${input.lookup.matchType} = ${input.lookup.matchedKey}`,
      ``,
      `ORDER DATA (the only facts you may use):`,
      `COM FABRIC RECEIVED for: ${
        com.received.length ? com.received.map(itemLabel).join("; ") : "(none yet)"
      }`,
      `COM FABRIC NOT YET RECEIVED for: ${
        com.pending.length ? com.pending.map(itemLabel).join("; ") : "(none)"
      }`,
      ``,
      `MODE: The customer is asking whether their COM fabric has been received. Confirm exactly which items have fabric checked in and which are still awaiting fabric, using the lists above. Do not promise ship dates unless the customer asked and an Estimated Shipping value is provided. Do not mention fabric storage locations.`,
    ].join("\n");
  }

  // ---- Ready-soon mode: ship week reached + upholstery complete ----
  if (input.readyForPickupSoon) {
    return [
      ...header,
      `MATCHED VIA: ${input.lookup.matchType} = ${input.lookup.matchedKey}`,
      ``,
      `ORDER DATA (the only facts you may use):`,
      `The order is finishing up in production and is almost ready.`,
      ``,
      `MODE: Tell the customer warmly and briefly that their order is finishing up and should be ready in the next few days. Say this ONCE. Do NOT give a specific date, do NOT say "estimated for completion", do NOT quote a month or week, and do NOT repeat the timeframe. Do not mention internal dates, fabric, or systems.`,
    ].join("\n");
  }

  // ---- Multiple shipped orders for the same customer (e.g. PO token hit
  //      "7776/MJT" and "7776/SHOWROOM"): list every order with its tracking.
  if (input.lookup.multipleMatches && input.useShippedLanguage) {
    const byOrder = new Map<string, typeof lineItems>();
    for (const r of lineItems) {
      const key = r.cells[COLUMN_TITLES.ampOrderNumber] ?? r.rowId;
      byOrder.set(key, [...(byOrder.get(key) ?? []), r]);
    }
    const orderBlocks = [...byOrder.entries()].map(([amp, rows], i) => {
      const c = rows[0].cells;
      const tracking =
        c[COLUMN_TITLES.tracking] ?? c[COLUMN_TITLES.trackingNumber] ?? "";
      const po = c[COLUMN_TITLES.customerPo] ?? "";
      const shipped = c[COLUMN_TITLES.shippedDate] ?? c["Actual Ship Date"] ?? "";
      const items = rows
        .map((r) => r.cells[COLUMN_TITLES.itemName])
        .filter(Boolean)
        .join(", ");
      return `${i + 1}. PO: ${po || "(n/a)"} | Items: ${items || "(n/a)"} | Tracking: ${tracking}${shipped ? ` | Shipped: ${shipped}` : ""}`;
    });
    return [
      ...header,
      `MATCHED VIA: ${input.lookup.matchType} = ${input.lookup.matchedKey}`,
      ``,
      `ORDER DATA (the only facts you may use):`,
      `This customer has ${byOrder.size} SHIPPED orders matching their reference:`,
      ...orderBlocks,
      ``,
      `MODE: All of these orders HAVE SHIPPED. Tell the customer each order shipped and give the tracking number for each, identified by its PO/sidemark. Do not use "estimated for completion".`,
    ].join("\n");
  }

  const orderData: Record<string, string> = {
    "AMP Order #": first[COLUMN_TITLES.ampOrderNumber] ?? "",
    "Customer PO #": first[COLUMN_TITLES.customerPo] ?? "",
    "Invoice #": first[COLUMN_TITLES.invoiceNumber] ?? "",
    "Order Status": first[COLUMN_TITLES.orderStatus] ?? "",
    "Estimated Shipping":
      first[COLUMN_TITLES.estimatedShipping] ?? first["ESTIMATED SHIPPING"] ?? "",
    Tracking:
      first[COLUMN_TITLES.tracking] ?? first[COLUMN_TITLES.trackingNumber] ?? "",
    "Shipped Date":
      first[COLUMN_TITLES.shippedDate] ?? first["Actual Ship Date"] ?? "",
  };

  const dataLines = Object.entries(orderData)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const itemLines =
    lineItems.length > 1
      ? [
          ``,
          `LINE ITEMS (${lineItems.length} items on this order):`,
          ...lineItems.map((r, i) => `${i + 1}. ${describeRow(r.cells) || "(no details)"}`),
        ]
      : lineItems.length === 1
        ? [``, `ITEM: ${describeRow(lineItems[0].cells) || "(no details)"}`]
        : [];

  return [
    ...header,
    `MATCHED VIA: ${input.lookup.matchType} = ${input.lookup.matchedKey}`,
    ``,
    `ORDER DATA (the only facts you may use):`,
    dataLines || "(none)",
    ...itemLines,
    ``,
    `SECONDARY QUESTIONS TO ADDRESS: ${
      input.extraction.secondaryQuestions.length
        ? input.extraction.secondaryQuestions.join(" | ")
        : "(none)"
    }`,
    ``,
    input.useShippedLanguage
      ? `MODE: This order HAS SHIPPED. Use shipped/tracking language. Do not use "estimated for completion".`
      : `MODE: This order is in production. State the Estimated Shipping timeframe ONCE using "estimated for completion" phrasing (e.g. "Your order is currently estimated for completion in Early July."). Do NOT repeat the timeframe a second time and do NOT echo the customer's own wording back to them.`,
  ].join("\n");
}
