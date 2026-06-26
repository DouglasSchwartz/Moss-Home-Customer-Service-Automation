/**
 * Yardage requirement chart (provided by Moss Home, Jun 2026).
 * Used when a customer asks about fabric stock for a furniture piece
 * without specifying how many yards they need.
 */

export const YARDAGE_CHART: { item: string; yards: number; match: RegExp }[] = [
  { item: 'Sofa 109"-120"', yards: 30, match: /sofa.*(109|110|111|112|113|114|115|116|117|118|119|120)/i },
  { item: 'Sofa 97"-108"', yards: 26, match: /sofa.*(9[7-9]|10[0-8])/i },
  { item: 'Sofa 84"-95"', yards: 24, match: /sofa.*(8[4-9]|9[0-5])/i },
  { item: 'Sofa/Loveseat 72"-83"', yards: 22, match: /(sofa|loveseat).*(7[2-9]|8[0-3])/i },
  { item: 'Sofa/Loveseat 60"-71"', yards: 20, match: /(sofa|loveseat).*(6[0-9]|7[01])/i },
  { item: "King/Cal King Bed", yards: 18, match: /(king|cal[- ]?king).*bed|bed.*(king|cal[- ]?king)/i },
  { item: "Queen/Full Bed", yards: 15, match: /(queen|full).*bed|bed.*(queen|full)/i },
  { item: "Twin Bed", yards: 12, match: /twin.*bed|bed.*twin/i },
  { item: "King/Cal King Headboard", yards: 8, match: /(king|cal[- ]?king).*headboard|headboard.*(king|cal[- ]?king)/i },
  { item: "Queen/Full Headboard", yards: 7, match: /(queen|full).*headboard|headboard.*(queen|full)/i },
  { item: "Twin Headboard", yards: 5, match: /twin.*headboard|headboard.*twin/i },
  { item: "Ottoman", yards: 8, match: /ottoman/i },
  { item: "Bench", yards: 12, match: /bench/i },
  { item: "Chaise", yards: 20, match: /chaise/i },
  { item: "Chair", yards: 12, match: /chair/i },
];

/** Generic fallbacks when the size qualifier is missing. */
const GENERIC_FALLBACKS: { match: RegExp; item: string; yards: number }[] = [
  // Largest sofa size: never under-quote yardage for an unsized sofa.
  { match: /sofa|sectional|loveseat/i, item: "Sofa (size unspecified, largest assumed)", yards: 30 },
  { match: /\bbed\b/i, item: "Bed (size unspecified, King assumed)", yards: 18 },
  { match: /headboard/i, item: "Headboard (size unspecified, King assumed)", yards: 8 },
];

export type YardageEstimate = { item: string; yards: number };

/** Map a furniture description to a yardage requirement, or null. */
export function estimateYardage(description: string): YardageEstimate | null {
  const d = (description ?? "").trim();
  if (!d) return null;
  for (const row of YARDAGE_CHART) {
    if (row.match.test(d)) return { item: row.item, yards: row.yards };
  }
  for (const row of GENERIC_FALLBACKS) {
    if (row.match.test(d)) return { item: row.item, yards: row.yards };
  }
  return null;
}
