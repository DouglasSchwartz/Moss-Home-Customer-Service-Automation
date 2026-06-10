/**
 * Column-title constants for the "MASTER: Open Orders Sheet".
 *
 * IMPORTANT: This file references columns by TITLE, and the lookup layer
 * resolves titles -> columnIds at runtime from the live sheet. Hardcoded
 * cell/column IDs are exactly what broke the old Zapier build, so we never
 * store raw IDs in code. Run `npm run sync-columns` to print the live
 * title -> columnId map, verify the sheet ID, and flag missing columns.
 *
 * Titles below were confirmed from Douglas's screenshots of the live sheet
 * (Jun 2026). The sync script reports any drift.
 */

export const COLUMN_TITLES = {
  ampOrderNumber: "AMP Order #",
  invoiceNumber: "Invoice #",
  customerPo: "Customer PO #",
  accountEmail: "ACCOUNT EMAIL",
  customer: "Customer",
  territoryMgr: "Territory Mgr",
  tmEmail: "TM Email",
  sku: "SKU",
  itemName: "Item Name",
  mossFabric: "Moss Fabric",
  orderStatus: "Order Status",
  /** Customer-facing completion estimate (e.g. "Early July"). ALWAYS use this. */
  estimatedShipping: "Estimated Shipping",
  /** Internal raw date column. NEVER surface in customer replies. */
  estShipWeek: "Est Ship Week",
  shippingDeadline: "Shipping Deadline",
  origEstShipDate: "Orig Est Ship Date",
  upholsteryCompleteDate: "Upholstery Complete Date",
  comMill: "COM MILL",
  comStyleName: "COM STYLE NAME/#",
  fabricLocation: "Fabric Location",
  orderDate: "Order Date",
  qty: "Qty",
  // Tracking columns were not visible in screenshots; the lookup layer treats
  // them as optional and the sync script reports whether they exist.
  tracking: "Tracking",
  trackingNumber: "Tracking #",
  shippedDate: "Shipped Date",
} as const;

export type ColumnKey = keyof typeof COLUMN_TITLES;

/** Columns the v1 pipeline cannot run without. */
export const CRITICAL_COLUMNS: ColumnKey[] = [
  "ampOrderNumber",
  "invoiceNumber",
  "accountEmail",
  "orderStatus",
  "estimatedShipping",
];

/** Smartsheet formula errors and junk we must treat as "no value". */
export const INVALID_CELL_VALUES = new Set([
  "#INVALID DATA TYPE",
  "#INVALID OPERATION",
  "#INVALID COLUMN VALUE",
  "#INVALID REF",
  "#REF",
  "#NO MATCH",
  "#DIVIDE BY ZERO",
  "#CIRCULAR REFERENCE",
  "#BLOCKED",
  "#CALCULATING...",
]);

export function cleanCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  if (INVALID_CELL_VALUES.has(s.toUpperCase())) return "";
  return s;
}
