/**
 * Extract (PRD F2, P0): turn PDF and image attachments into text the rest of
 * the pipeline can read and cite.
 *
 *   PDF   -> sent to Claude as a document; text kept per page, so evidence can
 *            point at "attachment:<id>#p2" and the evidence checker can verify
 *            quotes against that page (meta_json.pageText).
 *   Image -> Claude vision: what the image shows, plus any text in it.
 *
 * Messages move ingested -> extracted. A failed attachment is marked failed
 * with its error and does not hold the message back: the email text still
 * goes through.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { audit, type DB } from "../db";
import { DEFAULT_MODELS, type Llm } from "./llm";

export interface PdfExtraction {
  pages: string[];
  summary: string;
}
export interface ImageExtraction {
  description: string;
  text: string;
}

export interface Extractor {
  model: string;
  pdf(data: Buffer, filename: string): Promise<PdfExtraction>;
  image(data: Buffer, mediaType: string, filename: string): Promise<ImageExtraction>;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function claudeExtractor(llm: Llm, model = DEFAULT_MODELS.extract): Extractor {
  return {
    model,
    async pdf(data, filename) {
      const { input } = await llm.call<{ pages: { page: number; text: string }[]; summary: string }>({
        model,
        hint: "extract-pdf",
        maxTokens: 8000,
        system:
          "You transcribe documents for an evidence system. Copy each page's text verbatim, in reading order, " +
          "including headings, table cells, labels on drawings and handwritten or red-pen annotations. " +
          "Do not paraphrase, summarize or correct anything in the page text. Then write a short neutral summary.",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: filename },
          { type: "text", text: `Transcribe every page of ${filename}.` },
        ],
        tool: {
          name: "record_pdf",
          description: "Record the verbatim text of every page and a short summary.",
          input_schema: {
            type: "object",
            properties: {
              pages: {
                type: "array",
                description: "One entry per page, in order.",
                items: {
                  type: "object",
                  properties: { page: { type: "integer", minimum: 1 }, text: { type: "string" } },
                  required: ["page", "text"],
                },
              },
              summary: { type: "string", description: "2-3 sentences: what the document is and its key facts." },
            },
            required: ["pages", "summary"],
          },
        },
      });
      const pages = [...input.pages].sort((a, b) => a.page - b.page).map((p) => p.text);
      return { pages, summary: input.summary };
    },
    async image(data, mediaType, filename) {
      const media = IMAGE_TYPES.has(mediaType) ? mediaType : "image/png";
      const { input } = await llm.call<ImageExtraction>({
        model,
        hint: "extract-image",
        maxTokens: 2000,
        system:
          "You describe images attached to client emails for an evidence system. Describe what the image shows " +
          "factually (app screen, photo, drawing, chart) and transcribe all visible text verbatim, including " +
          "error messages, numbers, labels and handwritten notes. Do not guess at what is not visible.",
        content: [
          { type: "image", source: { type: "base64", media_type: media as "image/png", data: data.toString("base64") } },
          { type: "text", text: `Describe ${filename} and transcribe its text.` },
        ],
        tool: {
          name: "record_image",
          description: "Record a factual description and the verbatim visible text.",
          input_schema: {
            type: "object",
            properties: {
              description: { type: "string", description: "What the image shows, 2-4 sentences." },
              text: { type: "string", description: "All visible text, verbatim, one item per line. Empty if none." },
            },
            required: ["description", "text"],
          },
        },
      });
      return input;
    },
  };
}

export interface ExtractResult {
  messages: number;
  attachments: number;
  failed: { attachment: string; error: string }[];
}

interface AttachmentRow {
  id: string;
  filename: string;
  mime_type: string;
  kind: string;
  storage_path: string;
}

export async function runExtract(
  db: DB,
  extractor: Extractor,
  opts: { dataDir?: string; limit?: number } = {},
): Promise<ExtractResult> {
  const dataDir = opts.dataDir ?? config.dataDir;
  const result: ExtractResult = { messages: 0, attachments: 0, failed: [] };
  const messages = db
    .prepare(`SELECT gmail_message_id AS id FROM messages WHERE status = 'ingested' ORDER BY received_at LIMIT ?`)
    .all(opts.limit ?? 50) as { id: string }[];

  for (const { id } of messages) {
    const atts = db
      .prepare(
        `SELECT id, filename, mime_type, kind, storage_path FROM attachments
          WHERE message_id = ? AND status = 'stored' AND kind IN ('pdf', 'image') ORDER BY part_id`,
      )
      .all(id) as AttachmentRow[];

    for (const a of atts) {
      try {
        const data = fs.readFileSync(path.join(dataDir, a.storage_path));
        let text: string;
        let meta: unknown;
        if (a.kind === "pdf") {
          const r = await extractor.pdf(data, a.filename);
          text = r.pages.map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n");
          meta = { pages: r.pages.length, pageText: r.pages, summary: r.summary, model: extractor.model };
        } else {
          const r = await extractor.image(data, a.mime_type, a.filename);
          text = r.text ? `${r.description}\n\nVisible text:\n${r.text}` : r.description;
          meta = { description: r.description, text: r.text, model: extractor.model };
        }
        db.prepare(`UPDATE attachments SET status = 'extracted', extracted_text = ?, meta_json = ?, error = NULL WHERE id = ?`).run(
          text,
          JSON.stringify(meta),
          a.id,
        );
        result.attachments++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        db.prepare(`UPDATE attachments SET status = 'failed', error = ? WHERE id = ?`).run(`extract: ${error}`.slice(0, 500), a.id);
        result.failed.push({ attachment: a.id, error });
      }
    }

    db.prepare(`UPDATE messages SET status = 'extracted' WHERE gmail_message_id = ? AND status = 'ingested'`).run(id);
    audit(db, extractor.model, "message.extracted", `message:${id}`, { attachments: atts.length });
    result.messages++;
  }
  return result;
}
