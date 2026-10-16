import { Module } from "@nestjs/common";
import { HashOptions } from "argon2";
import { loadConfig } from "../../config/env";
import { UsersModule } from "../users/users.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { ConfirmRecovery } from "./application/confirm-recovery";
import { GetMe } from "./application/get-me";
import { Login } from "./application/login";
import { Logout } from "./application/logout";
import { RefreshSession } from "./application/refresh-session";
import { RegisterUser } from "./application/register-user";
import { RequestRecovery } from "./application/request-recovery";
import { ResendVerification } from "./application/resend-verification";
import { VerifyEmail } from "./application/verify-email";
import { AuthController } from "./controllers/auth.controller";
import {
  CaptureMailer,
  createSmtpMailer,
  DevMailer,
  MAILER,
  Mailer,
  ProductionMailer,
  smtpFromEnv,
} from "./domain/mailer";
import { ARGON2_OPTIONS, ARGON2_PRODUCTION, ARGON2_TEST } from "./domain/password";
import { RateLimit } from "./domain/rate-limit";
import { RequireAccessToken } from "./policies/require-access-token";
import { EmailCodesRepository } from "./repositories/email-codes.repository";
import { SecurityEventsRepository } from "./repositories/security-events.repository";
import { SessionsRepository } from "./repositories/sessions.repository";

/** Tests capture codes. SMTP sends when configured. Development without SMTP still prints the code. */
function mailerFor(env: string): Mailer {
  if (env === "test") {
    return new CaptureMailer();
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
  controllers: [AuthController],
  providers: [
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
      useFactory: (): Mailer => mailerFor(loadConfig().appEnv),
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
