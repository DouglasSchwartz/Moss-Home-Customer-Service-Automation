import { COLUMN_TITLES } from "./smartsheet-columns";
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

function buildResult(
  matches: OrderRow[],
  matchType: LookupResult["matchType"],
  matchedKey: string,
  matchedColumn: string,
  confidence: LookupResult["confidence"]
): LookupResult | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return {
      found: true,
      matchType,
      matchedKey,
      matchedColumn,
      rowId: matches[0].rowId,
      confidence,
      multipleMatches: false,
      candidateCount: 1,
      row: matches[0],
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
  >,
  senderEmail: string | null
): LookupResult {
  const ampCol = COLUMN_TITLES.ampOrderNumber;
  const invoiceCol = COLUMN_TITLES.invoiceNumber;
  const poCol = COLUMN_TITLES.customerPo;
  const emailCol = COLUMN_TITLES.accountEmail;

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

  // 2. Customer PO # — dedicated column first, then '#PO...' values in AMP col
  if (extraction.poNumber) {
    const inPoCol = buildResult(
      findExact(rows, poCol, extraction.poNumber),
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

  // 4. Client / project name — contains-match across candidate text columns.
  //    LOW confidence by design: v1 routes these to human review. The Zapier
  //    "Campe" lesson: project names may live in unexpected columns.
  const nameNeedle = (extraction.clientName ?? extraction.projectName ?? "").trim();
  if (nameNeedle.length >= 3) {
    const needle = nameNeedle.toLowerCase();
    const candidateColumns = [
      COLUMN_TITLES.customer,
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
    const r = buildResult(matches, "client_project", nameNeedle, "(multiple text columns)", "low");
    if (r) return { ...r, confidence: r.multipleMatches ? "low" : "low" };
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
