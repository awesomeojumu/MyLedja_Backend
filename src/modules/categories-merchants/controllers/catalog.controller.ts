import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { isId } from "@/common/ids";
import { getAuth, RequireAccessToken } from "@/modules/auth/policies/require-access-token";
import { MerchantsAndTags } from "@/modules/categories-merchants/application/merchants-and-tags";
import { PreviewRule } from "@/modules/categories-merchants/application/preview-rule";
import { SeedAndListCategories } from "@/modules/categories-merchants/application/seed-and-list";
import { WorkspaceFailure } from "@/modules/workspaces/domain/roles";
import { CatalogFailure } from "@/modules/categories-merchants/domain/catalog-failure";

const STATUS_CODE = { bad_request: 400, not_found: 404, forbidden: 403 } as const;

function toHttp(error: unknown): never {
  if (error instanceof CatalogFailure) {
    throw new HttpException({ status: "error", error: error.message }, STATUS_CODE[error.status]);
  }
  if (error instanceof WorkspaceFailure) {
    throw new HttpException({ status: "error", error: error.message }, error.status === "forbidden" ? 403 : 404);
  }
  throw error;
}

function workspace(id: string): string {
  if (!isId(id)) throw new CatalogFailure("bad_request", "That workspace is not valid.");
  return id;
}

@Controller("workspaces/:workspaceId")
@UseGuards(RequireAccessToken)
export class CatalogController {
  constructor(
    private readonly categories: SeedAndListCategories,
    private readonly merchantsAndTags: MerchantsAndTags,
    private readonly previewRule: PreviewRule,
  ) {}

  @Get("categories")
  async listCategories(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.categories.list(getAuth(req).userId, workspace(workspaceId));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("categories")
  async createCategory(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const r = body as Record<string, unknown>;
      return await this.categories.create(getAuth(req).userId, workspace(workspaceId), {
        name: String(r?.name ?? ""),
        kind: r?.kind === "income" ? "income" : "expense",
        parentId: typeof r?.parentId === "string" ? r.parentId : null,
      });
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("merchants")
  async listMerchants(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.merchantsAndTags.listMerchants(getAuth(req).userId, workspace(workspaceId));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("merchants")
  async merchant(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const r = body as Record<string, unknown>;
      return await this.merchantsAndTags.createMerchant(getAuth(req).userId, workspace(workspaceId), {
        name: String(r?.name ?? ""),
        categoryId: String(r?.categoryId ?? ""),
        aliases: Array.isArray(r?.aliases) ? r.aliases.map(String) : [],
      });
    } catch (error) {
      toHttp(error);
    }
  }

  @Get("tags")
  async tags(@Param("workspaceId") workspaceId: string, @Req() req: Request) {
    try {
      return await this.merchantsAndTags.listTags(getAuth(req).userId, workspace(workspaceId));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("tags")
  async tag(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const r = body as Record<string, unknown>;
      return await this.merchantsAndTags.createTag(getAuth(req).userId, workspace(workspaceId), String(r?.name ?? ""));
    } catch (error) {
      toHttp(error);
    }
  }

  @Post("rules/preview")
  @HttpCode(200)
  async preview(@Param("workspaceId") workspaceId: string, @Body() body: unknown, @Req() req: Request) {
    try {
      const r = (body ?? {}) as Record<string, unknown>;
      return await this.previewRule.execute(getAuth(req).userId, workspace(workspaceId), {
        descriptionContains: typeof r.descriptionContains === "string" ? r.descriptionContains : undefined,
        merchantId: typeof r.merchantId === "string" ? r.merchantId : undefined,
        alias: typeof r.alias === "string" ? r.alias : undefined,
      });
    } catch (error) {
      toHttp(error);
    }
  }
}
