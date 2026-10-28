import {
  type CallHandler,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError, MESSAGES } from '../errors/errors.js';
import { isIdempotent, OPERATION_ID_HEADER, ROUTE_METADATA, type RouteDef } from './contract.js';
import { OperationIdHeader } from './schemas.js';
import { parseOrThrow } from './validate.js';

export type ContractRequest = FastifyRequest & {
  route?: RouteDef;
  input?: { params: unknown; query: unknown; body: unknown };
  operationId?: string;
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

/** Validates params, query and body against the route's contract before the handler runs. */
@Injectable()
export class ContractInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const route = routeOf(context);
    if (route) {
      const req = context.switchToHttp().getRequest<ContractRequest>();
      req.route = route;
      req.input = {
        params: route.params ? parseOrThrow(route.params, req.params ?? {}) : {},
        query: route.query ? parseOrThrow(route.query, req.query ?? {}) : {},
        body: route.body ? parseOrThrow(route.body, req.body ?? {}) : undefined,
      };
      req.operationId ??= readOperationId(req, route);
    }
    return next.handle();
  }
}

/** The validated input of the route, typed by `Input<typeof route>`. */
export const In = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<ContractRequest>().input;
});
