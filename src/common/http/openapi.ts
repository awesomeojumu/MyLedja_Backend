import { z } from 'zod';
import { ErrorBody } from '../errors/errors.js';
import { isIdempotent, type RouteDef } from './contract.js';

type Json = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No content',
  400: 'The input was refused; `field` names the field and `message` can be shown beside it',
  401: 'Not signed in, or the details are wrong',
  403: 'Not allowed',
  404: 'Not found, or not in a workspace you belong to',
  409: 'Conflict',
  429: 'Too many tries; wait `retryAfterSeconds`',
  501: 'Not built yet',
};

/** Builds the OpenAPI 3.1 document from the route contracts (TECH-SPEC 5.3). */
export function buildOpenApi(routes: RouteDef[], version: string): Json {
  const components: Record<string, Json> = {};

  const toSchema = (schema: z.ZodType, io: 'input' | 'output'): Json => {
    const out = z.toJSONSchema(schema, { io, target: 'draft-2020-12', unrepresentable: 'any' }) as Json;
    delete out.$schema;
    const defs = (out.$defs ?? {}) as Record<string, Json>;
    delete out.$defs;
    for (const [id, def] of Object.entries(defs)) {
      const name = io === 'input' && components[id] && !isSameShape(components[id], def) ? `${id}Input` : id;
      components[name] = rewriteRefs(def) as Json;
    }
    return rewriteRefs(out) as Json;
  };

  const errorRef = toSchema(ErrorBody, 'output');
  const paths: Record<string, Record<string, Json>> = {};

  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const parameters: Json[] = [];
    for (const [where, schema] of [
      ['path', r.params],
      ['query', r.query],
    ] as const) {
      if (!schema) continue;
      const s = toSchema(schema, 'input');
      const props = (s.properties ?? {}) as Record<string, Json>;
      const required = new Set((s.required ?? []) as string[]);
      for (const [name, propSchema] of Object.entries(props)) {
        parameters.push({ name, in: where, required: where === 'path' || required.has(name), schema: propSchema });
      }
    }
    if (isIdempotent(r)) {
      parameters.push({
        name: 'X-Operation-Id',
        in: 'header',
        required: true,
        description: 'A UUID made on the device. Retries reuse it, and the server runs the change once.',
        schema: { type: 'string', format: 'uuid' },
      });
    }
    if (r.csrfProtected) {
      parameters.push({
        name: 'X-MyLedja-Client',
        in: 'header',
        required: true,
        description: 'Any value. Proves the request came from the app, not another site.',
        schema: { type: 'string' },
      });
    }

    const responses: Record<string, Json> = {};
    responses[String(r.status)] = r.response
      ? {
          description: STATUS_TEXT[r.status] ?? 'OK',
          content: { 'application/json': { schema: toSchema(r.response, 'output') } },
        }
      : { description: STATUS_TEXT[r.status] ?? 'No content' };
    for (const status of r.errors) {
      const custom = r.errorBodies?.[status];
      responses[String(status)] = {
        description: STATUS_TEXT[status] ?? 'Error',
        content: { 'application/json': { schema: custom ? toSchema(custom, 'output') : errorRef } },
      };
    }

    const op: Json = {
      operationId: r.name,
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      security: r.access.kind === 'public' ? [] : [{ bearer: [] }],
      ...(r.access.kind === 'workspace' ? { 'x-min-role': r.access.minRole } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(r.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toSchema(r.body, 'input') } },
            },
          }
        : {}),
      responses,
    };
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'MyLedja API',
      version,
      description:
        'Generated from the Zod contracts by `npm run openapi`. Do not edit. Amounts are strings of whole minor units (kobo). Errors use the Error schema.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Development' }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: sortKeys(components),
    },
    paths: sortKeys(paths),
  };
}

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === '$ref' && typeof v === 'string' ? v.replace('#/$defs/', '#/components/schemas/') : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

function isSameShape(a: Json, b: Json): boolean {
  return JSON.stringify(rewriteRefs(a)) === JSON.stringify(rewriteRefs(b));
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
