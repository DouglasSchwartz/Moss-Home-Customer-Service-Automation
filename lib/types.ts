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
  | "fabric_stock_inquiry"
  | "internal_stock_reply"
  | "mill_stock_reply"
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
  | "acknowledgment"
  | "not_customer_service"
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

/** One fabric the customer asked about, with yardage if they gave one. */
export type FabricRequest = {
  fabric: string;
  yards: number | null;
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
  /** Fabrics the customer asked about (stock/availability questions). */
  fabricRequests: FabricRequest[];
  /** Furniture piece the fabric is for, mapped to the yardage chart. */
  furnitureItem: string | null;
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
  /** Sheet the match came from (MASTER, Basics, or an archive). */
  fromSheet?: string;
  /** True when matched on an ARCHIVE sheet — the order shipped/closed. */
  isArchive?: boolean;
  /** True when an identifier with a valid format was extracted but no row matched —
   *  signals a possible Data Shuttle sync gap, not a customer mistake. */
  identifierWithoutRow?: boolean;
};

export type ReplyMode = "auto_reply" | "draft_only" | "human_review" | "ignore";

/** A brand-new email (not a reply) the workflow must send, e.g. to the
 *  warehouse or a mill during a fabric stock inquiry. */
export type OutboundEmail = {
  to: string;
  subject: string;
  body: string;
};

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
  /** When set, the reply goes to THIS message/thread instead of the incoming
   *  one (e.g. relaying a warehouse/mill answer back to the customer). */
  replyToMessageId?: string;
  /** New email(s) to send (warehouse / mill inquiries). */
  outboundEmails?: OutboundEmail[];
  reason: string;
  askedForInfo: boolean;
  dryRun: boolean;
  error?: string;
};
