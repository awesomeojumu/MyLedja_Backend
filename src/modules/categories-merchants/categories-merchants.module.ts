import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { WorkspacesModule } from "@/modules/workspaces/workspaces.module";
import { MerchantsAndTags } from "@/modules/categories-merchants/application/merchants-and-tags";
import { PreviewRule } from "@/modules/categories-merchants/application/preview-rule";
import { SeedAndListCategories } from "@/modules/categories-merchants/application/seed-and-list";
import { CatalogController } from "@/modules/categories-merchants/controllers/catalog.controller";
import { CatalogRepository } from "@/modules/categories-merchants/repositories/catalog.repository";

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [CatalogController],
  providers: [CatalogRepository, SeedAndListCategories, MerchantsAndTags, PreviewRule],
  exports: [CatalogRepository],
})
export class CategoriesMerchantsModule {}
