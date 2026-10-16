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
