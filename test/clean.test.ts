import { describe, expect, it } from "vitest";
import { cleanBody } from "../src/lib/ingest/clean";

describe("cleanBody", () => {
  it("drops Gmail-style quoted history", () => {
    const raw = [
      "Hi team,",
      "",
      "Can we move the launch to Nov 3?",
      "",
      "On Thu, Oct 15, 2026 at 4:12 PM Sam Ops <sam@agency.com> wrote:",
      "> Launch is set for Oct 28.",
      "> Thanks",
    ].join("\r\n");
    expect(cleanBody(raw)).toBe("Hi team,\n\nCan we move the launch to Nov 3?");
  });

  it("handles the On…wrote: marker wrapped across two lines", () => {
    const raw = "Approved.\n\nOn Thu, Oct 15, 2026 at 4:12 PM Sam Ops <sam@agency.com>\nwrote:\n> old";
    expect(cleanBody(raw)).toBe("Approved.");
  });

  it("drops Outlook reply headers and everything below", () => {
    const raw = [
      "Budget is capped at $40k.",
      "",
      "________________________________",
      "From: Sam Ops <sam@agency.com>",
      "Sent: Thursday, October 15, 2026 4:12 PM",
      "To: Jane <jane@acme.com>",
      "Subject: Re: Scope",
      "",
      "Earlier message",
    ].join("\n");
    expect(cleanBody(raw)).toBe("Budget is capped at $40k.");
  });

  it("cuts the signature and mobile footer", () => {
    const raw = "See attached invoice.\n\nSent from my iPhone\n-- \nJane Client\nVP Marketing";
    expect(cleanBody(raw)).toBe("See attached invoice.");
  });

  it("keeps forwarded content, which is new to this thread", () => {
    const raw = "FYI below.\n\n---------- Forwarded message ---------\nFrom: Legal <legal@acme.com>\nPlease sign by Friday.";
    expect(cleanBody(raw)).toContain("Please sign by Friday.");
  });

  it("falls back to the full text when everything would be stripped", () => {
    const raw = "> only quoted text\n> nothing new";
    expect(cleanBody(raw)).toBe("> only quoted text\n> nothing new");
  });

  it("does not treat an ordinary From: line as a reply header", () => {
    const raw = "From: the brief, we need three variants.\nThanks";
    expect(cleanBody(raw)).toBe(raw);
  });
});

describe("cleanBody with forwards", () => {
  it("keeps a forwarded message (and its headers) that sits below the signature", () => {
    const raw = [
      "Flagging this note from Raj.",
      "",
      "Tom",
      "--",
      "Tom Becker",
      "Fleet Manager",
      "",
      "---------- Forwarded message ---------",
      "From: Raj Patel <raj@vectorfreight.io>",
      "Date: Thu, Sep 24, 2026 at 9:00 AM",
      "Subject: Pilot go-live",
      "To: Tom Becker <tom@vectorfreight.io>",
      "",
      "We're good to launch the pilot next Friday.",
    ].join("\n");
    const out = cleanBody(raw);
    expect(out).toContain("Flagging this note from Raj.");
    expect(out).not.toContain("Fleet Manager");
    expect(out).toContain("Date: Thu, Sep 24, 2026 at 9:00 AM");
    expect(out).toContain("We're good to launch the pilot next Friday.");
  });

  it("still cuts a signature when no forward follows", () => {
    expect(cleanBody("Thanks!\n--\nJane\nVP")).toBe("Thanks!");
  });
});
