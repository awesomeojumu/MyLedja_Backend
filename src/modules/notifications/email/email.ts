import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../../../config/config.schema.js';

export type EmailMessage = { to: string; subject: string; text: string; template: string };

export interface EmailSender {
  readonly provider: 'resend' | 'smtp' | 'off';
  send(message: EmailMessage): Promise<{ id: string | null }>;
}

export class EmailError extends Error {
  constructor(readonly reason: string) {
    super(`email_failed:${reason}`);
    this.name = 'EmailError';
  }
}

export class ResendSender implements EmailSender {
  readonly provider = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: EmailMessage) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        tags: [{ name: 'template', value: m.template }],
      }),
    });
    if (!res.ok) throw new EmailError(`resend_${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: body.id ?? null };
  }
}

export class SmtpSender implements EmailSender {
  readonly provider = 'smtp' as const;
  private readonly transport: Transporter;
  constructor(
    config: { host: string; port: number; user: string | null; pass: string | null; from: string },
    transport?: Transporter,
  ) {
    this.from = config.from;
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === 465,
        auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
      });
  }
  private readonly from: string;

  async send(m: EmailMessage) {
    try {
      const info = await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
      return { id: (info as { messageId?: string }).messageId ?? null };
    } catch (e) {
      throw new EmailError(`smtp_${(e as { code?: string }).code ?? 'error'}`);
    }
  }
}

/** No email service set: nothing is sent. Allowed only in development (sign-up would otherwise be impossible). */
export class OffSender implements EmailSender {
  readonly provider = 'off' as const;
  async send() {
    return { id: null };
  }
}

export function pickSender(config: AppConfig): EmailSender {
  const e = config.email;
  if (e.provider === 'resend') return new ResendSender(e.apiKey, e.from);
  if (e.provider === 'smtp') return new SmtpSender(e);
  return new OffSender();
}

/** Builds and sends MyLedja's emails. Logs the template and provider only, never the address or a code. */
export class Mailer {
  private readonly logger = new Logger('Email');

  constructor(
    readonly sender: EmailSender,
    private readonly webAppUrl: string,
  ) {}

  private async deliver(m: EmailMessage) {
    try {
      const { id } = await this.sender.send(m);
      this.logger.log(
        JSON.stringify({ event: 'email_sent', template: m.template, provider: this.sender.provider, id }),
      );
    } catch (e) {
      const reason = e instanceof EmailError ? e.reason : 'unknown';
      this.logger.error(
        JSON.stringify({ event: 'email_failed', template: m.template, provider: this.sender.provider, reason }),
      );
    }
  }

  signUpCode(to: string, name: string, code: string) {
    return this.deliver({
      to,
      template: 'sign_up_code',
      subject: `${code} is your MyLedja code`,
      text: [
        `Hello ${name},`,
        '',
        `Your MyLedja code is ${code}. It expires in 10 minutes.`,
        '',
        "If you didn't try to create a MyLedja account, you can ignore this email.",
      ].join('\n'),
    });
  }

  alreadyRegistered(to: string) {
    return this.deliver({
      to,
      template: 'already_registered',
      subject: 'You already have a MyLedja account',
      text: [
        'Someone tried to create a MyLedja account with this email, but you already have one.',
        '',
        `Sign in here: ${this.webAppUrl}/sign-in`,
        `Forgot your password? Recover your account: ${this.webAppUrl}/recover`,
        '',
        "If this wasn't you, you can ignore this email. Your account hasn't changed.",
      ].join('\n'),
    });
  }

  recoverCode(to: string, code: string) {
    return this.deliver({
      to,
      template: 'recover_code',
      subject: `${code} is your MyLedja recovery code`,
      text: [
        `Your MyLedja recovery code is ${code}. It expires in 10 minutes.`,
        '',
        "If you didn't ask to recover your account, you can ignore this email. Your password hasn't changed.",
      ].join('\n'),
    });
  }

  jobParked(to: string, jobName: string, jobId: string) {
    return this.deliver({
      to,
      template: 'job_parked',
      subject: `MyLedja job parked: ${jobName}`,
      text: [`The background job ${jobName} (${jobId}) failed too many times and has been parked for review.`].join(
        '\n',
      ),
    });
  }

  balanceMismatch(to: string, workspaceId: string, mismatches: number) {
    return this.deliver({
      to,
      template: 'balance_mismatch',
      subject: 'MyLedja balance check found a mismatch',
      text: [
        `The nightly balance check found ${mismatches} stored balance(s) in workspace ${workspaceId} that differ from the sum of their lines.`,
        'Nothing was overwritten. The details are in the balance_checks collection.',
      ].join('\n'),
    });
  }

  passwordChanged(to: string) {
    return this.deliver({
      to,
      template: 'password_changed',
      subject: 'Your MyLedja password was changed',
      text: [
        'Your MyLedja password was changed, and your other devices were signed out.',
        '',
        `If this wasn't you, recover your account now: ${this.webAppUrl}/recover`,
      ].join('\n'),
    });
  }
}
