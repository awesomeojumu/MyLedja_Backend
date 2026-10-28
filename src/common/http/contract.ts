import { applyDecorators, HttpCode, RequestMapping, RequestMethod, SetMetadata } from '@nestjs/common';
import { z } from 'zod';
import type { Role } from '../auth/roles.js';

export const OPERATION_ID_HEADER = 'x-operation-id';
/** The custom header the cookie refresh needs, so other sites can't use the cookie (TECH-SPEC 10). */
export const CLIENT_HEADER = 'x-myledja-client';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RouteAccess = { kind: 'public' } | { kind: 'user' } | { kind: 'workspace'; minRole: Role };

type AnyObject = z.ZodType<Record<string, unknown>>;

export interface RouteDef<
  P extends AnyObject | undefined = AnyObject | undefined,
  Q extends AnyObject | undefined = AnyObject | undefined,
  B extends z.ZodType | undefined = z.ZodType | undefined,
  R extends z.ZodType | null = z.ZodType | null,
> {
  /** Stable name used for the OpenAPI operationId and generated client. */
  name: string;
  method: HttpMethod;
  /** Express-style path under /v1, for example "/v1/workspaces/:workspaceId". */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: RouteAccess;
  params?: P;
  query?: Q;
  body?: B;
  status: number;
  /** `null` means no body (204). */
  response: R;
  /** Other documented statuses. Each uses the error shape unless listed in `errorBodies`. */
  errors: number[];
  errorBodies?: Partial<Record<number, z.ZodType>>;
  /**
   * Writes take an X-Operation-Id and run once (TECH-SPEC 5.3). Defaults to true for anything but GET.
   * Refresh opts out: replaying an old refresh token is the reuse that ends every session.
   */
  idempotent?: boolean;
  /** Requires the X-MyLedja-Client header and an allowed Origin when the browser sends one. */
  csrfProtected?: boolean;
}

export type Input<D extends RouteDef> = {
  params: D['params'] extends z.ZodType ? z.output<D['params']> : Record<string, never>;
  query: D['query'] extends z.ZodType ? z.output<D['query']> : Record<string, never>;
  body: D['body'] extends z.ZodType ? z.output<D['body']> : undefined;
};

export type Output<D extends RouteDef> = D['response'] extends z.ZodType ? z.input<D['response']> : void;

export function defineRoute<
  P extends AnyObject | undefined = undefined,
  Q extends AnyObject | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
  R extends z.ZodType | null = null,
>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

export function isIdempotent(def: RouteDef): boolean {
  return def.idempotent ?? def.method !== 'GET';
}

export const ROUTE_METADATA = 'myledja:route';

const METHODS: Record<HttpMethod, RequestMethod> = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PATCH: RequestMethod.PATCH,
  PUT: RequestMethod.PUT,
  DELETE: RequestMethod.DELETE,
};

/** Binds a controller method to its contract: path, method, status, and the metadata the guards read. */
export function Route(def: RouteDef) {
  return applyDecorators(
    RequestMapping({ path: def.path, method: METHODS[def.method] }),
    HttpCode(def.status),
    SetMetadata(ROUTE_METADATA, def),
  );
}
