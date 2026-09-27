import type { Context } from 'hono';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** A required binding or secret is missing from this deployment. */
export class ServiceUnavailableError extends HttpError {
  constructor(message: string) {
    super(503, message);
  }
}

export const jsonBody = async <T>(c: Context): Promise<T> => {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
};

/** Read a JSON body and validate it, turning schema failures into a 400 with `message`. */
export const parseBody = async <T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  message: string,
): Promise<z.infer<T>> => {
  const parsed = schema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new HttpError(400, message, parsed.error.flatten());
  return parsed.data;
};

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
