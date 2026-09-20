import type { Context } from 'hono';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const jsonBody = async <T>(c: Context): Promise<T> => {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
};

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
