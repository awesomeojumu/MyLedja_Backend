import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { PrivacyController } from "@/modules/settings-privacy/privacy.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [PrivacyController],
})
export class SettingsPrivacyModule {}
