import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Collection, Db } from "mongodb";
import { MONGO_DB } from "@/database/mongo/mongo.constants";
import {
  CATEGORIES_COLLECTION,
  CategoryDoc,
  MERCHANTS_COLLECTION,
  MerchantDoc,
  RULES_COLLECTION,
  RuleDoc,
  TAGS_COLLECTION,
  TagDoc,
} from "@/modules/categories-merchants/schemas/catalog";

@Injectable()
export class CatalogRepository implements OnModuleInit {
  readonly categories: Collection<CategoryDoc>;
  readonly tags: Collection<TagDoc>;
  readonly merchants: Collection<MerchantDoc>;
  readonly rules: Collection<RuleDoc>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.categories = db.collection(CATEGORIES_COLLECTION);
    this.tags = db.collection(TAGS_COLLECTION);
    this.merchants = db.collection(MERCHANTS_COLLECTION);
    this.rules = db.collection(RULES_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.categories.createIndex({ workspaceId: 1 });
    await this.tags.createIndex({ workspaceId: 1, name: 1 }, { unique: true });
    await this.merchants.createIndex({ workspaceId: 1 });
  }
}
