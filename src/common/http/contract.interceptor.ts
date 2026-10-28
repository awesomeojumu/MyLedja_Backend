import { createHash } from 'node:crypto';
import {
  type CallHandler,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, mergeMap, type Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Crypto } from '../crypto/crypto.js';
import { AppError, MESSAGES } from '../errors/errors.js';
import { isIdempotent, OPERATION_ID_HEADER, ROUTE_METADATA, type RouteDef } from './contract.js';
import { toResponse } from './error.filter.js';
import { IdempotencyRepository } from './idempotency.repository.js';
import { OperationIdHeader } from './schemas.js';
import { parseOrThrow } from './validate.js';

export const IDEMPOTENCY = Symbol('IDEMPOTENCY');
export const CRYPTO = Symbol('CRYPTO');
export const COOKIE_WRITER = Symbol('COOKIE_WRITER');

export type CookieWriter = (reply: FastifyReply, refreshToken: string) => void;

export type ContractRequest = FastifyRequest & {
  route?: RouteDef;
  input?: { params: unknown; query: unknown; body: unknown };
  operationId?: string;
  auth?: { userId: string; sessionId: string };
  /** A refresh cookie the handler set, kept with the first answer so a replay sets it again. */
  issuedCookie?: string;
};

export function routeOf(context: ExecutionContext): RouteDef | undefined {
  return new Reflector().get<RouteDef | undefined>(ROUTE_METADATA, context.getHandler());
}

/** Reads the operationId a write must carry (TECH-SPEC 5.3). */
export function readOperationId(req: FastifyRequest, route: RouteDef): string | undefined {
  if (!isIdempotent(route)) return undefined;
  const raw = req.headers[OPERATION_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !OperationIdHeader.safeParse(value).success) {
    throw new AppError(400, 'operation_id_missing', MESSAGES.operationIdMissing);
  }
  return value.toLowerCase();
}

type Stored = { status: number; body: unknown; cookie: string | null };

/**
 * Validates params, query and body against the route's contract, then runs each write once per
 * operationId: a repeat gets the first answer, whether that was a success or a refusal.
 */
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY) private readonly idempotency: IdempotencyRepository,
    @Inject(CRYPTO) private readonly crypto: Crypto,
    @Inject(COOKIE_WRITER) private readonly writeCookie: CookieWriter,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const route = routeOf(context);
    if (!route) return next.handle();
    const req = context.switchToHttp().getRequest<ContractRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    req.route = route;
    const operationId = readOperationId(req, route);
    req.input = {
      params: route.params ? parseOrThrow(route.params, req.params ?? {}) : {},
      query: route.query ? parseOrThrow(route.query, req.query ?? {}) : {},
      body: route.body ? parseOrThrow(route.body, req.body ?? {}) : undefined,
    };
    if (!operationId) return next.handle();

    const scope = req.auth ? `user:${req.auth.userId}` : 'anon';
    const bodyHash = createHash('sha256')
      .update(JSON.stringify([route.name, req.params ?? {}, req.body ?? null]))
      .digest('base64url');
    const existing = await this.idempotency.claim(scope, operationId, route.name, bodyHash);
    if (existing) {
      if (existing.bodyHash !== bodyHash) throw new AppError(422, 'operation_id_reused', MESSAGES.operationIdReused);
      if (existing.state !== 'done' || !existing.response) {
        throw new AppError(409, 'operation_in_progress', MESSAGES.operationInProgress);
      }
      const stored = JSON.parse(this.crypto.decryptText('idempotency', existing.response)) as Stored;
      if (stored.cookie) this.writeCookie(reply, stored.cookie);
      void reply.header('idempotent-replay', 'true');
      if (stored.status >= 400) {
        const { code, message, ...rest } = stored.body as { code: string; message: string };
        throw new AppError(stored.status, code, message, rest);
      }
      return of(stored.body);
    }

    const save = (s: Stored) =>
      this.idempotency.complete(scope, operationId, s.status, this.crypto.encrypt('idempotency', JSON.stringify(s)));

    return next.handle().pipe(
      mergeMap((body: unknown) =>
        from(save({ status: route.status, body: body ?? null, cookie: req.issuedCookie ?? null }).then(() => body)),
      ),
      catchError((e: unknown) =>
        from(
          (async () => {
            const r = toResponse(e);
            if (r.status < 500) await save({ status: r.status, body: r.body, cookie: null });
            else await this.idempotency.release(scope, operationId);
            throw e;
          })(),
        ),
      ),
    );
  }
}

/** The validated input of the route, typed by `Input<typeof route>`. */
export const In = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<ContractRequest>().input;
});
