import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "moss-cs-automation",
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
    timestamp: new Date().toISOString(),
  });
}
