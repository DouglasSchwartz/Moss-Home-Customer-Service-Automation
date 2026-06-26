import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionResult, OrderRow } from "../lib/types";
import { MOCK_ROWS, makeRequest } from "./fixtures/emails";

const BARCLOUD_ID = "2099244581212036";
const FABRIC_MASTER_ID = "7520330970359684";

function barRow(id: string, patternColor: string, qty: string, loc = "CA"): OrderRow {
  return {
    rowId: id,
    cells: { "Pattern/Color": patternColor, Quantity: qty, "Location ID": loc },
  };
}

const BARCLOUD_ROWS: OrderRow[] = [
  barRow("b1", "Bebe Anthracite", "14"),
  barRow("b2", "Bebe Anthracite", "11", "NC"),
  barRow("b3", "Harlow Ivory", "40"),
  barRow("b4", "Rare Linen", "2"),
];

const FABRIC_MASTER_ROWS: OrderRow[] = [
  {
    rowId: "fm1",
    cells: {
      "Pattern/Color": "RARE LINEN",
      "Mill Fabric Name/Color": "Mill Rare / Lino",
      "Company:": "Lino Mills",
      "Company Email:": "stock@linomills.example",
    },
  },
  {
    rowId: "fm2",
    cells: {
      "Pattern/Color": "BEBE ANTHRACITE",
      "Mill Fabric Name/Color": "Tessuto Bebe",
      "Company:": "Tessuto",
      "Company Email:": "orders@tessuto.example",
    },
  },
];

// Archive sheet with a shipped order that is NOT on the master sheet.
const ARCHIVE_ID = "6190562341244804";
const ARCHIVE_ROWS: OrderRow[] = [
  {
    rowId: "a1",
    cells: {
      "AMP Order #": "010125-1111",
      "Customer PO #": "OLD-PO-99",
      Customer: "VINTAGE INTERIORS",
      "ACCOUNT EMAIL": "old@vintage.com",
      "Item Name": "Shipped Sofa",
      "Order Status": "7. Shipped",
      "Tracking #": "1Z999AA10123456784",
      "Actual Ship Date": "05/01/26",
    },
  },
];

vi.mock("../lib/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/claude")>();
  return {
    ...actual,
    extract: vi.fn(),
    generate: vi.fn(async () => "Generated reply.\n\nBest,\nMoss Home Customer Service"),
    classifyStockReply: vi.fn(),
  };
});

vi.mock("../lib/smartsheet", () => ({
  fetchOrderRows: vi.fn(),
  fetchSheetRows: vi.fn(async (sheetId: string | number) => {
    const id = String(sheetId);
    if (id === "6535661298706308")
      return { sheetName: "MASTER: Open Orders Sheet", rows: MOCK_ROWS, columnTitles: [] };
    if (id === BARCLOUD_ID)
      return { sheetName: "BarCloud Inventory Report", rows: BARCLOUD_ROWS, columnTitles: [] };
    if (id === FABRIC_MASTER_ID)
      return { sheetName: "Fabric Master Sheet", rows: FABRIC_MASTER_ROWS, columnTitles: [] };
    if (id === ARCHIVE_ID)
      return { sheetName: "ARCHIVE: Master Open Order 2026", rows: ARCHIVE_ROWS, columnTitles: [] };
    return { sheetName: `sheet-${id}`, rows: [], columnTitles: [] };
  }),
}));

import { classifyStockReply, extract } from "../lib/claude";
import { processEmail } from "../lib/pipeline";

const mockExtract = vi.mocked(extract);
const mockClassify = vi.mocked(classifyStockReply);

function extraction(over: Partial<ExtractionResult>): ExtractionResult {
  return {
    intent: "fabric_stock_inquiry",
    ampOrderNumber: null,
    poNumber: null,
    invoiceNumber: null,
    clientName: null,
    projectName: null,
    customerEmail: null,
    materialOrComReference: null,
    senderName: "Marie Richards",
    senderCompany: null,
    fabricRequests: [],
    furnitureItem: null,
    comShipmentClaimed: false,
    secondaryQuestions: [],
    summary: "",
    unsafeSignals: {
      complaint: false,
      damage: false,
      returnOrRefund: false,
      cancellation: false,
      addressChange: false,
      legalOrChargeback: false,
      angryOrEscalated: false,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DRY_RUN = "true";
});

describe("fabric stock inquiry", () => {
  it("asks for yardage when none given and no furniture item", async () => {
    mockExtract.mockResolvedValue(
      extraction({ fabricRequests: [{ fabric: "Bebe Anthracite", yards: null }] })
    );
    const res = await processEmail(
      makeRequest({ subject: "Fabric check", textBody: "Do you have Bebe Anthracite in stock?" })
    );
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.askedForInfo).toBe(true);
    expect(res.reply).toContain("How many yards");
    expect(res.reply).toContain("Hi Marie,");
  });

  it("redirects a stock question misclassified as quote_request", async () => {
    mockExtract.mockResolvedValue(
      extraction({
        intent: "quote_request",
        fabricRequests: [{ fabric: "Harlow Ivory", yards: 25 }],
      })
    );
    const res = await processEmail(
      makeRequest({ textBody: "Do you have 25 yards of Harlow Ivory in stock?" })
    );
    expect(res.intent).toBe("fabric_stock_inquiry");
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.reply).toContain("in stock");
  });

  it("leaves a genuine pricing quote (no stock language) as quote_request", async () => {
    mockExtract.mockResolvedValue(
      extraction({
        intent: "quote_request",
        fabricRequests: [{ fabric: "Harlow Ivory", yards: 25 }],
      })
    );
    const res = await processEmail(
      makeRequest({ textBody: "What is the price per yard for Harlow Ivory?" })
    );
    expect(res.intent).toBe("quote_request");
    expect(res.reply_mode).toBe("human_review");
  });

  it("derives yardage from the furniture item via the chart", async () => {
    mockExtract.mockResolvedValue(
      extraction({
        fabricRequests: [{ fabric: "Bebe Anthracite", yards: null }],
        furnitureItem: "queen bed",
      })
    );
    const res = await processEmail(
      makeRequest({ textBody: "Do you have Bebe Anthracite for a queen bed?" })
    );
    // queen bed = 15 yds; max single lot = 14 -> cumulative 25 -> warehouse check
    expect(res.reply_mode).toBe("ignore");
    expect(res.outboundEmails).toHaveLength(1);
    expect(res.outboundEmails![0].to).toBe("josediaz@mosshomeusa.com");
    expect(res.outboundEmails![0].body).toContain("[MOSS-REF warehouse|");
  });

  it("replies in stock when a single lot covers the request", async () => {
    mockExtract.mockResolvedValue(
      extraction({ fabricRequests: [{ fabric: "Harlow Ivory", yards: 25 }] })
    );
    const res = await processEmail(makeRequest({ textBody: "25 yds of Harlow Ivory?" }));
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.reply).toContain("in stock");
    expect(res.outboundEmails).toBeUndefined();
  });

  it("goes straight to the mill when BarCloud is insufficient", async () => {
    mockExtract.mockResolvedValue(
      extraction({ fabricRequests: [{ fabric: "Rare Linen", yards: 10 }] })
    );
    const res = await processEmail(makeRequest({ textBody: "10 yds of Rare Linen?" }));
    expect(res.reply_mode).toBe("ignore");
    expect(res.outboundEmails![0].to).toBe("stock@linomills.example");
    expect(res.outboundEmails![0].body).toContain('"Mill Rare / Lino"');
    expect(res.outboundEmails![0].body).toContain("[MOSS-REF mill|");
  });

  it("routes to human review when fabric is unknown everywhere", async () => {
    mockExtract.mockResolvedValue(
      extraction({ fabricRequests: [{ fabric: "Ghost Fabric", yards: 10 }] })
    );
    const res = await processEmail(makeRequest({ textBody: "10 yds of Ghost Fabric?" }));
    expect(res.reply_mode).toBe("human_review");
  });
});

describe("warehouse / mill replies (REF tag)", () => {
  it("relays warehouse YES to the customer thread", async () => {
    mockClassify.mockResolvedValue({
      answer: "yes",
      leadTimeWeeks: null,
      leadTimeText: null,
      notes: "",
    });
    const res = await processEmail(
      makeRequest({
        from: "Jose <jose@mosshomeusa.com>",
        textBody: "Yes, we have it.\n\n> [MOSS-REF warehouse|custmsg1|20|Bebe Anthracite]",
      })
    );
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.replyToMessageId).toBe("custmsg1");
    expect(res.reply).toContain("20 yds of Bebe Anthracite in stock");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("escalates warehouse NO to the mill", async () => {
    mockClassify.mockResolvedValue({
      answer: "no",
      leadTimeWeeks: null,
      leadTimeText: null,
      notes: "",
    });
    const res = await processEmail(
      makeRequest({
        from: "Jose <jose@mosshomeusa.com>",
        textBody: "No, lots don't match.\n\n> [MOSS-REF warehouse|custmsg1|20|Bebe Anthracite]",
      })
    );
    expect(res.reply_mode).toBe("ignore");
    expect(res.outboundEmails![0].to).toBe("orders@tessuto.example");
    expect(res.outboundEmails![0].body).toContain("[MOSS-REF mill|custmsg1|20|");
  });

  it("relays mill backorder with lead time + 2 weeks", async () => {
    mockClassify.mockResolvedValue({
      answer: "no",
      leadTimeWeeks: 4,
      leadTimeText: "4 weeks",
      notes: "",
    });
    const res = await processEmail(
      makeRequest({
        from: "Mill <orders@tessuto.example>",
        textBody: "Out of stock, 4 weeks.\n\n> [MOSS-REF mill|custmsg1|20|Bebe Anthracite]",
      })
    );
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.replyToMessageId).toBe("custmsg1");
    expect(res.reply).toContain("backordered");
    expect(res.reply).toContain("approximately 6 weeks");
  });

  it("routes ambiguous replies to human review", async () => {
    mockClassify.mockResolvedValue({
      answer: "unclear",
      leadTimeWeeks: null,
      leadTimeText: null,
      notes: "maybe, depends on a return",
    });
    const res = await processEmail(
      makeRequest({
        from: "Jose <jose@mosshomeusa.com>",
        textBody: "Maybe? Depends.\n\n> [MOSS-REF warehouse|custmsg1|20|Bebe Anthracite]",
      })
    );
    expect(res.reply_mode).toBe("human_review");
  });
});

describe("archive sheet lookup", () => {
  it("finds a shipped order on the archive and auto-replies with tracking", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "tracking_status", ampOrderNumber: "010125-1111" })
    );
    const res = await processEmail(
      makeRequest({ textBody: "Tracking for order 010125-1111 please" })
    );
    expect(res.match.found).toBe(true);
    expect(res.reply_mode).toBe("auto_reply");
  });
});
