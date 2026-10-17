import { describe, expect, it } from "vitest";
import { parseAddressList, parseGmailMessage } from "../src/lib/ingest/parse";
import { parseEvidenceRef, evidenceHref } from "../src/lib/evidence";
import { filePart, message, textPart } from "./helpers";

describe("parseGmailMessage", () => {
  it("prefers text/plain in multipart/alternative and finds PDF + inline image", () => {
    const msg = message("m1", {
      subject: "Q4 deck feedback",
      payload: {
        partId: "",
        mimeType: "multipart/mixed",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [
          {
            partId: "0",
            mimeType: "multipart/related",
            filename: "",
            headers: [],
            body: { size: 0 },
            parts: [
              {
                partId: "0.0",
                mimeType: "multipart/alternative",
                filename: "",
                headers: [],
                body: { size: 0 },
                parts: [
                  textPart("text/plain", "Slide 4 numbers look off.\n\nOn Mon wrote:\n> hi", "0.0.0"),
                  textPart("text/html", "<p>Slide 4 numbers look <b>off</b>.</p>", "0.0.1"),
                ],
              },
              filePart("0.1", "chart.png", "image/png", 52_000, { attachmentId: "att-img", contentId: "ii_abc@mail", inline: true }),
            ],
          },
          filePart("1", "Q4 Deck.pdf", "application/pdf", 120_000, { attachmentId: "att-pdf" }),
        ],
      },
    });

    const p = parseGmailMessage(msg);
    expect(p.bodySource).toBe("text/plain");
    expect(p.bodyClean).toBe("Slide 4 numbers look off.");
    expect(p.subject).toBe("Q4 deck feedback");
    expect(p.from).toEqual({ name: "Jane Client", email: "jane@acme.com" });
    expect(p.rfcMessageId).toBe("<m1@mail.acme.com>");
    expect(p.receivedAt).toBe("2026-10-16T16:00:00.000Z");
    expect(p.sentAt).toBe("2026-10-16T16:00:00.000Z");
    expect(p.attachments.map((a) => [a.filename, a.kind, a.isInline])).toEqual([
      ["chart.png", "image", true],
      ["Q4 Deck.pdf", "pdf", false],
    ]);
  });

  it("falls back to HTML and drops Gmail's quoted block", () => {
    const html = `<div>Please confirm the <a href="https://x">kickoff</a> for Tuesday.</div>
      <div class="gmail_quote"><div>On Mon, Sam wrote:</div><blockquote>old stuff</blockquote></div>`;
    const p = parseGmailMessage(message("m2", { payload: textPart("text/html", html) }));
    expect(p.bodySource).toBe("text/html");
    expect(p.bodyClean).toBe("Please confirm the kickoff for Tuesday.");
    expect(p.bodyRaw).not.toContain("old stuff");
  });

  it("decodes non-UTF-8 charsets", () => {
    const p = parseGmailMessage(message("m3", { payload: textPart("text/plain", "Café résumé", "0", "ISO-8859-1") }));
    expect(p.bodyClean).toBe("Café résumé");
  });

  it("handles a message with no text body", () => {
    const p = parseGmailMessage(
      message("m4", { payload: filePart("", "scan.pdf", "application/pdf", 10, { data: Buffer.from("%PDF-1.4") }) }),
    );
    expect(p.bodySource).toBe("none");
    expect(p.bodyClean).toBe("");
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].inlineData?.toString()).toBe("%PDF-1.4");
  });
});

describe("parseAddressList", () => {
  it("respects quoted commas and lowercases emails", () => {
    expect(parseAddressList('"Doe, Jane" <Jane@Acme.com>, bob@y.com; Ann <ann@z.com>')).toEqual([
      { name: "Doe, Jane", email: "jane@acme.com" },
      { name: null, email: "bob@y.com" },
      { name: "Ann", email: "ann@z.com" },
    ]);
  });
});

describe("evidence refs", () => {
  it("round-trips email line ranges and attachment pages", () => {
    expect(parseEvidenceRef("email:18f3a#L4-L6")).toEqual({ type: "email", emailId: "18f3a", from: 4, to: 6 });
    expect(parseEvidenceRef("attachment:18f3a:1#p3")).toEqual({ type: "attachment", attachmentId: "18f3a:1", page: 3 });
    expect(evidenceHref("email:18f3a#L4")).toBe("/emails/18f3a#L4");
    expect(evidenceHref("attachment:18f3a:1#p3")).toBe("/api/attachments/18f3a%3A1#page=3");
    expect(parseEvidenceRef("nonsense")).toBeNull();
  });
});
