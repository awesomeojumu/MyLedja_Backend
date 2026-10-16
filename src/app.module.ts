import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/mongo/database.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { AuthModule } from "./modules/auth/auth.module";
import { BankIntegrationsModule } from "./modules/bank-integrations/bank-integrations.module";
import { BillsModule } from "./modules/bills/bills.module";
import { BudgetsModule } from "./modules/budgets/budgets.module";
import { CategoriesMerchantsModule } from "./modules/categories-merchants/categories-merchants.module";
import { DebtsModule } from "./modules/debts/debts.module";
import { ImportsExportsModule } from "./modules/imports-exports/imports-exports.module";
import { IncomeModule } from "./modules/income/income.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PlansGoalsModule } from "./modules/plans-goals/plans-goals.module";
import { SavingsInvestmentsModule } from "./modules/savings-investments/savings-investments.module";
import { SecurityModule } from "./modules/security/security.module";
import { SettingsPrivacyModule } from "./modules/settings-privacy/settings-privacy.module";
import { SupportOperationsModule } from "./modules/support-operations/support-operations.module";
import { TaxesModule } from "./modules/taxes/taxes.module";
import { TransactionsModule } from "./modules/transactions/transactions.module";
import { UsersModule } from "./modules/users/users.module";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module";

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    UsersModule,
    SecurityModule,
    WorkspacesModule,
    AccountsModule,
    TransactionsModule,
    CategoriesMerchantsModule,
    IncomeModule,
    BudgetsModule,
    BillsModule,
    PlansGoalsModule,
    DebtsModule,
    SavingsInvestmentsModule,
    TaxesModule,
    AnalyticsModule,
    NotificationsModule,
    ImportsExportsModule,
    BankIntegrationsModule,
    SettingsPrivacyModule,
    SupportOperationsModule,
  ],
})
export class AppModule {}
