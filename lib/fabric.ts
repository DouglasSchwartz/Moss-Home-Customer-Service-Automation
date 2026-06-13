/**
 * Fabric Stock / Availability flow.
 *
 * Customer asks if a fabric is in stock ->
 *   1. Yardage known? (explicit, or derived from the furniture piece via the
 *      yardage chart). If not -> ask the customer.
 *   2. BarCloud Inventory Report (Pattern/Color):
 *      - one row with enough yardage            -> tell customer IN STOCK
 *      - enough only across multiple rows/lots  -> email warehouse (Jose) to
 *        confirm matching dye lot
 *      - not enough / no rows                   -> email the mill from the
 *        Fabric Master Sheet (Company Email:) asking for X yds + lead time
 *   3. Warehouse/mill replies are matched back to the customer thread via a
 *      [MOSS-REF ...] tag embedded in our outbound email (stateless).
 */

import { barcloudSheetId, fabricMasterSheetId } from "./sheets-config";
import { fetchSheetRows } from "./smartsheet";
import type { OrderRow } from "./types";

// ---------------------------------------------------------------------------
// BarCloud search
// ---------------------------------------------------------------------------

export const BARCLOUD_COLUMNS = {
  pattern: "Pattern",
  color: "Color",
  quantity: "Quantity",
  patternColor: "Pattern/Color",
  location: "Location ID",
} as const;

export const FABRIC_MASTER_COLUMNS = {
  patternColor: "Pattern/Color",
  millFabricName: "Mill Fabric Name/Color",
  company: "Company:",
  companyEmail: "Company Email:",
  fabricStatus: "FABRIC STATUS",
  leadTime: "Fabric Lead Time",
} as const;

export function normalizeFabric(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYards(value: string): number {
  const n = parseFloat((value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export type BarcloudResult = {
  fabric: string;
  yardsNeeded: number;
  matchedPatternColor: string | null;
  rows: { quantity: number; location: string; patternColor: string }[];
  totalYards: number;
  maxSingleRowYards: number;
  /** in_stock = one lot covers it; maybe_in_stock = only cumulatively; insufficient = total short; not_found = no rows */
  status: "in_stock" | "maybe_in_stock" | "insufficient" | "not_found";
};

export function searchBarcloudRows(
  rows: OrderRow[],
  fabric: string,
  yardsNeeded: number
): BarcloudResult {
  const needle = normalizeFabric(fabric);
  const matches = rows.filter((row) => {
    const pc = normalizeFabric(row.cells[BARCLOUD_COLUMNS.patternColor] ?? "");
    if (!pc) return false;
    return pc === needle || pc.includes(needle) || needle.includes(pc);
  });

  const detail = matches.map((row) => ({
    quantity: parseYards(row.cells[BARCLOUD_COLUMNS.quantity] ?? "0"),
    location: row.cells[BARCLOUD_COLUMNS.location] ?? "",
    patternColor: row.cells[BARCLOUD_COLUMNS.patternColor] ?? "",
  }));
  const withStock = detail.filter((d) => d.quantity > 0);

  const totalYards = withStock.reduce((s, d) => s + d.quantity, 0);
  const maxSingleRowYards = withStock.reduce((m, d) => Math.max(m, d.quantity), 0);

  let status: BarcloudResult["status"];
  if (matches.length === 0) status = "not_found";
  else if (maxSingleRowYards >= yardsNeeded) status = "in_stock";
  else if (totalYards >= yardsNeeded) status = "maybe_in_stock";
  else status = "insufficient";

  return {
    fabric,
    yardsNeeded,
    matchedPatternColor: matches[0]?.cells[BARCLOUD_COLUMNS.patternColor] ?? null,
    rows: withStock,
    totalYards,
    maxSingleRowYards,
    status,
  };
}

export async function searchBarcloud(
  fabric: string,
  yardsNeeded: number
): Promise<BarcloudResult> {
  const { rows } = await fetchSheetRows(barcloudSheetId());
  return searchBarcloudRows(rows, fabric, yardsNeeded);
}

// ---------------------------------------------------------------------------
// Fabric Master / mill contact
// ---------------------------------------------------------------------------

export type MillContact = {
  patternColor: string;
  millFabricName: string;
  company: string;
  companyEmail: string;
  fabricStatus: string;
  leadTime: string;
};

export function findMillContactInRows(
  rows: OrderRow[],
  fabric: string
): MillContact | null {
  const needle = normalizeFabric(fabric);
  const row = rows.find((r) => {
    const pc = normalizeFabric(r.cells[FABRIC_MASTER_COLUMNS.patternColor] ?? "");
    if (!pc) return false;
    return pc === needle || pc.includes(needle) || needle.includes(pc);
  });
  if (!row) return null;
  return {
    patternColor: row.cells[FABRIC_MASTER_COLUMNS.patternColor] ?? "",
    millFabricName: row.cells[FABRIC_MASTER_COLUMNS.millFabricName] ?? "",
    company: row.cells[FABRIC_MASTER_COLUMNS.company] ?? "",
    companyEmail: row.cells[FABRIC_MASTER_COLUMNS.companyEmail] ?? "",
    fabricStatus: row.cells[FABRIC_MASTER_COLUMNS.fabricStatus] ?? "",
    leadTime: row.cells[FABRIC_MASTER_COLUMNS.leadTime] ?? "",
  };
}

export async function findMillContact(fabric: string): Promise<MillContact | null> {
  const { rows } = await fetchSheetRows(fabricMasterSheetId());
  return findMillContactInRows(rows, fabric);
}

// ---------------------------------------------------------------------------
// REF tag: stateless link between warehouse/mill replies and customer thread
// ---------------------------------------------------------------------------

export type RefTag = {
  /** Gmail message id of the CUSTOMER email we ultimately reply to. */
  customerMessageId: string;
  stage: "warehouse" | "mill";
  fabric: string;
  yards: number;
};

export function buildRefTag(tag: RefTag): string {
  const fabric = tag.fabric.replace(/[|\]]/g, " ").trim();
  return `[MOSS-REF ${tag.stage}|${tag.customerMessageId}|${tag.yards}|${fabric}]`;
}

const REF_RE = /\[MOSS-REF (warehouse|mill)\|([^|\]]+)\|([0-9.]+)\|([^\]]+)\]/;

export function parseRefTag(text: string): RefTag | null {
  const m = (text ?? "").match(REF_RE);
  if (!m) return null;
  return {
    stage: m[1] as RefTag["stage"],
    customerMessageId: m[2].trim(),
    yards: parseFloat(m[3]),
    fabric: m[4].trim(),
  };
}

// ---------------------------------------------------------------------------
// Outbound email templates (deterministic — they carry the REF tag)
// ---------------------------------------------------------------------------

export function buildWarehouseEmail(input: {
  fabric: string;
  patternColor: string;
  yards: number;
  customerMessageId: string;
  lots: { quantity: number; location: string }[];
}): { subject: string; body: string } {
  const tag = buildRefTag({
    stage: "warehouse",
    customerMessageId: input.customerMessageId,
    fabric: input.patternColor || input.fabric,
    yards: input.yards,
  });
  const lotLines = input.lots
    .map((l) => `  - ${l.quantity} yds${l.location ? ` (${l.location})` : ""}`)
    .join("\n");
  return {
    subject: `Dye lot check: ${input.patternColor || input.fabric} - ${input.yards} yds`,
    body: [
      `Hi Jose,`,
      ``,
      `A customer needs ${input.yards} yds of ${input.patternColor || input.fabric}.`,
      `BarCloud shows enough total yardage, but split across entries:`,
      lotLines,
      ``,
      `Do we have ${input.yards} yds in a matching dye lot?`,
      ``,
      `Please reply to this email with yes or no (and any notes).`,
      ``,
      `Thanks!`,
      ``,
      tag,
    ].join("\n"),
  };
}

export function buildMillEmail(input: {
  millContact: MillContact;
  yards: number;
  customerMessageId: string;
}): { subject: string; body: string } {
  const fabricName =
    input.millContact.millFabricName || input.millContact.patternColor;
  const tag = buildRefTag({
    stage: "mill",
    customerMessageId: input.customerMessageId,
    fabric: input.millContact.patternColor,
    yards: input.yards,
  });
  return {
    subject: `Stock check: ${fabricName} - ${input.yards} yds`,
    body: [
      `Hello,`,
      ``,
      `Could you let us know if you have ${input.yards} yds of "${fabricName}" available?`,
      ``,
      `If it is not currently in stock, what is the lead time?`,
      ``,
      `Thank you,`,
      `Moss Home USA`,
      ``,
      tag,
    ].join("\n"),
  };
}
