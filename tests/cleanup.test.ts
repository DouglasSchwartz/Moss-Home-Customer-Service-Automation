import { describe, expect, it } from "vitest";
import {
  cleanEmailBody,
  extractEmailAddress,
  isSkippableSender,
  quoteOriginalMessage,
} from "../lib/email-cleanup";
import { lintReply } from "../lib/claude";
import { EMAIL_FORWARDED_WISMO } from "./fixtures/emails";

describe("cleanEmailBody", () => {
  it("detects forwarded emails and extracts the embedded sender", () => {
    const c = cleanEmailBody(EMAIL_FORWARDED_WISMO.textBody);
    expect(c.isForwarded).toBe(true);
    expect(c.embeddedSender).toBe("marie@cocoon-atx.com");
    expect(c.text).toContain("032725-5713");
  });

  it("strips tariff/disclaimer noise", () => {
    const c = cleanEmailBody(
      "Where is my order 032725-5713?\n\nNotice on tariffs: quotes may be updated by vendors at any time due to changing tariff rates and surcharges."
    );
    expect(c.text).not.toMatch(/tariff/i);
    expect(c.text).toContain("032725-5713");
  });

  it("flags a forward of OUR OWN reply with no new content", () => {
    const c = cleanEmailBody(
      "---------- Forwarded message ----------\nFrom: Douglas <douglas@mosshomeusa.com>\n\nHi Marie,\n\nYour order is estimated for completion in Early July.\n\nBest,\nMoss Home Customer Service"
    );
    expect(c.containsOwnReply).toBe(true);
    expect(c.newContent).toBe("");
  });

  it("keeps a customer's reply that quotes our message but adds new info", () => {
    const c = cleanEmailBody(
      "The order number is 032725-5713, thanks!\n\nOn Thu, Jun 12, 2026 at 9:07 AM Douglas wrote:\n> Could you please reply with the order number?\n> Best,\n> Moss Home Customer Service"
    );
    expect(c.containsOwnReply).toBe(true);
    expect(c.newContent).toContain("032725-5713");
  });
});

describe("isSkippableSender", () => {
  it("skips no-reply and notification senders", () => {
    expect(isSkippableSender("no-reply@accounts.google.com")).toBe(true);
    expect(isSkippableSender("Mailer Daemon <mailer-daemon@googlemail.com>")).toBe(true);
    expect(isSkippableSender("notifications@github.com")).toBe(true);
  });
  it("keeps real customers", () => {
    expect(isSkippableSender("Marie Richards <marie@cocoon-atx.com>")).toBe(false);
    expect(isSkippableSender("jacq@mosshomeusa.com")).toBe(false);
  });
});

describe("extractEmailAddress", () => {
  it("pulls the address out of a display-name header", () => {
    expect(extractEmailAddress("Jacq Nguyen <jacq@mosshomeusa.com>")).toBe(
      "jacq@mosshomeusa.com"
    );
    expect(extractEmailAddress("plain@example.com")).toBe("plain@example.com");
  });
});

describe("quoteOriginalMessage — thread inclusion", () => {
  it("appends the original message as a Gmail-style quote with attribution", () => {
    const out = quoteOriginalMessage("Thanks for reaching out!", {
      from: "Marie <marie@cocoon-atx.com>",
      date: "Wed, 18 Jun 2026 09:00:00 -0700",
      body: "Hi,\nWhat's the status of order 032725-5713?",
    });
    expect(out).toContain("Thanks for reaching out!");
    expect(out).toContain(
      "On Wed, 18 Jun 2026 09:00:00 -0700, Marie <marie@cocoon-atx.com> wrote:"
    );
    expect(out).toContain("> Hi,");
    expect(out).toContain("> What's the status of order 032725-5713?");
  });

  it("falls back to a dateless attribution", () => {
    const out = quoteOriginalMessage("Reply body", {
      from: "Bob <bob@x.com>",
      body: "original",
    });
    expect(out).toContain("Bob <bob@x.com> wrote:");
    expect(out).toContain("> original");
  });

  it("returns the reply unchanged when there is no original body", () => {
    expect(quoteOriginalMessage("Just the reply", { from: "x", body: "" })).toBe(
      "Just the reply"
    );
  });
});

describe("lintReply — forbidden wording", () => {
  it("rejects 'scheduled to ship'", () => {
    expect(lintReply("Your order is scheduled to ship on July 10th.")).toMatch(
      /scheduled to ship/
    );
  });
  it("rejects em dashes", () => {
    expect(lintReply("Great news \u2014 your order is on the way.")).toBe("em dash");
  });
  it("rejects internal column/system names", () => {
    expect(lintReply("Per Est Ship Week your order ships soon.")).toMatch(/Est Ship Week/i);
    expect(lintReply("I checked Smartsheet for you.")).toMatch(/internal system/);
  });
  it("accepts the approved phrasing", () => {
    expect(
      lintReply(
        "Your order is currently estimated for completion in Early July. Best,\nMoss Home Customer Service"
      )
    ).toBeNull();
  });
});
