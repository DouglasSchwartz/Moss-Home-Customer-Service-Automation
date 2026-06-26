import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "../lib/types";
import {
  EMAIL_CAMPE,
  EMAIL_COCOON_WISMO,
  EMAIL_COM_RECEIVED,
  EMAIL_DAMAGE,
  EMAIL_PO_TRACKING,
  EMAIL_YARDAGE,
  MOCK_ROWS,
  makeRequest,
} from "./fixtures/emails";

// Mock the model and Smartsheet layers; everything else runs for real.
vi.mock("../lib/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/claude")>();
  return {
    ...actual,
    extract: vi.fn(),
    generate: vi.fn(async () => 
      "Thank you for reaching out. Your order is currently estimated for completion in Early July.\n\nBest,\nMoss Home Customer Service"
    ),
  };
});
vi.mock("../lib/smartsheet", () => ({
  fetchOrderRows: vi.fn(async () => ({
    sheetName: "MASTER: Open Orders Sheet",
    rows: MOCK_ROWS,
    columnTitles: [],
  })),
  // Multi-sheet lookup: the MASTER sheet gets MOCK_ROWS, every other sheet
  // (Basics, archives, BarCloud, Fabric Master) is empty unless a test
  // overrides this mock.
  fetchSheetRows: vi.fn(async (sheetId: string | number) => {
    if (String(sheetId) === "6535661298706308") {
      return {
        sheetName: "MASTER: Open Orders Sheet",
        rows: MOCK_ROWS,
        columnTitles: [],
      };
    }
    return { sheetName: `sheet-${sheetId}`, rows: [], columnTitles: [] };
  }),
}));

import { extract, generate } from "../lib/claude";
import { processEmail } from "../lib/pipeline";

const mockExtract = vi.mocked(extract);
const mockGenerate = vi.mocked(generate);

function extraction(over: Partial<ExtractionResult>): ExtractionResult {
  return {
    intent: "order_status",
    ampOrderNumber: null,
    poNumber: null,
    invoiceNumber: null,
    clientName: null,
    projectName: null,
    customerEmail: null,
    materialOrComReference: null,
    senderName: null,
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

describe("processEmail pipeline", () => {
  it("golden path: Cocoon WISMO -> auto_reply with generated text", async () => {
    mockExtract.mockResolvedValue(
      extraction({ ampOrderNumber: "032725-5713", poNumber: "222805" })
    );
    const res = await processEmail(EMAIL_COCOON_WISMO);
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.match.matchType).toBe("amp_order");
    expect(res.reply).toContain("estimated for completion");
    expect(res.askedForInfo).toBe(false);
    expect(res.dryRun).toBe(true);
  });

  it("PO# 7776 -> matches '#PO7776' row, auto_reply", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "tracking_status", poNumber: "7776" })
    );
    const res = await processEmail(EMAIL_PO_TRACKING);
    // r2 status is "4. Pending Shipment" with Estimated Shipping -> auto_reply
    expect(res.match.found).toBe(true);
    expect(res.match.matchType).toBe("customer_po");
    expect(res.reply_mode).toBe("auto_reply");
  });

  it("Campe client-name -> FOUND via the Customer PO # column, auto_reply with status", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "client_project_lookup", clientName: "Campe" })
    );
    const res = await processEmail(EMAIL_CAMPE);
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.match.found).toBe(true);
    expect(res.askedForInfo).toBe(false);
    expect(res.reply).toBeTruthy();
  });

  it("unknown client name -> auto_reply asking for order number", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "client_project_lookup", clientName: "Totally Unknown LLC" })
    );
    const res = await processEmail(
      makeRequest({ textBody: "Status on the order for Totally Unknown LLC?" })
    );
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.askedForInfo).toBe(true);
  });

  it("COM received -> auto_reply with per-item fabric status", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "com_received_status", ampOrderNumber: "030926-23631" })
    );
    const res = await processEmail(EMAIL_COM_RECEIVED);
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.match.found).toBe(true);
    expect(res.reply).toBeTruthy();
  });

  it("COM pushback follow-up -> auto_reply asking for the COM shipment tracking number", async () => {
    mockExtract.mockResolvedValue(
      extraction({
        intent: "com_received_status",
        ampOrderNumber: "030926-23631",
        comShipmentClaimed: true,
      })
    );
    const res = await processEmail(
      makeRequest({
        from: "Jacq Nguyen <jacq@mosshomeusa.com>",
        subject: "Re: COM for Las Brisas Project",
        textBody:
          "That's odd, you should have received it by now.\n\nOn Thu, Jun 26, 2026 Moss wrote:\n> Hi Jacq, for order 030926-23631 we do not show COM fabric received yet for the Las Brisas Lounge Chairs.\n> Best,\n> Moss Home Customer Service",
      })
    );
    expect(res.reply_mode).toBe("auto_reply");
    expect(res.reply).toContain("tracking number for your COM fabric shipment");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("yardage request -> human_review", async () => {
    mockExtract.mockResolvedValue(
      extraction({ intent: "yardage_request", projectName: "MATIS CREATIVE" })
    );
    const res = await processEmail(EMAIL_YARDAGE);
    expect(res.reply_mode).toBe("human_review");
  });

  it("damage complaint -> human_review on unsafe signal", async () => {
    mockExtract.mockResolvedValue(
      extraction({
        intent: "damage_or_complaint",
        ampOrderNumber: "112025-23759",
        unsafeSignals: {
          complaint: true,
          damage: true,
          returnOrRefund: true,
          cancellation: false,
          addressChange: false,
          legalOrChargeback: false,
          angryOrEscalated: false,
        },
      })
    );
    const res = await processEmail(EMAIL_DAMAGE);
    expect(res.reply_mode).toBe("human_review");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("skips no-reply senders without calling the model", async () => {
    const res = await processEmail(
      makeRequest({ from: "no-reply@notifications.example.com", textBody: "automated" })
    );
    expect(res.reply_mode).toBe("ignore");
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("ignores a forward of our own reply with no new content (never double-replies)", async () => {
    const res = await processEmail(
      makeRequest({
        from: "douglas@asgardtech.co",
        subject: "Fwd: Order Status",
        textBody:
          "---------- Forwarded message ----------\nFrom: Douglas <douglas@mosshomeusa.com>\n\nHi Marie,\n\nYour order is estimated for completion in Early July.\n\nBest,\nMoss Home Customer Service",
      })
    );
    expect(res.reply_mode).toBe("ignore");
    expect(res.reason).toMatch(/already answered/i);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("still processes a customer reply that quotes us but contains the requested info", async () => {
    mockExtract.mockResolvedValue(extraction({ ampOrderNumber: "032725-5713" }));
    const res = await processEmail(
      makeRequest({
        from: "marie@cocoon-atx.com",
        subject: "Re: Order Status",
        textBody:
          "It's order 032725-5713, thanks!\n\nOn Thu, Jun 12, 2026 at 9:07 AM Moss wrote:\n> Could you reply with the order number?\n> Best,\n> Moss Home Customer Service",
      })
    );
    expect(res.reply_mode).toBe("auto_reply");
  });

  it("extraction failure -> human_review with error captured", async () => {
    mockExtract.mockRejectedValue(new Error("Extraction failed validation after retry"));
    const res = await processEmail(EMAIL_COCOON_WISMO);
    expect(res.reply_mode).toBe("human_review");
    expect(res.error).toMatch(/validation/);
  });

  it("generation lint failure -> human_review, never sends unlinted text", async () => {
    mockExtract.mockResolvedValue(extraction({ ampOrderNumber: "032725-5713" }));
    mockGenerate.mockRejectedValue(
      new Error('Generated reply failed lint after retry: forbidden phrase "scheduled to ship"')
    );
    const res = await processEmail(EMAIL_COCOON_WISMO);
    expect(res.reply_mode).toBe("human_review");
    expect(res.reply).toBeUndefined();
  });

  it("reports dryRun=false when DRY_RUN env is false", async () => {
    process.env.DRY_RUN = "false";
    mockExtract.mockResolvedValue(extraction({ ampOrderNumber: "032725-5713" }));
    const res = await processEmail(EMAIL_COCOON_WISMO);
    expect(res.dryRun).toBe(false);
  });
});
