import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "../../../../lib/auth";
import { findMillContact, searchBarcloud } from "../../../../lib/fabric";
import { estimateYardage } from "../../../../lib/yardage";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint for the fabric stock flow.
 *   ?fabric=Bebe+Anthracite&yards=20
 *   ?fabric=Bebe+Anthracite&item=queen+bed   (yardage from the chart)
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const q = req.nextUrl.searchParams;
  const fabric = q.get("fabric");
  if (!fabric) {
    return NextResponse.json(
      { error: "fabric query param required" },
      { status: 400 }
    );
  }

  const item = q.get("item");
  const yardsParam = q.get("yards");
  const yards = yardsParam
    ? parseFloat(yardsParam)
    : item
      ? (estimateYardage(item)?.yards ?? null)
      : null;

  try {
    const [barcloud, mill] = await Promise.all([
      searchBarcloud(fabric, yards ?? 1),
      findMillContact(fabric),
    ]);
    return NextResponse.json({
      fabric,
      yardsRequested: yards,
      yardageChartItem: item ? estimateYardage(item) : null,
      barcloud,
      millContact: mill,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
