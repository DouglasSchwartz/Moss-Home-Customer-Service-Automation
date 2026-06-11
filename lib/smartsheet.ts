import { COLUMN_TITLES, cleanCellValue } from "./smartsheet-columns";
import type { OrderRow } from "./types";

// Env aliases: the Vercel project uses SMARTSHEET_ACCESS_TOKEN /
// SMARTSHEET_OPEN_ORDERS_SHEET_ID; .env.example documents the short names.
// Both are accepted so either naming works.
function apiBase(): string {
  return process.env.SMARTSHEET_API_BASE_URL ?? "https://api.smartsheet.com/2.0";
}

export function getSmartsheetToken(): string {
  const v = process.env.SMARTSHEET_API_TOKEN ?? process.env.SMARTSHEET_ACCESS_TOKEN;
  if (!v) {
    throw new Error(
      "Missing env var: SMARTSHEET_API_TOKEN (or SMARTSHEET_ACCESS_TOKEN)"
    );
  }
  return v;
}

export function getSmartsheetSheetId(): string {
  const v =
    process.env.SMARTSHEET_SHEET_ID ?? process.env.SMARTSHEET_OPEN_ORDERS_SHEET_ID;
  if (!v) {
    throw new Error(
      "Missing env var: SMARTSHEET_SHEET_ID (or SMARTSHEET_OPEN_ORDERS_SHEET_ID)"
    );
  }
  return v;
}

type SmartsheetColumn = { id: number; title: string };
type SmartsheetCell = { columnId: number; value?: unknown; displayValue?: string };
type SmartsheetRow = { id: number; cells: SmartsheetCell[] };
type SmartsheetSheet = {
  id: number;
  name: string;
  columns: SmartsheetColumn[];
  rows: SmartsheetRow[];
};

async function smartsheetGet<T>(path: string): Promise<T> {
  const token = getSmartsheetToken();
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    // Order data changes throughout the day; never serve stale.
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Smartsheet API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** List all sheets visible to the token (used to verify the sheet ID). */
export async function listSheets(): Promise<{ id: number; name: string }[]> {
  const data = await smartsheetGet<{ data: { id: number; name: string }[] }>(
    "/sheets?pageSize=200"
  );
  return data.data;
}

/**
 * Fetch the whole sheet and flatten rows into title->value records.
 * Prefers displayValue (what a human sees, e.g. "Early July") over raw value.
 */
export async function fetchOrderRows(): Promise<{
  sheetName: string;
  rows: OrderRow[];
  columnTitles: string[];
}> {
  const sheetId = getSmartsheetSheetId();
  const sheet = await smartsheetGet<SmartsheetSheet>(
    `/sheets/${sheetId}?exclude=nonexistentCells`
  );

  const titleById = new Map<number, string>();
  for (const col of sheet.columns) titleById.set(col.id, col.title);

  const rows: OrderRow[] = sheet.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const cell of row.cells) {
      const title = titleById.get(cell.columnId);
      if (!title) continue;
      const display = cleanCellValue(cell.displayValue ?? cell.value);
      if (display) cells[title] = display;
    }
    return { rowId: String(row.id), cells };
  });

  return {
    sheetName: sheet.name,
    rows,
    columnTitles: sheet.columns.map((c) => c.title),
  };
}

/** Convenience accessor: read a cell by our canonical column key. */
export function getCell(row: OrderRow, key: keyof typeof COLUMN_TITLES): string {
  return row.cells[COLUMN_TITLES[key]] ?? "";
}
