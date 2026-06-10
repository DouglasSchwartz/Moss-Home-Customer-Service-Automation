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

export type CleanedEmail = {
  text: string;
  isForwarded: boolean;
  /** Email address of the original sender inside the forward, if detectable. */
  embeddedSender: string | null;
};

export function cleanEmailBody(raw: string): CleanedEmail {
  let text = (raw ?? "").replace(/\r\n/g, "\n");

  const isForwarded =
    FORWARD_MARKERS.some((re) => re.test(text)) || /^\s*fwd:/i.test(text);

  // Try to find the original sender inside a forwarded block:
  // "From: Marie Richards <marie@cocoon-atx.com>"
  let embeddedSender: string | null = null;
  const fromMatch = text.match(/^From:\s*.*?<([^>\s]+@[^>\s]+)>/im);
  if (fromMatch) embeddedSender = fromMatch[1].toLowerCase();

  for (const re of SIGNATURE_NOISE) text = text.replace(re, " ");

  // Collapse whitespace; cap length to keep model calls cheap and focused.
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > 8000) text = text.slice(0, 8000);

  return { text, isForwarded, embeddedSender };
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
