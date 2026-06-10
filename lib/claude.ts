import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserMessage,
} from "../prompts/extract";
import {
  GENERATE_SYSTEM_PROMPT,
  buildGenerateUserMessage,
} from "../prompts/generate";
import type { ExtractionResult, LookupResult } from "./types";

const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "claude-haiku-4-5";
const GENERATE_MODEL = process.env.GENERATE_MODEL ?? "claude-sonnet-4-6";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("Missing required env var: ANTHROPIC_API_KEY");
    }
    _client = new Anthropic();
  }
  return _client;
}

const intentSchema = z.enum([
  "order_status",
  "tracking_status",
  "estimated_completion",
  "com_received_status",
  "fabric_status",
  "po_status",
  "invoice_status",
  "client_project_lookup",
  "quote_request",
  "yardage_request",
  "return_or_refund",
  "cancellation",
  "damage_or_complaint",
  "address_change",
  "new_account",
  "general_customer_service",
  "spam_or_unrelated",
  "unclear",
]);

const extractionSchema = z.object({
  intent: intentSchema,
  ampOrderNumber: z.string().nullable(),
  poNumber: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  clientName: z.string().nullable(),
  projectName: z.string().nullable(),
  customerEmail: z.string().nullable(),
  materialOrComReference: z.string().nullable(),
  secondaryQuestions: z.array(z.string()).default([]),
  summary: z.string().default(""),
  unsafeSignals: z.object({
    complaint: z.boolean(),
    damage: z.boolean(),
    returnOrRefund: z.boolean(),
    cancellation: z.boolean(),
    addressChange: z.boolean(),
    legalOrChargeback: z.boolean(),
    angryOrEscalated: z.boolean(),
  }),
});

function parseJson(text: string): unknown {
  // Strip accidental markdown fences before parsing.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

/**
 * Extraction call. Validates against the Zod schema; retries once with the
 * validation error appended. Throws after the second failure (the pipeline
 * converts that into human_review).
 */
export async function extract(input: {
  from: string;
  subject: string;
  body: string;
  isForwarded: boolean;
}): Promise<ExtractionResult> {
  const userMessage = buildExtractUserMessage(input);

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client().messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 1024,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            attempt === 0
              ? userMessage
              : `${userMessage}\n\nYour previous response failed validation: ${lastError}\nReturn ONLY valid JSON matching the required shape.`,
        },
      ],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      const parsed = extractionSchema.parse(parseJson(text));
      return parsed as ExtractionResult;
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }
  }
  throw new Error(`Extraction failed validation after retry: ${lastError}`);
}

const FORBIDDEN_REPLY_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /scheduled to ship/i, label: 'forbidden phrase "scheduled to ship"' },
  { re: /\u2014/, label: "em dash" },
  { re: /est\.?\s*ship\s*week/i, label: 'internal column "Est Ship Week"' },
  { re: /smartsheet|amptab/i, label: "internal system name" },
];

/** Deterministic post-generation lint. Returns a violation label or null. */
export function lintReply(reply: string): string | null {
  for (const { re, label } of FORBIDDEN_REPLY_PATTERNS) {
    if (re.test(reply)) return label;
  }
  return null;
}

/**
 * Reply generation. Lints the output for forbidden wording; retries once,
 * then throws (pipeline converts to human_review — we never send a reply
 * that failed the lint).
 */
export async function generate(input: {
  fromName: string | null;
  subject: string;
  body: string;
  extraction: ExtractionResult;
  lookup: LookupResult;
  useShippedLanguage: boolean;
}): Promise<string> {
  const userMessage = buildGenerateUserMessage(input);

  let lastViolation = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client().messages.create({
      model: GENERATE_MODEL,
      max_tokens: 1024,
      system: GENERATE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            attempt === 0
              ? userMessage
              : `${userMessage}\n\nYour previous reply contained ${lastViolation}. Rewrite without it.`,
        },
      ],
    });

    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const violation = lintReply(reply);
    if (!violation) return reply;
    lastViolation = violation;
  }
  throw new Error(`Generated reply failed lint after retry: ${lastViolation}`);
}
