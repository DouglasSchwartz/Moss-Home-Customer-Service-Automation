/**
 * Normalizes raw email text before extraction.
 *
 * Most Moss CS emails are FORWARDS from internal staff (Jacq, reps), so the
 * customer's actual question is embedded below forwarded-message markers.
 * We keep the full text (identifiers often appear in quoted sections) but
 * strip noise that confuses extraction: long signatures, legal/tariff
 * disclaimers, and excessive quoting artifacts.
 */

const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}$/im,
  /^Begin forwarded message:$/im,
];

const SIGNATURE_NOISE = [
  // Common boilerplate that adds tokens but no signal
  /notice on tariffs[\s\S]{0,800}/i,
  /this e-?mail (and any attachments )?(is|are) confidential[\s\S]{0,600}/i,
  /scanned by gmail/i,
];

/** Markers that begin quoted/previous-message content in replies. */
const REPLY_QUOTE_MARKERS = [
  /^On .{5,120} wrote:\s*$/m,
  /^On .{5,120} wrote:/m,
  /^-{2,}\s*Original Message\s*-{2,}$/im,
];

/** Signature line the automation signs every outbound reply with. */
export const OWN_REPLY_SIGNATURE = /Moss Home Customer Service/i;

export type CleanedEmail = {
  text: string;
  isForwarded: boolean;
  /** Email address of the original sender inside the forward, if detectable. */
  embeddedSender: string | null;
  /** Text the sender actually wrote ABOVE any forward/quote markers. */
  newContent: string;
  /** True when one of OUR previous replies is embedded in this email. */
  containsOwnReply: boolean;
};

export function cleanEmailBody(raw: string): CleanedEmail {
  let text = (raw ?? "").replace(/\r\n/g, "\n");

  const isForwarded =
    FORWARD_MARKERS.some((re) => re.test(text)) || /^\s*fwd:/i.test(text);

  const containsOwnReply = OWN_REPLY_SIGNATURE.test(text);

  // Text above the first forward/quote marker = what the sender newly wrote.
  let newContent = text;
  for (const re of [...FORWARD_MARKERS, ...REPLY_QUOTE_MARKERS]) {
    const m = newContent.match(re);
    if (m && m.index !== undefined) newContent = newContent.slice(0, m.index);
  }
  newContent = newContent
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .trim();

  // Try to find the original sender inside a forwarded block:
  // "From: Marie Richards <marie@cocoon-atx.com>"
  let embeddedSender: string | null = null;
  const fromMatch = text.match(/^From:\s*.*?<([^>\s]+@[^>\s]+)>/im);
  if (fromMatch) embeddedSender = fromMatch[1].toLowerCase();

  for (const re of SIGNATURE_NOISE) text = text.replace(re, " ");

  // Collapse whitespace; cap length to keep model calls cheap and focused.
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > 8000) text = text.slice(0, 8000);

  return { text, isForwarded, embeddedSender, newContent, containsOwnReply };
}

/** Senders the automation must never reply to (self-protection). */
const SKIP_SENDER_PATTERNS = [
  /no-?reply@/i,
  /donotreply@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /@google\.com$/i,
  /@docs\.google\.com$/i,
  /notifications?@/i,
];

export function isSkippableSender(from: string): boolean {
  const email = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return SKIP_SENDER_PATTERNS.some((re) => re.test(email));
}

export function extractEmailAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

/**
 * Append the original message as a quoted block, Gmail-reply style, so the
 * customer sees the conversation history inside our reply. The n8n Gmail
 * "reply" operation threads the message but does NOT quote the original, so we
 * build the quote here.
 */
export function quoteOriginalMessage(
  replyText: string,
  original: { from?: string; date?: string; body?: string }
): string {
  const body = (original.body ?? "").replace(/\r\n/g, "\n").trimEnd();
  if (!body) return replyText;

  // Keep the quote reasonable — long threads don't need to be re-quoted in full.
  const capped = body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body;

  const who = (original.from ?? "").trim() || "the sender";
  const attribution = original.date
    ? `On ${original.date}, ${who} wrote:`
    : `${who} wrote:`;
  const quoted = capped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `${replyText.trimEnd()}\n\n${attribution}\n${quoted}`;
}
