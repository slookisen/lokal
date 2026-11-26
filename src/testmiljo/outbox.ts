/**
 * Testmiljø: the outbox. E-mail is captured here instead of being sent.
 *
 * EmailService.setupTransporter() installs createOutboxTransport() in place of
 * the SMTP transport when isTestmiljo() is true. Both send paths (sendEmail
 * and sendRaw) end in transporter.sendMail(), so every e-mail the app would
 * send lands in one JSON-lines file next to the test databases, and the caller
 * gets a real-looking message id back. That matters: many flows treat the
 * unconfigured transport's "DRY_RUN" id as "not sent" and stop there.
 *
 * The file lives beside DB_PATH. The launcher's reset (npm run
 * testmiljo:nullstill) removes it together with the databases.
 *
 * Read at /testmiljo/epost (src/testmiljo/router.ts).
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export interface OutboxAttachment {
  filename: string;
  contentType?: string;
  bytes: number;
}

export interface OutboxMail {
  id: string;
  at: string;
  messageId: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: OutboxAttachment[];
}

/** outbox.jsonl beside the main test database; the temp dir when DB_PATH is unset or in-memory. */
export function outboxFile(env: NodeJS.ProcessEnv = process.env): string {
  const dbPath = (env.DB_PATH ?? "").trim();
  const dir = dbPath && dbPath !== ":memory:" ? path.dirname(path.resolve(dbPath)) : os.tmpdir();
  return path.join(dir, "outbox.jsonl");
}

function address(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(address).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const v = value as { name?: string; address?: string };
    if (v.address) return v.name ? `${v.name} <${v.address}>` : v.address;
  }
  return String(value);
}

function byteLength(content: unknown): number {
  if (Buffer.isBuffer(content)) return content.length;
  if (typeof content === "string") return Buffer.byteLength(content);
  return 0;
}

function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) out[key] = String(value);
  }
  return out;
}

/** The nodemailer mail options, reduced to what the outbox page shows. */
export function toOutboxMail(mailOptions: Record<string, any>): OutboxMail {
  const id = crypto.randomBytes(8).toString("hex");
  const headers = headerMap(mailOptions.headers);
  if (mailOptions.inReplyTo) headers["In-Reply-To"] = String(mailOptions.inReplyTo);
  if (mailOptions.references) headers["References"] = address(mailOptions.references);
  const mail: OutboxMail = {
    id,
    at: new Date().toISOString(),
    messageId: `<${id}@testmiljo.invalid>`,
    from: address(mailOptions.from),
    to: address(mailOptions.to),
    subject: String(mailOptions.subject ?? ""),
    headers,
    attachments: (Array.isArray(mailOptions.attachments) ? mailOptions.attachments : []).map((a: any) => ({
      filename: String(a?.filename ?? ""),
      contentType: a?.contentType ? String(a.contentType) : undefined,
      bytes: byteLength(a?.content),
    })),
  };
  const cc = address(mailOptions.cc);
  const bcc = address(mailOptions.bcc);
  const replyTo = address(mailOptions.replyTo);
  if (cc) mail.cc = cc;
  if (bcc) mail.bcc = bcc;
  if (replyTo) mail.replyTo = replyTo;
  if (typeof mailOptions.text === "string") mail.text = mailOptions.text;
  if (typeof mailOptions.html === "string") mail.html = mailOptions.html;
  return mail;
}

export interface OutboxTransport {
  sendMail(mailOptions: Record<string, any>): Promise<{ messageId: string; accepted: string[]; rejected: string[]; response: string }>;
}

/** Stands in for nodemailer's transporter. `file` is resolved per send, so a reset mid-run is picked up. */
export function createOutboxTransport(file: () => string = outboxFile): OutboxTransport {
  return {
    async sendMail(mailOptions) {
      const mail = toOutboxMail(mailOptions);
      const target = file();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, JSON.stringify(mail) + "\n", "utf8");
      return { messageId: mail.messageId, accepted: mail.to ? [mail.to] : [], rejected: [], response: "250 captured by the testmiljø outbox" };
    },
  };
}

/** Newest first. A line that does not parse is skipped. */
export function listOutbox(file: string = outboxFile()): OutboxMail[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const mails: OutboxMail[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      mails.push(JSON.parse(line) as OutboxMail);
    } catch {
      /* skip a torn line */
    }
  }
  return mails.reverse();
}

export function getOutboxMail(id: string, file: string = outboxFile()): OutboxMail | null {
  return listOutbox(file).find((mail) => mail.id === id) ?? null;
}

export function clearOutbox(file: string = outboxFile()): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* nothing to clear */
  }
}
