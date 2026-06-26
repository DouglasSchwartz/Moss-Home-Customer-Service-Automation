/**
 * Verifies the Smartsheet connection and column mapping.
 *
 * Usage:  npm run sync-columns
 * Needs:  SMARTSHEET_API_TOKEN (and optionally SMARTSHEET_SHEET_ID) in .env
 *
 * What it does:
 *  1. Lists every sheet the token can see (so you can verify the numeric
 *     sheet ID for "MASTER: Open Orders Sheet" instead of trusting a guess).
 *  2. If SMARTSHEET_SHEET_ID is set, fetches that sheet and prints the live
 *     title -> columnId map.
 *  3. Diffs live column titles against lib/smartsheet-columns.ts and reports
 *     missing/extra columns, failing loudly if a CRITICAL column is absent.
 *  4. Prints 3 sample rows so lookup assumptions can be eyeballed.
 */
import "dotenv/config";
import {
  COLUMN_TITLES,
  CRITICAL_COLUMNS,
} from "../lib/smartsheet-columns";
import { fetchOrderRows, listSheets } from "../lib/smartsheet";

async function main() {
  if (!process.env.SMARTSHEET_API_TOKEN) {
    console.error("Set SMARTSHEET_API_TOKEN in .env first.");
    process.exit(1);
  }

  console.log("== Sheets visible to this token ==");
  const sheets = await listSheets();
  for (const s of sheets) {
    const marker = String(s.id) === process.env.SMARTSHEET_SHEET_ID ? "  <-- configured" : "";
    console.log(`  ${s.id}  ${s.name}${marker}`);
  }

  if (!process.env.SMARTSHEET_SHEET_ID) {
    console.log(
      "\nSMARTSHEET_SHEET_ID not set. Find 'MASTER: Open Orders Sheet' above and put its numeric ID in .env, then re-run."
    );
    return;
  }

  console.log("\n== Fetching configured sheet ==");
  const { sheetName, rows, columnTitles } = await fetchOrderRows();
  console.log(`Sheet: ${sheetName}  (${rows.length} rows, ${columnTitles.length} columns)`);

  console.log("\n== Live columns ==");
  for (const t of columnTitles) console.log(`  ${t}`);

  console.log("\n== Mapping check (lib/smartsheet-columns.ts) ==");
  const live = new Set(columnTitles);
  let criticalMissing = false;
  for (const [key, title] of Object.entries(COLUMN_TITLES)) {
    const present = live.has(title);
    const critical = CRITICAL_COLUMNS.includes(key as never);
    const flag = present ? "OK     " : critical ? "MISSING (CRITICAL)" : "missing (optional)";
    if (!present && critical) criticalMissing = true;
    console.log(`  ${flag}  ${key} -> "${title}"`);
  }

  console.log("\n== Sample rows (first 3 with an AMP Order #) ==");
  const samples = rows
    .filter((r) => r.cells[COLUMN_TITLES.ampOrderNumber])
    .slice(0, 3);
  for (const row of samples) {
    console.log(`  rowId ${row.rowId}:`);
    for (const [k, v] of Object.entries(row.cells).slice(0, 12)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  if (criticalMissing) {
    console.error(
      "\nFAIL: critical columns are missing. Update lib/smartsheet-columns.ts titles to match the live sheet."
    );
    process.exit(1);
  }
  console.log("\nAll critical columns resolved. Mapping is valid.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
