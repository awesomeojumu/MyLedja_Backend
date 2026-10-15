import { Module } from "@nestjs/common";
import { SupportOperationsModule } from "./modules/support-operations/support-operations.module";

@Module({
  imports: [SupportOperationsModule],
})
export class AppModule {}
