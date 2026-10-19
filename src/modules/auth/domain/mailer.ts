import nodemailer from "nodemailer";

export const MAILER = Symbol("MAILER");

export type MailPurpose = "verify" | "recovery";

export interface MailMessage {
  email: string;
  purpose: MailPurpose;
  code: string;
}

export interface Mailer {
  sendCode(message: MailMessage): Promise<void>;
}

/**
 * Sends a code without letting a delivery failure change the reply. Register, resend and recovery all answer the
 * same way whether or not an account exists, so a bounced address must not surface as a 500 (that would reveal the
 * account, and strand the user). The failure is logged without the code or the address.
 */
export async function sendCodeQuietly(
  mailer: Mailer,
  message: MailMessage,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<boolean> {
  try {
    await mailer.sendCode(message);
    return true;
  } catch (caught) {
    const reason = caught instanceof Error ? caught.name : "unknown";
    log(`[auth] ${message.purpose} code could not be delivered (${reason})`);
    return false;
  }
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpSettings | undefined {
  const host = env.SMTP_HOST ?? "";
  const user = env.SMTP_USER ?? "";
  const pass = env.SMTP_PASS ?? "";
  const from = env.SMTP_FROM ?? "";
  if (!host || !user || !pass || !from) {
    return undefined;
  }
  const port = Number(env.SMTP_PORT ?? 465);
  if (!Number.isInteger(port) || port < 1) {
    return undefined;
  }
  return { host, port, user, pass, from };
}

export class SmtpMailer implements Mailer {
  constructor(
    private readonly send: (message: SmtpMessage) => Promise<void>,
    private readonly from: string,
  ) {}

  async sendCode(message: MailMessage): Promise<void> {
    const subject =
      message.purpose === "verify" ? "Your MyLedja verification code" : "Your MyLedja password reset code";
    await this.send({
      from: this.from,
      to: message.email,
      subject,
      text: `Your MyLedja code is ${message.code}. It expires in a few minutes. If you did not request this, ignore this email.`,
    });
  }
}

export interface ResendSettings {
  apiKey: string;
  from: string;
}

export interface ResendPostInit {
  headers: { authorization: string; "content-type": string };
  body: string;
}

export type ResendPost = (
  url: string,
  init: ResendPostInit,
) => Promise<{ ok: boolean; status: number }>;

export function resendFromEnv(env: NodeJS.ProcessEnv = process.env): ResendSettings | undefined {
  const apiKey = env.RESEND_API_KEY ?? "";
  const from = env.RESEND_FROM ?? env.SMTP_FROM ?? "";
  if (!apiKey || !from) {
    return undefined;
  }
  return { apiKey, from };
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly post: ResendPost,
    private readonly settings: ResendSettings,
  ) {}

  async sendCode(message: MailMessage): Promise<void> {
    const subject =
      message.purpose === "verify" ? "Your MyLedja verification code" : "Your MyLedja password reset code";
    const res = await this.post("https://api.resend.com/emails", {
      headers: {
        authorization: `Bearer ${this.settings.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.settings.from,
        to: [message.email],
        subject,
        text: `Your MyLedja code is ${message.code}. It expires in a few minutes. If you did not request this, ignore this email.`,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend ${res.status}`);
    }
  }
}

export function createResendMailer(settings: ResendSettings): ResendMailer {
  return new ResendMailer(async (url, init) => {
    const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body });
    return { ok: res.ok, status: res.status };
  }, settings);
}

export function createSmtpMailer(settings: SmtpSettings): SmtpMailer {
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: { user: settings.user, pass: settings.pass },
  });
  return new SmtpMailer(async (message) => {
    await transporter.sendMail(message);
  }, settings.from);
}

export class DevMailer implements Mailer {
  async sendCode(message: MailMessage): Promise<void> {
    console.info(`[auth] ${message.purpose} code for ${message.email}: ${message.code}`);
  }
}

export class ProductionMailer implements Mailer {
  async sendCode(): Promise<void> {
    throw new Error("Email delivery is not configured");
  }
}

export class CaptureMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** Addresses the fake mail server rejects, like a real SMTP 550. */
  readonly rejects = new Set<string>();

  async sendCode(message: MailMessage): Promise<void> {
    if (this.rejects.has(message.email)) {
      throw new Error("550 recipient rejected");
    }
    this.sent.push(message);
  }

  lastCode(email: string, purpose: MailPurpose): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message.email === email && message.purpose === purpose) {
        return message.code;
      }
    }
    return undefined;
  }
}
