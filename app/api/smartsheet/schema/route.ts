import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "../../../../lib/auth";
import {
  COLUMN_TITLES,
  CRITICAL_COLUMNS,
} from "../../../../lib/smartsheet-columns";
import { fetchOrderRows, listSheets } from "../../../../lib/smartsheet";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint: verifies the Smartsheet token + sheet ID and reports
 * how the live columns map against lib/smartsheet-columns.ts.
 * No Claude/Supabase needed — usable before the Anthropic key exists.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const sheets = await listSheets();

    let sheetReport: unknown = null;
    try {
      const { sheetName, rows, columnTitles } = await fetchOrderRows();
      const live = new Set(columnTitles);
      const mapping = Object.entries(COLUMN_TITLES).map(([key, title]) => ({
        key,
        title,
        present: live.has(title),
        critical: CRITICAL_COLUMNS.includes(key as never),
      }));
      sheetReport = {
        sheetName,
        rowCount: rows.length,
        columnTitles,
        mapping,
        criticalMissing: mapping
          .filter((m) => m.critical && !m.present)
          .map((m) => m.title),
      };
    } catch (err) {
      sheetReport = {
        error: `Configured sheet could not be fetched: ${
          err instanceof Error ? err.message : err
        }`,
      };
    }

    return NextResponse.json({
      sheetsVisibleToToken: sheets,
      configuredSheet: sheetReport,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
