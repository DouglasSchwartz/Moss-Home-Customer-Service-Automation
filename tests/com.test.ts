import { describe, expect, it } from "vitest";
import {
  COM_PUSHBACK_RE,
  COM_TRACKING_REQUEST_MARKER,
  buildComTrackingRequest,
  evaluateComShipmentClaim,
  greetingFirstName,
  looksLikeTrackingNumber,
  mentionsCom,
} from "../lib/com";
import type { OrderRow } from "../lib/types";

const row = (cells: Record<string, string>): OrderRow => ({ rowId: "r", cells });
const pending = row({ "Order Status": "1. Pending Materials" });
const received = row({ "Fabric Location": "Rack 5", "Order Status": "3. In Production" });
const ambiguous = row({ "Order Status": "3. In Production" });
const cancelled = row({ "Order Status": "6. Cancelled" });

describe("COM pushback detection", () => {
  it("matches common 'should have it' phrasings", () => {
    expect(COM_PUSHBACK_RE.test("That's odd, you should have received it by now")).toBe(true);
    expect(COM_PUSHBACK_RE.test("We sent the fabric last Monday")).toBe(true);
    expect(COM_PUSHBACK_RE.test("It shipped already")).toBe(true);
    expect(COM_PUSHBACK_RE.test("Thanks, sounds good")).toBe(false);
  });

  it("detects COM mentions", () => {
    expect(mentionsCom("Did you get our COM fabric?")).toBe(true);
    expect(mentionsCom("Customer's own material")).toBe(true);
    expect(mentionsCom("Where is my sofa?")).toBe(false);
  });
});

describe("looksLikeTrackingNumber", () => {
  it("recognizes carrier tracking numbers", () => {
    expect(looksLikeTrackingNumber("Tracking: 1Z999AA10123456784")).toBe(true);
    expect(looksLikeTrackingNumber("It's 9400110200881234567890")).toBe(true);
    expect(looksLikeTrackingNumber("tracking # ABCD12345")).toBe(true);
  });
  it("does not flag ordinary prose", () => {
    expect(looksLikeTrackingNumber("you should have it by now")).toBe(false);
  });
});

describe("greetingFirstName", () => {
  it("prefers the signature name, then the From display name", () => {
    expect(greetingFirstName("Marie Richards", "x <x@y.com>")).toBe("Marie");
    expect(greetingFirstName(null, "Jacq Nguyen <jacq@mosshomeusa.com>")).toBe("Jacq");
    expect(greetingFirstName(null, "jacq@mosshomeusa.com")).toBeNull();
  });
});

describe("buildComTrackingRequest", () => {
  it("greets by name and includes the detectable marker phrase", () => {
    const msg = buildComTrackingRequest("Jacq");
    expect(msg.startsWith("Hi Jacq,")).toBe(true);
    expect(COM_TRACKING_REQUEST_MARKER.test(msg)).toBe(true);
    expect(msg).toContain("Moss Home Customer Service");
  });
  it("falls back to a generic greeting", () => {
    expect(buildComTrackingRequest(null).startsWith("Hello,")).toBe(true);
  });
});

describe("evaluateComShipmentClaim", () => {
  const base = { newContent: "you should have it by now", fullText: "COM thread" };

  it("asks for tracking when all items are pending (not received)", () => {
    expect(evaluateComShipmentClaim({ lineItems: [pending], ...base })).toBe("ask_tracking");
  });

  it("falls through (null) when some fabric is already received", () => {
    expect(evaluateComShipmentClaim({ lineItems: [received], ...base })).toBeNull();
  });

  it("routes to a human when receipt status is ambiguous", () => {
    expect(evaluateComShipmentClaim({ lineItems: [ambiguous], ...base })).toBe("human_unclear");
  });

  it("routes to a human when a line item is cancelled", () => {
    expect(evaluateComShipmentClaim({ lineItems: [pending, cancelled], ...base })).toBe(
      "human_unclear"
    );
  });

  it("routes to a human (trace) when the sender already pasted a tracking number", () => {
    expect(
      evaluateComShipmentClaim({
        lineItems: [pending],
        newContent: "Here it is: 1Z999AA10123456784",
        fullText: "COM thread",
      })
    ).toBe("human_trace");
  });

  it("routes to a human (trace) when we already asked for tracking in the thread", () => {
    expect(
      evaluateComShipmentClaim({
        lineItems: [pending],
        newContent: "you should have it by now",
        fullText: "could you reply with the tracking number for your COM fabric shipment?",
      })
    ).toBe("human_trace");
  });
});
