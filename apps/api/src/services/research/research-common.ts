const MAX_RESPONSE_BYTES = 256_000;

export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Research request was cancelled.', 'AbortError');
}

export function publicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Enter a valid public HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  if (url.username || url.password)
    throw new Error('URLs containing credentials are not supported.');

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const privateName =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal');
  const ipLiteral = hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (!hostname || !hostname.includes('.') || privateName || ipLiteral)
    throw new Error('Only public internet URLs are supported.');
  url.hash = '';
  return url;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function within<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  assertActive(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Research request was cancelled.', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => reject(new Error('Research request timed out.')), timeoutMs);
  });
  try {
    return await Promise.race([promise, stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Browser Run returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Browser Run response was too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function boundedJson<T = { success?: boolean; result?: unknown }>(
  response: Response,
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(await boundedBytes(response, MAX_RESPONSE_BYTES)),
  ) as T;
}
