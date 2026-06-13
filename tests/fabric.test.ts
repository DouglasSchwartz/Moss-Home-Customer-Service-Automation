import { describe, expect, it } from "vitest";
import {
  buildMillEmail,
  buildRefTag,
  buildWarehouseEmail,
  findMillContactInRows,
  parseRefTag,
  searchBarcloudRows,
} from "../lib/fabric";
import { resolveYards } from "../lib/fabric-pipeline";
import { estimateYardage } from "../lib/yardage";
import type { OrderRow } from "../lib/types";

function barRow(id: string, patternColor: string, qty: string, loc = "CA"): OrderRow {
  return {
    rowId: id,
    cells: {
      "Pattern/Color": patternColor,
      Quantity: qty,
      "Location ID": loc,
      Pattern: patternColor.split(" ")[0],
      Color: patternColor.split(" ").slice(1).join(" "),
    },
  };
}

const BAR_ROWS: OrderRow[] = [
  barRow("b1", "Avalon Flint", "0"),
  barRow("b2", "Bebe Anthracite", "14"),
  barRow("b3", "Bebe Anthracite", "6", "NC"),
  barRow("b4", "Bebe Anthracite", "5", "CA"),
  barRow("b5", "Harlow Ivory", "40"),
];

describe("yardage chart", () => {
  it("maps furniture descriptions to yards", () => {
    expect(estimateYardage("queen bed")?.yards).toBe(15);
    expect(estimateYardage("twin headboard")?.yards).toBe(5);
    expect(estimateYardage("ottoman")?.yards).toBe(8);
    expect(estimateYardage('sofa 90"')?.yards).toBe(24);
    expect(estimateYardage("a chaise lounge")?.yards).toBe(20);
  });

  it("falls back to the largest size when unsized", () => {
    expect(estimateYardage("a sofa")?.yards).toBe(30);
    expect(estimateYardage("bed")?.yards).toBe(18);
  });

  it("returns null for unknown items", () => {
    expect(estimateYardage("a curtain")).toBeNull();
    expect(estimateYardage("")).toBeNull();
  });
});

describe("resolveYards", () => {
  it("prefers explicit yards", () => {
    expect(resolveYards(12, "sofa").yards).toBe(12);
  });
  it("falls back to the chart", () => {
    expect(resolveYards(null, "queen bed").yards).toBe(15);
  });
  it("returns null when neither available", () => {
    expect(resolveYards(null, null).yards).toBeNull();
  });
});

describe("searchBarcloudRows", () => {
  it("in_stock when one row covers the request", () => {
    const r = searchBarcloudRows(BAR_ROWS, "Bebe Anthracite", 12);
    expect(r.status).toBe("in_stock");
    expect(r.maxSingleRowYards).toBe(14);
  });

  it("maybe_in_stock when only cumulative rows cover it", () => {
    const r = searchBarcloudRows(BAR_ROWS, "Bebe Anthracite", 20);
    expect(r.status).toBe("maybe_in_stock");
    expect(r.totalYards).toBe(25);
  });

  it("insufficient when total is short", () => {
    const r = searchBarcloudRows(BAR_ROWS, "Bebe Anthracite", 30);
    expect(r.status).toBe("insufficient");
  });

  it("not_found for unknown fabric", () => {
    const r = searchBarcloudRows(BAR_ROWS, "Nonexistent Teal", 5);
    expect(r.status).toBe("not_found");
  });

  it("ignores zero-quantity rows and matches case-insensitively", () => {
    const r = searchBarcloudRows(BAR_ROWS, "avalon flint", 5);
    expect(r.status).toBe("insufficient");
    expect(r.rows.length).toBe(0);
  });
});

describe("findMillContactInRows", () => {
  const MASTER: OrderRow[] = [
    {
      rowId: "m1",
      cells: {
        "Pattern/Color": "BEBE ANTHRACITE",
        "Mill Fabric Name/Color": "Tessuto Bebe / Antracite",
        "Company:": "Tessuto Mills",
        "Company Email:": "orders@tessuto.example",
        "FABRIC STATUS": "ACTIVE",
        "Fabric Lead Time": "4-6 weeks",
      },
    },
  ];

  it("finds the mill row case-insensitively", () => {
    const m = findMillContactInRows(MASTER, "Bebe Anthracite");
    expect(m?.companyEmail).toBe("orders@tessuto.example");
    expect(m?.millFabricName).toBe("Tessuto Bebe / Antracite");
  });

  it("returns null when missing", () => {
    expect(findMillContactInRows(MASTER, "Harlow Ivory")).toBeNull();
  });
});

describe("REF tags", () => {
  it("round-trips through an email body", () => {
    const tag = buildRefTag({
      stage: "warehouse",
      customerMessageId: "18c2abc123",
      fabric: "Bebe Anthracite",
      yards: 20,
    });
    const parsed = parseRefTag(`Yes we have it!\n\n> quoted stuff\n${tag}`);
    expect(parsed).toEqual({
      stage: "warehouse",
      customerMessageId: "18c2abc123",
      yards: 20,
      fabric: "Bebe Anthracite",
    });
  });

  it("returns null when no tag present", () => {
    expect(parseRefTag("just a normal customer email about fabric")).toBeNull();
  });

  it("warehouse email contains the tag and lot breakdown", () => {
    const mail = buildWarehouseEmail({
      fabric: "Bebe Anthracite",
      patternColor: "Bebe Anthracite",
      yards: 20,
      customerMessageId: "msg1",
      lots: [
        { quantity: 14, location: "CA" },
        { quantity: 6, location: "NC" },
      ],
    });
    expect(mail.body).toContain("[MOSS-REF warehouse|msg1|20|Bebe Anthracite]");
    expect(mail.body).toContain("14 yds (CA)");
    expect(mail.subject).toContain("Dye lot check");
  });

  it("mill email uses the mill fabric name and carries the tag", () => {
    const mail = buildMillEmail({
      millContact: {
        patternColor: "BEBE ANTHRACITE",
        millFabricName: "Tessuto Bebe / Antracite",
        company: "Tessuto Mills",
        companyEmail: "orders@tessuto.example",
        fabricStatus: "ACTIVE",
        leadTime: "4-6 weeks",
      },
      yards: 20,
      customerMessageId: "msg1",
    });
    expect(mail.body).toContain('"Tessuto Bebe / Antracite"');
    expect(mail.body).toContain("[MOSS-REF mill|msg1|20|BEBE ANTHRACITE]");
    expect(mail.body).toContain("lead time");
  });
});
