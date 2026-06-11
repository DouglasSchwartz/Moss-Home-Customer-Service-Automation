/**
 * Test fixtures transcribed from real Moss Home CS emails (screenshots,
 * May-Jun 2025/2026) plus the failure cases from the old Zapier build.
 */
import type { OrderRow, ProcessEmailRequest } from "../../lib/types";

export function makeRequest(over: Partial<ProcessEmailRequest>): ProcessEmailRequest {
  return {
    messageId: "msg-test-1",
    threadId: "thread-test-1",
    from: "customer@example.com",
    to: "support@mosshomeusa.com",
    subject: "Order question",
    textBody: "",
    ...over,
  };
}

// ---- Real email bodies ----

/** Cocoon WISMO — the golden path (real email, Jun 13 2025). */
export const EMAIL_COCOON_WISMO = makeRequest({
  from: "Marie Richards <marie@cocoon-atx.com>",
  subject: "Order 032725-5713/ PO 222805",
  textBody:
    "Hello, Hope all is well! Please pass on the estimated ship date for order 032725-5713/ Cocoon PO 222805. Thanks so much!\n\nThank you,\nMarie Richards, Showroom Manager/ Sales Consultant\nCOCOON To the Trade\n512.302.1116",
});

/** PO-only tracking request (real test email from Jacq, May 29). */
export const EMAIL_PO_TRACKING = makeRequest({
  from: "Jacq Nguyen <jacq@mosshomeusa.com>",
  subject: "Shipment Status",
  textBody:
    "Hi, can you provide tracking for our recent order? The PO# was 7776. I received a notification that it was ready.\n\nThank you,\nBOHLERT MASSEY INTERIORS",
});

/** Client-name-only — the Zapier failure case (real test email). */
export const EMAIL_CAMPE = makeRequest({
  from: "Jacq Nguyen <jacq@mosshomeusa.com>",
  subject: "Order Status",
  textBody: "Can you tell me when my order is going to ship for our client Campe?",
});

/** COM received question (real test email, order 030926-23631). */
export const EMAIL_COM_RECEIVED = makeRequest({
  from: "Jacq Nguyen <jacq@mosshomeusa.com>",
  subject: "COM for Las Brisas Project",
  textBody:
    "Hi, we sent COM last week. Can you confirm whether you've received any of our COM fabrics? our order number was 030926-23631.\n\nThanks!",
});

/** Yardage / quote question (real email, MATIS CREATIVE). */
export const EMAIL_YARDAGE = makeRequest({
  from: "sheryl madonna <smadonna@codarus.com>",
  subject: 'QUOTE for "MATIS CREATIVE" from "Moss Home"',
  textBody:
    'Hi Erika, Customer wants to use a patterned fabric on the back cushions only. Repeat will be 27" horizontal. Can you please advise on the yardage requirements for this? Thank you! My best, Sheryl CODARUS',
});

/** Damage complaint (synthetic, unsafe-signal case). */
export const EMAIL_DAMAGE = makeRequest({
  from: "designer@studio.com",
  subject: "Damaged sectional on order 112025-23759",
  textBody:
    "The sectional from order 112025-23759 arrived damaged - the frame is cracked and the fabric is torn. We need a replacement or a refund immediately. This is unacceptable.",
});

/** Forwarded WISMO (forward markers + embedded sender). */
export const EMAIL_FORWARDED_WISMO = makeRequest({
  from: "Jacq Nguyen <jacq@mosshomeusa.com>",
  subject: "Fwd: Order 032725-5713/ PO 222805",
  textBody:
    "---------- Forwarded message ----------\nFrom: Marie Richards <marie@cocoon-atx.com>\nDate: Fri, Jun 13, 2025 at 7:44 AM\nSubject: Order 032725-5713/ PO 222805\nTo: Moss Support <support@mossstudio.com>\n\nHello, Hope all is well! Please pass on the estimated ship date for order 032725-5713/ Cocoon PO 222805. Thanks so much!",
});

// ---- Mock Smartsheet rows (column titles match the live sheet) ----

function row(rowId: string, cells: Record<string, string>): OrderRow {
  return { rowId, cells };
}

export const MOCK_ROWS: OrderRow[] = [
  // The Cocoon order — production underway, has Estimated Shipping
  row("r1", {
    "AMP Order #": "032725-5713",
    "Invoice #": "30290",
    "Customer PO #": "222805",
    "ACCOUNT EMAIL": "marie@cocoon-atx.com",
    Customer: "COCOON TO THE TRADE",
    "Item Name": "Custom Sectional",
    "Order Status": "2. Ready to Produce",
    "Estimated Shipping": "Early July",
  }),
  // Second line item on the SAME order (one row per line item, real sheet shape)
  row("r1b", {
    "AMP Order #": "032725-5713",
    "Invoice #": "30290",
    "Customer PO #": "222805",
    "ACCOUNT EMAIL": "marie@cocoon-atx.com",
    Customer: "COCOON TO THE TRADE",
    "Item Name": "Matching Ottoman",
    "Order Status": "2. Ready to Produce",
    "Estimated Shipping": "Early July",
  }),
  // '#PO'-style value living in the AMP Order # column (real pattern from sheet)
  row("r2", {
    "AMP Order #": "#PO7776",
    "ACCOUNT EMAIL": "orders@bohlertmassey.com",
    "Item Name": "Pali Multi Rug Ottoman",
    "Order Status": "4. Pending Shipment",
    "Estimated Shipping": "Late August",
  }),
  // COM order — pending materials
  row("r3", {
    "AMP Order #": "030926-23631",
    "ACCOUNT EMAIL": "designer@lasbrisas.com",
    "Item Name": "Las Brisas Lounge Chairs",
    "COM MILL": "ANNIE SELKE",
    "Order Status": "1. Pending Materials",
    "Estimated Shipping": "Mid June",
  }),
  // Shipped with tracking
  row("r4", {
    "AMP Order #": "112025-23759",
    "Invoice #": "30318",
    "ACCOUNT EMAIL": "cindi@jfy-designs.com",
    "Item Name": "CUSTOM SECTIONAL",
    "Moss Fabric": "Bobbie Truffle",
    "Order Status": "5. Shipped",
    "Tracking #": "1Z999AA10123456784",
  }),
  // Shipped but NO tracking value (must not invent tracking)
  row("r5", {
    "AMP Order #": "112525-3604",
    "Invoice #": "30280",
    "ACCOUNT EMAIL": "office@melaniemartininteriors.com",
    "Item Name": "Hits Package",
    "Order Status": "5. Shipped",
  }),
  // Cancelled order
  row("r6", {
    "AMP Order #": "100825-4583",
    "Invoice #": "30310",
    "ACCOUNT EMAIL": "interiors@upstatedown.com",
    "Item Name": "Banks Velvet Swatch Ring",
    "Order Status": "6. Cancelled",
    "Estimated Shipping": "Late October",
  }),
  // Two rows sharing an account email (multiple-match case)
  row("r7", {
    "AMP Order #": "100825-9001",
    "ACCOUNT EMAIL": "interiors@upstatedown.com",
    "Item Name": "Bobbie Dove 12 X 12 Swatch",
    "Order Status": "2. Ready to Produce",
    "Estimated Shipping": "Early November",
  }),
  // Exact match but Estimated Shipping was #INVALID DATA TYPE (cleaned to empty)
  row("r8", {
    "AMP Order #": "101725-3135",
    "ACCOUNT EMAIL": "someone@somewhere.com",
    "Item Name": "Coco Chair",
    "Order Status": "2. Ready to Produce",
  }),
];
