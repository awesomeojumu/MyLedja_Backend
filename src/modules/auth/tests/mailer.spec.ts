import { SmtpMailer, smtpFromEnv } from "@/modules/auth/domain/mailer";

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
