/**
 * Turn a raw email body into just the new content the sender wrote.
 *
 * Quoted history is removed because it is already stored as its own email,
 * and reasoning over it twice double-counts asks and commitments. Forwarded
 * messages are kept: when a client forwards something, that content is new
 * to this thread.
 *
 * Output lines are what evidence references point at (see evidence.ts), so
 * cleaning must be deterministic.
 */

// "On Tue, Oct 14, 2026 at 9:02 AM Jane Doe <jane@x.com> wrote:"
const ON_WROTE = /^On\s.+\bwrote:\s*$/i;
// Same marker, wrapped by the sender's client onto two lines.
const ON_START = /^On\s.+\d.*$/i;
const WROTE_END = /^.*\bwrote:\s*$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}\s*$/i;
const OUTLOOK_RULE = /^_{10,}\s*$/;
const OUTLOOK_FROM = /^\*?From:\*?\s.+/i;
const OUTLOOK_HEADER = /^\*?(Sent|Date|To|Subject|Cc):\*?\s/i;
const SIGNATURE_DELIM = /^--\s?$/;
// Gmail: "---------- Forwarded message ---------"; Apple Mail: "Begin forwarded message:"
const FORWARDED = /^(-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:)\s*$/i;
const FORWARD_HEADER = /^\*?(From|Date|Sent|Subject|To|Cc):\*?\s/i;
const MOBILE_FOOTER = /^Sent from my (iPhone|iPad|Android|Galaxy|mobile device)|^Get Outlook for (iOS|Android)/i;

export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n");
}

export function cleanBody(raw: string): string {
  const lines = normalize(raw).split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (ON_WROTE.test(trimmed)) break;
    if (ON_START.test(trimmed) && i + 1 < lines.length && WROTE_END.test(lines[i + 1].trim())) break;
    if (ORIGINAL_MESSAGE.test(trimmed)) break;
    if (OUTLOOK_RULE.test(trimmed) && looksLikeOutlookHeader(lines, i + 1)) break;
    if (OUTLOOK_FROM.test(trimmed) && looksLikeOutlookHeader(lines, i)) break;

    // A forward is new to this thread: keep its marker and header block (its
    // Date: line is what dates phrases like "next Friday" inside it).
    if (FORWARDED.test(trimmed)) {
      kept.push(line);
      while (i + 1 < lines.length && FORWARD_HEADER.test(lines[i + 1].trim())) kept.push(lines[++i]);
      continue;
    }
    // Signature: drop it, but if a forwarded message follows (signatures sit
    // above the forward in Gmail), skip ahead to the forward instead of stopping.
    if (SIGNATURE_DELIM.test(line)) {
      const fwd = lines.findIndex((l, j) => j > i && FORWARDED.test(l.trim()));
      if (fwd === -1) break;
      i = fwd - 1;
      continue;
    }

    if (trimmed.startsWith(">")) continue;
    if (MOBILE_FOOTER.test(trimmed)) continue;

    kept.push(line);
  }

  const cleaned = collapseBlankLines(kept.join("\n")).trim();
  // Never return nothing for a message that had text: a top-quoted or
  // oddly formatted email is better kept whole than dropped.
  return cleaned || collapseBlankLines(normalize(raw)).trim();
}

/** An Outlook reply header is a From: line followed closely by Sent:/Date:/To:/Subject: lines. */
function looksLikeOutlookHeader(lines: string[], start: number): boolean {
  let i = start;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !OUTLOOK_FROM.test(lines[i].trim())) return false;
  let headerLines = 0;
  for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
    if (OUTLOOK_HEADER.test(lines[j].trim())) headerLines++;
  }
  return headerLines >= 2;
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}
