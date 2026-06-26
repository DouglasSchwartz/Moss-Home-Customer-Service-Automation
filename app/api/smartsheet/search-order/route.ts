import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "../../../../lib/auth";
import { lookupOrderAcrossSheets } from "../../../../lib/matching";
import { decideReplyMode } from "../../../../lib/safety";
import { fetchOrderRows } from "../../../../lib/smartsheet";
import type { ExtractionResult } from "../../../../lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint: run the deterministic lookup + safety gate directly,
 * without Claude. Lets us validate Smartsheet matching before email wiring.
 *
 * GET /api/smartsheet/search-order?ampOrderNumber=032725-5713
 *   ?poNumber=7776  ?invoiceNumber=30318  ?clientName=Campe  ?email=a@b.com
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams;

  // Raw substring scan across ALL columns: ?scan=7776
  const scan = q.get("scan");
  if (scan) {
    const needle = scan.toLowerCase();
    const { rows, sheetName } = await fetchOrderRows();
    const hits = rows
      .filter((row) =>
        Object.values(row.cells).some((v) => v.toLowerCase().includes(needle))
      )
      .slice(0, 20)
      .map((row) => ({
        rowId: row.rowId,
        matchingCells: Object.fromEntries(
          Object.entries(row.cells).filter(([, v]) =>
            v.toLowerCase().includes(needle)
          )
        ),
        ampOrderNumber: row.cells["AMP Order #"] ?? "",
        customer: row.cells["Customer"] ?? "",
      }));
    return NextResponse.json({ sheetName, scan, hitCount: hits.length, hits });
  }

  const extraction: ExtractionResult = {
    intent: "order_status",
    ampOrderNumber: q.get("ampOrderNumber"),
    poNumber: q.get("poNumber"),
    invoiceNumber: q.get("invoiceNumber"),
    clientName: q.get("clientName"),
    projectName: q.get("projectName"),
    customerEmail: q.get("email"),
    materialOrComReference: null,
    senderName: null,
    senderCompany: q.get("company"),
    fabricRequests: [],
    furnitureItem: null,
    secondaryQuestions: [],
    summary: "manual diagnostic lookup",
    unsafeSignals: {
      complaint: false,
      damage: false,
      returnOrRefund: false,
      cancellation: false,
      addressChange: false,
      legalOrChargeback: false,
      angryOrEscalated: false,
    },
  };

  if (
    !extraction.ampOrderNumber &&
    !extraction.poNumber &&
    !extraction.invoiceNumber &&
    !extraction.clientName &&
    !extraction.projectName &&
    !extraction.customerEmail
  ) {
    return NextResponse.json(
      {
        error:
          "Provide at least one of: ampOrderNumber, poNumber, invoiceNumber, clientName, projectName, email",
      },
      { status: 400 }
    );
  }

  try {
    // Same path production uses: MASTER + Basics first, then archives.
    const lookup = await lookupOrderAcrossSheets(extraction, extraction.customerEmail);
    const decision = decideReplyMode(extraction, lookup);

    return NextResponse.json({
      lookup: {
        found: lookup.found,
        matchType: lookup.matchType,
        matchedKey: lookup.matchedKey,
        matchedColumn: lookup.matchedColumn,
        confidence: lookup.confidence,
        multipleMatches: lookup.multipleMatches,
        candidateCount: lookup.candidateCount,
        identifierWithoutRow: lookup.identifierWithoutRow,
        fromSheet: lookup.fromSheet,
        isArchive: lookup.isArchive,
      },
      matchedRow: lookup.row ?? null,
      matchedRows: lookup.rows ?? null,
      wouldDecide: { reply_mode: decision.reply_mode, reason: decision.reason },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
