import { describe, expect, it } from "vitest";
import { lookupOrder } from "../lib/matching";
import { decideReplyMode } from "../lib/safety";
import type { ExtractionResult } from "../lib/types";
import { MOCK_ROWS } from "./fixtures/emails";

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

function lookup(e: ExtractionResult, email: string | null = null) {
  return lookupOrder(MOCK_ROWS, e, email);
}

describe("decideReplyMode — v1 safety gate", () => {
  it("auto-replies on clean WISMO with exact AMP match + Estimated Shipping", () => {
    const e = extraction({ ampOrderNumber: "032725-5713" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
    expect(d.useShippedLanguage).toBe(false);
  });

  it("treats multiple rows of the SAME order as line items, not ambiguity", () => {
    const e = extraction({ ampOrderNumber: "032725-5713" });
    const l = lookup(e);
    expect(l.multipleMatches).toBe(false);
    expect(l.rows?.length).toBe(2);
    const d = decideReplyMode(e, l);
    expect(d.reply_mode).toBe("auto_reply");
  });

  it("auto-replies with shipped language when tracking exists", () => {
    const e = extraction({ intent: "tracking_status", ampOrderNumber: "112025-23759" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
    expect(d.useShippedLanguage).toBe(true);
  });

  it("withholds when shipped but tracking is missing", () => {
    const e = extraction({ intent: "tracking_status", ampOrderNumber: "112525-3604" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/tracking is missing/i);
  });

  it("withholds on Pending Materials status", () => {
    const e = extraction({ ampOrderNumber: "030926-23631" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/pending materials/i);
  });

  it("withholds on cancelled orders", () => {
    const e = extraction({ ampOrderNumber: "100825-4583" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/cancelled/i);
  });

  it("withholds when Estimated Shipping is empty (#INVALID cleaned away)", () => {
    const e = extraction({ ampOrderNumber: "101725-3135" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/estimated shipping is empty/i);
  });

  it("auto-replies to COM received questions using Fabric Location / Pending Materials", () => {
    const e = extraction({ intent: "com_received_status", ampOrderNumber: "030926-23631" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
    expect(d.comMode).toBe(true);
    expect(d.reason).toMatch(/awaiting fabric/i);
  });

  it("auto-replies on a client-name match that resolves to a single clean order", () => {
    const e = extraction({ intent: "client_project_lookup", clientName: "Cocoon" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
  });

  it("still holds client-name matches when the order itself is not clean", () => {
    // "Las Brisas" resolves to one order, but it's pending materials.
    const e = extraction({ intent: "client_project_lookup", clientName: "Las Brisas" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/pending materials/i);
  });

  it("routes unsafe signals to human review before anything else", () => {
    const e = extraction({
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
    });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/unsafe signal/i);
  });

  it("routes multiple matches to human review", () => {
    const e = extraction({});
    const d = decideReplyMode(e, lookup(e, "interiors@upstatedown.com"));
    expect(d.reply_mode).toBe("human_review");
    expect(d.reason).toMatch(/multiple/i);
  });

  it("auto-replies asking the customer to verify an identifier that matched nothing", () => {
    const e = extraction({ ampOrderNumber: "999999-9999" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
    expect(d.askForInfo).toBe(true);
    expect(d.reason).toMatch(/not found in current open orders/i);
  });

  it("auto-replies asking for an order number when nothing was provided", () => {
    const e = extraction({ clientName: "Nonexistent Client LLC" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("auto_reply");
    expect(d.askForInfo).toBe(true);
  });

  it("ignores spam", () => {
    const e = extraction({ intent: "spam_or_unrelated" });
    const d = decideReplyMode(e, lookup(e));
    expect(d.reply_mode).toBe("ignore");
  });
});
