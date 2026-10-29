import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../../../../test/helpers/test-config.js';
import {
  EmailError,
  type EmailMessage,
  type EmailSender,
  Mailer,
  OffSender,
  pickSender,
  ResendSender,
  SmtpSender,
} from '../email.js';

class Recording implements EmailSender {
  readonly provider = 'smtp' as const;
  sent: EmailMessage[] = [];
  fail = false;
  async send(m: EmailMessage) {
    if (this.fail) throw new EmailError('smtp_ECONNREFUSED');
    this.sent.push(m);
    return { id: 'msg-1' };
  }
}

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
  vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void lines.push(String(m)));
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe('email (B0.6)', () => {
  it('picks Resend when RESEND_API_KEY is set', () => {
    const c = testConfig({
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'MyLedja <help@myledja.test>',
      SMTP_HOST: 'smtp.example.test',
      SMTP_FROM: 'help@myledja.test',
    });
    expect(pickSender(c)).toBeInstanceOf(ResendSender);
  });

  it('picks SMTP otherwise', () => {
    expect(pickSender(testConfig({ SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'help@myledja.test' }))).toBeInstanceOf(
      SmtpSender,
    );
    expect(pickSender(testConfig())).toBeInstanceOf(OffSender);
  });

  it('sends through the Resend API', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'r1' }), { status: 200 }));
    const s = new ResendSender('re_key', 'MyLedja <help@myledja.test>', fetchImpl as unknown as typeof fetch);
    expect(await s.send({ to: 'ada@example.test', subject: 's', text: 't', template: 'x' })).toEqual({ id: 'r1' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
    const failing = new ResendSender(
      'k',
      'f',
      (async () => new Response('', { status: 422 })) as unknown as typeof fetch,
    );
    await expect(failing.send({ to: 'a', subject: 's', text: 't', template: 'x' })).rejects.toThrow('resend_422');
  });

  it('sends through SMTP', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'm1' }));
    const s = new SmtpSender({ host: 'h', port: 465, user: null, pass: null, from: 'f' }, { sendMail } as never);
    expect(await s.send({ to: 'a', subject: 's', text: 't', template: 'x' })).toEqual({ id: 'm1' });
    const broken = new SmtpSender({ host: 'h', port: 465, user: 'u', pass: null, from: 'f' }, {
      sendMail: async () => {
        throw Object.assign(new Error('x'), { code: 'EAUTH' });
      },
    } as never);
    await expect(broken.send({ to: 'a', subject: 's', text: 't', template: 'x' })).rejects.toThrow('smtp_EAUTH');
  });

  it('never logs a code or an address', async () => {
    const lines = captureLogs();
    const sender = new Recording();
    const mailer = new Mailer(sender, 'https://app.myledja.test');
    await mailer.signUpCode('ada@example.test', 'Ada', '482913');
    await mailer.recoverCode('ada@example.test', '771204');
    await mailer.alreadyRegistered('ada@example.test');
    await mailer.passwordChanged('ada@example.test');
    await mailer.emailChangeCode('new@example.test', '654321');
    await mailer.emailChangedNotice('ada@example.test', 'new@example.test');
    await mailer.billReminder('ada@example.test', 'Rent due tomorrow', 'Due on 2026-10-05.');
    sender.fail = true;
    await mailer.signUpCode('ada@example.test', 'Ada', '555111');
    expect(sender.sent[0]?.text).toContain('482913');
    expect(sender.sent[2]?.text).toContain('https://app.myledja.test/sign-in');
    expect(sender.sent[4]?.template).toBe('email_change_code');
    expect(sender.sent[5]?.template).toBe('email_changed');
    expect(sender.sent[6]?.template).toBe('bill_reminder');
    const all = lines.join('\n');
    expect(lines).toHaveLength(8);
    for (const secret of ['482913', '771204', '555111', '654321', 'ada@example.test', 'new@example.test', 'Ada'])
      expect(all).not.toContain(secret);
    expect(all).toContain('smtp_ECONNREFUSED');
  });

  it('writes copy without exclamation marks or dashes between words', async () => {
    const sender = new Recording();
    const mailer = new Mailer(sender, 'https://app.myledja.test');
    await mailer.signUpCode('a@b.test', 'Ada', '123456');
    await mailer.alreadyRegistered('a@b.test');
    await mailer.recoverCode('a@b.test', '123456');
    await mailer.passwordChanged('a@b.test');
    await mailer.emailChangeCode('a@b.test', '123456');
    await mailer.emailChangedNotice('a@b.test', 'c@d.test');
    await mailer.billReminder('a@b.test', 'Rent due tomorrow', 'Due on 2026-10-05.');
    for (const m of sender.sent) expect(m.subject + m.text).not.toMatch(/[!—–…]/);
  });
});
