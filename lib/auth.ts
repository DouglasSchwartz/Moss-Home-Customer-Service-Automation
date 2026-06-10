import { NextRequest } from "next/server";

/** Bearer-token check against PROCESS_API_SECRET. Constant-time-ish compare. */
export function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.PROCESS_API_SECRET;
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.length !== secret.length) return false;

  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) {
    mismatch |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return mismatch === 0;
}
