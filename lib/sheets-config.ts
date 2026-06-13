/**
 * Sheet roster for the multi-sheet order search and the fabric stock flow.
 *
 * IDs were verified live against the Smartsheet token on Jun 12, 2026
 * (GET /api/smartsheet/schema lists every sheet the token can see).
 * Every ID can be overridden via env without a code change.
 */

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type OrderSheetRef = {
  id: string;
  label: string;
  /** Archived orders have shipped/closed; ship-estimate language no longer applies. */
  isArchive: boolean;
};

/** Active order sheets — searched first, in order. */
export function activeOrderSheets(): OrderSheetRef[] {
  return [
    {
      id:
        process.env.SMARTSHEET_SHEET_ID ??
        process.env.SMARTSHEET_OPEN_ORDERS_SHEET_ID ??
        "6535661298706308",
      label: "MASTER: Open Orders Sheet",
      isArchive: false,
    },
    {
      id: env("SMARTSHEET_BASICS_SHEET_ID", "2663054034554756"),
      label: "Basics Master: Open Orders Sheet",
      isArchive: false,
    },
  ];
}

/** Archive sheets — searched only when active sheets have no match. */
export function archiveOrderSheets(): OrderSheetRef[] {
  const ids = envList("SMARTSHEET_ARCHIVE_SHEET_IDS", [
    "6190562341244804", // ARCHIVE: Master Open Order 2026
    "4648954697305988", // archive: basics master open order 2026
    "3786789735059332", // ARCHIVE: Master Open Order 2025
    "7824661899333508", // archive: basics master open order 2025
  ]);
  return ids.map((id) => ({ id, label: `archive:${id}`, isArchive: true }));
}

/** BarCloud Inventory Report — fabric stock on hand. */
export function barcloudSheetId(): string {
  return env("SMARTSHEET_BARCLOUD_SHEET_ID", "2099244581212036");
}

/** Fabric Master Sheet — mill contacts and lead times. */
export function fabricMasterSheetId(): string {
  return env("SMARTSHEET_FABRIC_MASTER_SHEET_ID", "7520330970359684");
}

/** Warehouse contact for dye-lot confirmation. */
export function warehouseContactEmail(): string {
  return env("FABRIC_WAREHOUSE_EMAIL", "Jose@mosshomeusa.com");
}

/** Weeks added to a mill's quoted lead time before telling the customer. */
export const LEAD_TIME_BUFFER_WEEKS = 2;
