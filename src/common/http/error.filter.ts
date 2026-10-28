import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AppError, type ErrorBody, MESSAGES } from '../errors/errors.js';

/** Turns every failure into the one error shape. Logs codes only, never bodies or values (TECH-SPEC 10). */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body, headers } = toResponse(exception);
    if (status >= 500) {
      const name = exception instanceof Error ? exception.name : 'unknown';
      this.logger.error(JSON.stringify({ event: 'request_failed', status, code: body.code, error: name }));
    }
    for (const [k, v] of Object.entries(headers)) void reply.header(k, v);
    void reply.status(status).send(body);
  }
}

export function toResponse(exception: unknown): {
  status: number;
  body: ErrorBody & Record<string, unknown>;
  headers: Record<string, string>;
} {
  if (exception instanceof AppError) {
    const headers: Record<string, string> = {};
    if (exception.extra.retryAfterSeconds !== undefined)
      headers['retry-after'] = String(exception.extra.retryAfterSeconds);
    return { status: exception.status, body: exception.body(), headers };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return { status, body: { code: 'not_found', message: MESSAGES.notFound }, headers: {} };
    if (status < 500) return { status, body: { code: 'bad_request', message: MESSAGES.bodyUnreadable }, headers: {} };
  }
  const fastifyStatus = (exception as { statusCode?: unknown })?.statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    const code = fastifyStatus === 413 ? 'too_large' : 'bad_request';
    return { status: fastifyStatus, body: { code, message: MESSAGES.bodyUnreadable }, headers: {} };
  }
  return { status: 500, body: { code: 'server_error', message: MESSAGES.serverError }, headers: {} };
}
