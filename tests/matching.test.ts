import { describe, expect, it } from "vitest";
import { lookupOrder, normalizeId, isValidAmpOrderFormat } from "../lib/matching";
import { MOCK_ROWS } from "./fixtures/emails";

const emptyExtraction = {
  ampOrderNumber: null,
  poNumber: null,
  invoiceNumber: null,
  clientName: null,
  projectName: null,
};

describe("normalizeId", () => {
  it("strips #, spaces, and case", () => {
    expect(normalizeId("#PO 7776")).toBe("po7776");
    expect(normalizeId("032725-5713 ")).toBe("032725-5713");
  });
});

describe("isValidAmpOrderFormat", () => {
  it("accepts iPad and desktop formats", () => {
    expect(isValidAmpOrderFormat("032725-5713")).toBe(true);
    expect(isValidAmpOrderFormat("030926-23631")).toBe(true);
    expect(isValidAmpOrderFormat("156182-w123456")).toBe(true);
    expect(isValidAmpOrderFormat("7776")).toBe(false);
  });
});

describe("lookupOrder priority", () => {
  it("finds by AMP Order # with high confidence", () => {
    const r = lookupOrder(
      MOCK_ROWS,
      { ...emptyExtraction, ampOrderNumber: "032725-5713" },
      null
    );
    expect(r.found).toBe(true);
    expect(r.matchType).toBe("amp_order");
    expect(r.confidence).toBe("high");
    expect(r.row?.cells["Estimated Shipping"]).toBe("Early July");
  });

  it("finds PO numbers stored as '#PO...' in the AMP Order # column", () => {
    const r = lookupOrder(MOCK_ROWS, { ...emptyExtraction, poNumber: "7776" }, null);
    expect(r.found).toBe(true);
    expect(r.matchType).toBe("customer_po");
    expect(r.confidence).toBe("high");
    expect(r.row?.rowId).toBe("r2");
  });

  it("finds by Customer PO # column", () => {
    const r = lookupOrder(MOCK_ROWS, { ...emptyExtraction, poNumber: "222805" }, null);
    expect(r.found).toBe(true);
    expect(r.matchType).toBe("customer_po");
    expect(r.row?.rowId).toBe("r1");
  });

  it("finds by Invoice #", () => {
    const r = lookupOrder(
      MOCK_ROWS,
      { ...emptyExtraction, invoiceNumber: "30318" },
      null
    );
    expect(r.found).toBe(true);
    expect(r.matchType).toBe("invoice");
    expect(r.row?.rowId).toBe("r4");
  });

  it("prefers AMP Order # over other keys", () => {
    const r = lookupOrder(
      MOCK_ROWS,
      { ...emptyExtraction, ampOrderNumber: "032725-5713", invoiceNumber: "30318" },
      null
    );
    expect(r.matchType).toBe("amp_order");
  });

  it("matches client/project names at LOW confidence", () => {
    const r = lookupOrder(
      MOCK_ROWS,
      { ...emptyExtraction, clientName: "Las Brisas" },
      null
    );
    expect(r.found).toBe(true);
    expect(r.matchType).toBe("client_project");
    expect(r.confidence).toBe("low");
  });

  it("returns multiple matches for a shared account email", () => {
    const r = lookupOrder(MOCK_ROWS, emptyExtraction, "interiors@upstatedown.com");
    expect(r.found).toBe(true);
    expect(r.multipleMatches).toBe(true);
    expect(r.candidateCount).toBe(2);
  });

  it("flags identifierWithoutRow for a valid AMP number with no row (sync gap)", () => {
    const r = lookupOrder(
      MOCK_ROWS,
      { ...emptyExtraction, ampOrderNumber: "999999-9999" },
      null
    );
    expect(r.found).toBe(false);
    expect(r.identifierWithoutRow).toBe(true);
  });

  it("returns clean no-match when nothing was extracted", () => {
    const r = lookupOrder(MOCK_ROWS, emptyExtraction, "stranger@nowhere.com");
    expect(r.found).toBe(false);
    expect(r.identifierWithoutRow).toBeFalsy();
  });
});
