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

// ---------------------------------------------------------------------------
// Provider selection: Anthropic if ANTHROPIC_API_KEY is set, otherwise OpenAI
// if OPENAI_API_KEY is set. Anthropic wins when both exist.
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai";

function provider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new Error(
    "Missing AI credentials: set ANTHROPIC_API_KEY or OPENAI_API_KEY"
  );
}

const DEFAULT_MODELS: Record<Provider, { extract: string; generate: string }> =
  {
    anthropic: { extract: "claude-haiku-4-5", generate: "claude-sonnet-4-6" },
    openai: { extract: "gpt-5.4-mini", generate: "gpt-5.5" },
  };

function modelFor(task: "extract" | "generate"): string {
  const override =
    task === "extract" ? process.env.EXTRACT_MODEL : process.env.GENERATE_MODEL;
  return override ?? DEFAULT_MODELS[provider()][task];
}

let _anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

async function callAnthropic(input: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const res = await anthropicClient().messages.create({
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: "user", content: input.user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function callOpenAI(input: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: input.model,
      // GPT-5 family: reasoning tokens count against the completion budget,
      // so give headroom beyond maxTokens and keep reasoning effort low.
      max_completion_tokens: Math.max(input.maxTokens * 4, 4096),
      reasoning_effort: "low",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

async function callModel(input: {
  task: "extract" | "generate";
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const args = {
    model: modelFor(input.task),
    system: input.system,
    user: input.user,
    maxTokens: input.maxTokens,
  };
  return provider() === "anthropic" ? callAnthropic(args) : callOpenAI(args);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const intentSchema = z.enum([
  "order_status",
  "tracking_status",
  "estimated_completion",
  "com_received_status",
  "fabric_status",
  "fabric_stock_inquiry",
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
  "acknowledgment",
  "not_customer_service",
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
  senderName: z.string().nullable().default(null),
  senderCompany: z.string().nullable().default(null),
  fabricRequests: z
    .array(z.object({ fabric: z.string(), yards: z.number().nullable() }))
    .default([]),
  furnitureItem: z.string().nullable().default(null),
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
    const text = await callModel({
      task: "extract",
      system: EXTRACT_SYSTEM_PROMPT,
      maxTokens: 1024,
      user:
        attempt === 0
          ? userMessage
          : `${userMessage}\n\nYour previous response failed validation: ${lastError}\nReturn ONLY valid JSON matching the required shape.`,
    });

    try {
      const parsed = extractionSchema.parse(parseJson(text));
      return parsed as ExtractionResult;
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }
  }
  throw new Error(`Extraction failed validation after retry: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Warehouse / mill stock-reply classification
// ---------------------------------------------------------------------------

const stockReplySchema = z.object({
  answer: z.enum(["yes", "no", "unclear"]),
  leadTimeWeeks: z.number().nullable().default(null),
  leadTimeText: z.string().nullable().default(null),
  notes: z.string().default(""),
});

export type StockReplyClassification = z.infer<typeof stockReplySchema>;

const STOCK_REPLY_SYSTEM = `You classify a short email reply about fabric stock availability. The reply answers the question "do you have X yards of this fabric in stock?".

Return ONLY JSON:
{
  "answer": "yes" | "no" | "unclear",
  "leadTimeWeeks": number | null,   // if a lead time is stated, convert to weeks (e.g. "3-4 weeks" -> 4, "30 days" -> 5). Round UP.
  "leadTimeText": string | null,    // the lead time exactly as written, if any
  "notes": "one short sentence of anything else important"
}

"yes" = they confirm the yardage is available / in stock.
"no" = not available, insufficient, or backordered.
"unclear" = anything ambiguous, partial, or conditional.`;

export async function classifyStockReply(
  replyText: string
): Promise<StockReplyClassification> {
  const text = await callModel({
    task: "extract",
    system: STOCK_REPLY_SYSTEM,
    maxTokens: 512,
    user: `REPLY EMAIL:\n${replyText.slice(0, 4000)}`,
  });
  return stockReplySchema.parse(parseJson(text));
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
  askForInfo?: boolean;
  comMode?: boolean;
}): Promise<string> {
  const userMessage = buildGenerateUserMessage(input);

  let lastViolation = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = (
      await callModel({
        task: "generate",
        system: GENERATE_SYSTEM_PROMPT,
        maxTokens: 1024,
        user:
          attempt === 0
            ? userMessage
            : `${userMessage}\n\nYour previous reply contained ${lastViolation}. Rewrite without it.`,
      })
    ).trim();

    const violation = lintReply(reply);
    if (!violation) return reply;
    lastViolation = violation;
  }
  throw new Error(`Generated reply failed lint after retry: ${lastViolation}`);
}
