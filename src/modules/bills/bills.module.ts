import { Injectable, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { LedgerModule } from "@/modules/ledger/ledger.module";
import { LedgerOpsService } from "@/modules/ledger/ledger-ops.service";
import { BillsController } from "@/modules/bills/bills.controller";

@Injectable()
class TickReminders implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly ops: LedgerOpsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.ops.tickReminders();
    }, 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [BillsController],
  providers: [TickReminders],
})
export class BillsModule {}
