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

  async sendCode(message: MailMessage): Promise<void> {
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
