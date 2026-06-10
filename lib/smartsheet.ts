import { COLUMN_TITLES, cleanCellValue } from "./smartsheet-columns";
import type { OrderRow } from "./types";

const API_BASE = "https://api.smartsheet.com/2.0";

type SmartsheetColumn = { id: number; title: string };
type SmartsheetCell = { columnId: number; value?: unknown; displayValue?: string };
type SmartsheetRow = { id: number; cells: SmartsheetCell[] };
type SmartsheetSheet = {
  id: number;
  name: string;
  columns: SmartsheetColumn[];
  rows: SmartsheetRow[];
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function smartsheetGet<T>(path: string): Promise<T> {
  const token = requireEnv("SMARTSHEET_API_TOKEN");
  const res = await fetch(`${API_BASE}${path}`, {
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
  const sheetId = requireEnv("SMARTSHEET_SHEET_ID");
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
