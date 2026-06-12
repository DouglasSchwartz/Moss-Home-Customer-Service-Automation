// Shared contracts for the Moss Home CS automation pipeline.

export type ProcessEmailRequest = {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  date?: string;
  labels?: string[];
};

export type Intent =
  | "order_status"
  | "tracking_status"
  | "estimated_completion"
  | "com_received_status"
  | "fabric_status"
  | "po_status"
  | "invoice_status"
  | "client_project_lookup"
  | "quote_request"
  | "yardage_request"
  | "return_or_refund"
  | "cancellation"
  | "damage_or_complaint"
  | "address_change"
  | "new_account"
  | "general_customer_service"
  | "spam_or_unrelated"
  | "unclear";

export type UnsafeSignals = {
  complaint: boolean;
  damage: boolean;
  returnOrRefund: boolean;
  cancellation: boolean;
  addressChange: boolean;
  legalOrChargeback: boolean;
  angryOrEscalated: boolean;
};

export type ExtractionResult = {
  intent: Intent;
  ampOrderNumber: string | null;
  poNumber: string | null;
  invoiceNumber: string | null;
  clientName: string | null;
  projectName: string | null;
  customerEmail: string | null;
  materialOrComReference: string | null;
  /** Person's name from the ORIGINAL author's signature (for greeting). */
  senderName: string | null;
  /** Company from the signature — used to disambiguate Smartsheet matches. */
  senderCompany: string | null;
  secondaryQuestions: string[];
  summary: string;
  unsafeSignals: UnsafeSignals;
};

export type MatchType =
  | "amp_order"
  | "customer_po"
  | "invoice"
  | "client_project"
  | "customer_email";

export type MatchConfidence = "high" | "medium" | "low" | "none";

/** A Smartsheet row flattened into title->value pairs. */
export type OrderRow = {
  rowId: string;
  cells: Record<string, string>;
};

export type LookupResult = {
  found: boolean;
  matchType?: MatchType;
  matchedKey?: string;
  matchedColumn?: string;
  rowId?: string;
  confidence: MatchConfidence;
  multipleMatches: boolean;
  candidateCount?: number;
  row?: OrderRow;
  rows?: OrderRow[];
  /** True when an identifier with a valid format was extracted but no row matched —
   *  signals a possible Data Shuttle sync gap, not a customer mistake. */
  identifierWithoutRow?: boolean;
};

export type ReplyMode = "auto_reply" | "draft_only" | "human_review" | "ignore";

export type ProcessEmailResponse = {
  messageId: string;
  threadId: string;
  reply_mode: ReplyMode;
  intent: Intent | "unknown";
  extracted: Partial<ExtractionResult> | null;
  match: {
    found: boolean;
    matchType?: MatchType;
    matchedKey?: string;
    matchedColumn?: string;
    rowId?: string;
    confidence: MatchConfidence;
    multipleMatches: boolean;
    candidateCount?: number;
  };
  reply?: string;
  reason: string;
  askedForInfo: boolean;
  dryRun: boolean;
  error?: string;
};
