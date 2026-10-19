import { ResendMailer, SmtpMailer, resendFromEnv, smtpFromEnv } from "@/modules/auth/domain/mailer";

describe("smtpFromEnv", () => {
  it("returns nothing until host, user, pass and from are all set", () => {
    expect(smtpFromEnv({})).toBeUndefined();
    expect(
      smtpFromEnv({
        SMTP_HOST: "mail.example.com",
        SMTP_USER: "help@example.com",
        SMTP_PASS: "secret",
      }),
    ).toBeUndefined();
  });

  it("reads the SMTP settings", () => {
    expect(
      smtpFromEnv({
        SMTP_HOST: "mail.example.com",
        SMTP_PORT: "465",
        SMTP_USER: "help@example.com",
        SMTP_PASS: "secret",
        SMTP_FROM: "MyLedja <help@example.com>",
      }),
    ).toEqual({
      host: "mail.example.com",
      port: 465,
      user: "help@example.com",
      pass: "secret",
      from: "MyLedja <help@example.com>",
    });
  });
});

describe("SmtpMailer", () => {
  it("sends the code to the user without printing it", async () => {
    const sent: Array<{ to: string; subject: string; text: string; from: string }> = [];
    const mailer = new SmtpMailer(async (message) => {
      sent.push(message);
    }, "MyLedja <help@example.com>");
    await mailer.sendCode({ email: "ada@example.com", purpose: "verify", code: "123456" });
    expect(sent).toEqual([
      {
        from: "MyLedja <help@example.com>",
        to: "ada@example.com",
        subject: "Your MyLedja verification code",
        text: expect.stringContaining("123456"),
      },
    ]);
  });
});

describe("resendFromEnv", () => {
  it("returns nothing until the API key and from address are set", () => {
    expect(resendFromEnv({})).toBeUndefined();
    expect(resendFromEnv({ RESEND_API_KEY: "re_test" })).toBeUndefined();
  });

  it("accepts SMTP_FROM when RESEND_FROM is missing", () => {
    expect(
      resendFromEnv({
        RESEND_API_KEY: "re_test",
        SMTP_FROM: "MyLedja <help@example.com>",
      }),
    ).toEqual({ apiKey: "re_test", from: "MyLedja <help@example.com>" });
  });
});

describe("ResendMailer", () => {
  it("posts the code to Resend over HTTPS", async () => {
    const posts: Array<{ url: string; auth: string; body: unknown }> = [];
    const mailer = new ResendMailer(async (url, init) => {
      posts.push({
        url,
        auth: init.headers.authorization,
        body: JSON.parse(init.body),
      });
      return { ok: true, status: 200 };
    }, { apiKey: "re_test", from: "MyLedja <help@example.com>" });
    await mailer.sendCode({ email: "ada@example.com", purpose: "recovery", code: "654321" });
    expect(posts).toEqual([
      {
        url: "https://api.resend.com/emails",
        auth: "Bearer re_test",
        body: {
          from: "MyLedja <help@example.com>",
          to: ["ada@example.com"],
          subject: "Your MyLedja password reset code",
          text: expect.stringContaining("654321"),
        },
      },
    ]);
  });

  it("fails when Resend rejects the send", async () => {
    const mailer = new ResendMailer(async () => ({ ok: false, status: 403 }), {
      apiKey: "re_test",
      from: "MyLedja <help@example.com>",
    });
    await expect(
      mailer.sendCode({ email: "ada@example.com", purpose: "recovery", code: "000000" }),
    ).rejects.toThrow("Resend 403");
  });
});

