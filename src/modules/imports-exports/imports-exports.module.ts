import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { ImportsController } from "@/modules/imports-exports/imports.controller";

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [ImportsController],
})
export class ImportsExportsModule {}
