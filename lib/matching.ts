import { COLUMN_TITLES } from "./smartsheet-columns";
import { activeOrderSheets, archiveOrderSheets } from "./sheets-config";
import { fetchSheetRows } from "./smartsheet";
import type { ExtractionResult, LookupResult, OrderRow } from "./types";

/** AMP/iPad order format: 032725-5713, 030926-23631, 112025-23759 */
export const AMP_ORDER_RE = /\b\d{6}-\d{3,5}\b/;
/** Desktop AMP order format */
export const AMP_DESKTOP_RE = /\b156182-w\d{6}\b/i;

/** Normalize identifiers for comparison: trim, lowercase, strip '#', collapse spaces. */
export function normalizeId(value: string): string {
  return value.toLowerCase().replace(/#/g, "").replace(/\s+/g, "").trim();
}

export function isValidAmpOrderFormat(value: string): boolean {
  return AMP_ORDER_RE.test(value) || AMP_DESKTOP_RE.test(value);
}

function findExact(
  rows: OrderRow[],
  columnTitle: string,
  needle: string
): OrderRow[] {
  const n = normalizeId(needle);
  if (!n) return [];
  return rows.filter((row) => {
    const cell = row.cells[columnTitle];
    return cell !== undefined && normalizeId(cell) === n;
  });
}

/**
 * PO cells often carry a sidemark or note appended by the rep, e.g.
 * "7776/showroom" or "222805 / Campe". Customers only know their bare PO,
 * so we match on TOKENS: the cell split on separators must contain the
 * needle as a whole token (so "7776" matches "7776/showroom" but NOT "17776").
 */
function poTokens(cell: string): string[] {
  return normalizeId(cell)
    .split(/[\/,;|&\-_()]+/)
    .filter(Boolean);
}

function findPoToken(
  rows: OrderRow[],
  columnTitle: string,
  needle: string
): OrderRow[] {
  const n = normalizeId(needle);
  if (!n) return [];
  return rows.filter((row) => {
    const cell = row.cells[columnTitle];
    if (cell === undefined) return false;
    const norm = normalizeId(cell);
    return norm === n || poTokens(cell).includes(n);
  });
}

/**
 * When a key matches rows across DIFFERENT orders, try narrowing by the
 * sender's company from their signature against the Customer column
 * (e.g. "BOHLERT MASSEY INTERIORS" narrows shared PO "7776").
 */
function filterByCompany(matches: OrderRow[], company: string | null): OrderRow[] {
  if (!company || company.trim().length < 3) return matches;
  if (groupByOrder(matches).length <= 1) return matches;
  const c = company.toLowerCase().trim();
  const filtered = matches.filter((row) => {
    const customer = (row.cells[COLUMN_TITLES.customer] ?? "").toLowerCase();
    return customer.length > 0 && (customer.includes(c) || c.includes(customer));
  });
  // Only use the filter if it actually resolves to a single order.
  if (filtered.length > 0 && groupByOrder(filtered).length === 1) return filtered;
  return matches;
}

/**
 * The Open Orders sheet has ONE ROW PER LINE ITEM, so a single order
 * (e.g. a 7-piece upholstery order) legitimately spans several rows that all
 * share the same AMP Order #. Group matched rows by order: rows of the same
 * order are line items, not ambiguity. Only DISTINCT orders count as
 * "multiple matches" needing a human.
 */
function groupByOrder(matches: OrderRow[]): OrderRow[][] {
  const ampCol = COLUMN_TITLES.ampOrderNumber;
  const groups = new Map<string, OrderRow[]>();
  for (const row of matches) {
    // Rows without an order number can't be grouped; treat each as its own order.
    const key = normalizeId(row.cells[ampCol] ?? "") || `row:${row.rowId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()];
}

function buildResult(
  matches: OrderRow[],
  matchType: LookupResult["matchType"],
  matchedKey: string,
  matchedColumn: string,
  confidence: LookupResult["confidence"]
): LookupResult | null {
  if (matches.length === 0) return null;

  const orders = groupByOrder(matches);
  if (orders.length === 1) {
    const lineItems = orders[0];
    return {
      found: true,
      matchType,
      matchedKey,
      matchedColumn,
      rowId: lineItems[0].rowId,
      confidence,
      multipleMatches: false,
      candidateCount: lineItems.length,
      row: lineItems[0],
      rows: lineItems,
    };
  }
  return {
    found: true,
    matchType,
    matchedKey,
    matchedColumn,
    confidence: "medium",
    multipleMatches: true,
    candidateCount: matches.length,
    rows: matches,
  };
}

/**
 * Priority lookup. Stops at the first hit:
 *   1. AMP Order #   (exact, high confidence)
 *   2. Customer PO # (exact, high) — also checks AMP Order # column, which
 *      holds "#PO2255"-style values for some rows
 *   3. Invoice #     (exact, high — extraction already applies context rules)
 *   4. Client/project name (contains, LOW confidence -> human review in v1)
 *   5. Sender email  (exact on ACCOUNT EMAIL, LOW confidence in v1)
 */
export function lookupOrder(
  rows: OrderRow[],
  extraction: Pick<
    ExtractionResult,
    "ampOrderNumber" | "poNumber" | "invoiceNumber" | "clientName" | "projectName"
  > &
    Partial<Pick<ExtractionResult, "senderCompany">>,
  senderEmail: string | null
): LookupResult {
  const ampCol = COLUMN_TITLES.ampOrderNumber;
  const invoiceCol = COLUMN_TITLES.invoiceNumber;
  const poCol = COLUMN_TITLES.customerPo;
  const emailCol = COLUMN_TITLES.accountEmail;
  const company = extraction.senderCompany ?? null;

  // 1. AMP Order #
  if (extraction.ampOrderNumber) {
    const r = buildResult(
      findExact(rows, ampCol, extraction.ampOrderNumber),
      "amp_order",
      extraction.ampOrderNumber,
      ampCol,
      "high"
    );
    if (r) return r;
  }

  // 2. Customer PO # — token match in the dedicated column (PO cells often
  //    carry sidemarks like "7776/showroom"), then '#PO...' values in AMP col
  if (extraction.poNumber) {
    const inPoCol = buildResult(
      filterByCompany(findPoToken(rows, poCol, extraction.poNumber), company),
      "customer_po",
      extraction.poNumber,
      poCol,
      "high"
    );
    if (inPoCol) return inPoCol;

    const inAmpCol = buildResult(
      findExact(rows, ampCol, `PO${normalizeId(extraction.poNumber)}`),
      "customer_po",
      extraction.poNumber,
      ampCol,
      "high"
    );
    if (inAmpCol) return inAmpCol;
  }

  // 3. Invoice #
  if (extraction.invoiceNumber) {
    const r = buildResult(
      findExact(rows, invoiceCol, extraction.invoiceNumber),
      "invoice",
      extraction.invoiceNumber,
      invoiceCol,
      "high"
    );
    if (r) return r;
  }

  // 4. Client / project name — contains-match across candidate text columns,
  //    INCLUDING Customer PO # (reps often put the end-client's name or a
  //    sidemark in the PO field, e.g. PO "Campe").
  const nameNeedle = (extraction.clientName ?? extraction.projectName ?? "").trim();
  if (nameNeedle.length >= 3) {
    const needle = nameNeedle.toLowerCase();
    const candidateColumns = [
      COLUMN_TITLES.customer,
      COLUMN_TITLES.customerPo,
      COLUMN_TITLES.itemName,
      COLUMN_TITLES.comMill,
      COLUMN_TITLES.comStyleName,
    ];
    const matches = rows.filter((row) =>
      candidateColumns.some((col) => {
        const v = row.cells[col];
        return v !== undefined && v.toLowerCase().includes(needle);
      })
    );
    const r = buildResult(
      filterByCompany(matches, company),
      "client_project",
      nameNeedle,
      "(multiple text columns)",
      "low"
    );
    if (r) return r;
  }

  // 5. Sender email
  if (senderEmail) {
    const matches = findExact(rows, emailCol, senderEmail);
    const r = buildResult(matches, "customer_email", senderEmail, emailCol, "low");
    if (r) return r;
  }

  // No match. Flag when we had a well-formed identifier but found nothing —
  // likely a Data Shuttle sync gap rather than a bad identifier.
  const hadStrongIdentifier = Boolean(
    (extraction.ampOrderNumber && isValidAmpOrderFormat(extraction.ampOrderNumber)) ||
      extraction.poNumber ||
      extraction.invoiceNumber
  );

  return {
    found: false,
    confidence: "none",
    multipleMatches: false,
    candidateCount: 0,
    identifierWithoutRow: hadStrongIdentifier,
  };
}

type LookupExtraction = Parameters<typeof lookupOrder>[1];

/**
 * Search ACTIVE order sheets first (MASTER, then Basics). Only when nothing
 * matches do we search the ARCHIVE sheets — matches there mean the order has
 * shipped/closed, which changes what we can safely tell the customer.
 * A sheet that fails to load is skipped (logged), never fatal.
 */
export async function lookupOrderAcrossSheets(
  extraction: LookupExtraction,
  senderEmail: string | null
): Promise<LookupResult> {
  let firstMiss: LookupResult | null = null;

  for (const group of [activeOrderSheets(), archiveOrderSheets()]) {
    const fetched = await Promise.all(
      group.map(async (ref) => {
        try {
          const { rows, sheetName } = await fetchSheetRows(ref.id);
          return { ref, rows, sheetName };
        } catch (err) {
          console.error(`Sheet ${ref.label} (${ref.id}) failed to load:`, err);
          return null;
        }
      })
    );

    for (const item of fetched) {
      if (!item) continue;
      const result = lookupOrder(item.rows, extraction, senderEmail);
      if (result.found) {
        return {
          ...result,
          fromSheet: item.sheetName,
          isArchive: item.ref.isArchive,
        };
      }
      if (!firstMiss) firstMiss = result;
    }
  }

  return (
    firstMiss ?? {
      found: false,
      confidence: "none",
      multipleMatches: false,
      candidateCount: 0,
    }
  );
}
