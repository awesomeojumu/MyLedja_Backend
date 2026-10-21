import { Module } from "@nestjs/common";
import { HashOptions } from "argon2";
import { loadConfig } from "@/config/env";
import { UsersModule } from "@/modules/users/users.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { ConfirmRecovery } from "@/modules/auth/application/confirm-recovery";
import { GetMe } from "@/modules/auth/application/get-me";
import { Login } from "@/modules/auth/application/login";
import { Logout } from "@/modules/auth/application/logout";
import { RefreshSession } from "@/modules/auth/application/refresh-session";
import { RegisterUser } from "@/modules/auth/application/register-user";
import { RequestRecovery } from "@/modules/auth/application/request-recovery";
import { ResendVerification } from "@/modules/auth/application/resend-verification";
import { VerifyEmail } from "@/modules/auth/application/verify-email";
import { AuthController } from "@/modules/auth/controllers/auth.controller";
import { MeSecurityController } from "@/modules/auth/controllers/me-security.controller";
import { MfaAndPasskeys } from "@/modules/auth/application/mfa-passkeys";
import {
  CaptureMailer,
  createResendMailer,
  describeMailer,
  createSmtpMailer,
  DevMailer,
  MAILER,
  Mailer,
  ProductionMailer,
  resendFromEnv,
  smtpFromEnv,
} from "@/modules/auth/domain/mailer";
import { ARGON2_OPTIONS, ARGON2_PRODUCTION, ARGON2_TEST } from "@/modules/auth/domain/password";
import { RateLimit } from "@/modules/auth/domain/rate-limit";
import { RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { EmailCodesRepository } from "@/modules/auth/repositories/email-codes.repository";
import { SecurityEventsRepository } from "@/modules/auth/repositories/security-events.repository";
import { SessionsRepository } from "@/modules/auth/repositories/sessions.repository";

/** Tests capture codes. Resend wins over SMTP. Development without either still prints the code. */
function mailerFor(env: string): Mailer {
  if (env === "test") {
    return new CaptureMailer();
  }
  const resend = resendFromEnv();
  if (resend) {
    return createResendMailer(resend);
  }
  const smtp = smtpFromEnv();
  if (smtp) {
    return createSmtpMailer(smtp);
  }
  if (env === "development") {
    return new DevMailer();
  }
  return new ProductionMailer();
}

@Module({
  imports: [UsersModule, WorkspacesModule],
  controllers: [AuthController, MeSecurityController],
  providers: [
    MfaAndPasskeys,
    RegisterUser,
    VerifyEmail,
    Login,
    RefreshSession,
    Logout,
    RequestRecovery,
    ConfirmRecovery,
    ResendVerification,
    GetMe,
    SessionsRepository,
    EmailCodesRepository,
    SecurityEventsRepository,
    RateLimit,
    RequireAccessToken,
    {
      provide: MAILER,
      useFactory: (): Mailer => {
        const env = loadConfig().appEnv;
        const line = `[auth] ${describeMailer(env)}`;
        if (env !== "test") (line.includes("NOT configured") ? console.error : console.info)(line);
        return mailerFor(env);
      },
    },
    {
      provide: ARGON2_OPTIONS,
      useFactory: (): HashOptions =>
        loadConfig().appEnv === "test" ? ARGON2_TEST : ARGON2_PRODUCTION,
    },
  ],
  exports: [RequireAccessToken, SessionsRepository],
})
export class AuthModule {}
