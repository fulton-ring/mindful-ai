import type { WaldenUIMessageChunk } from '@walden/contracts';
import { UI_MESSAGE_STREAM_HEADERS } from 'ai';

type Chunk = WaldenUIMessageChunk;
type Reader = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();
const KEEPALIVE_MS = 15_000;
const frame = (chunk: Chunk, seq: number) =>
  encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(chunk)}\n\n`);
const DONE = encoder.encode('data: [DONE]\n\n');
const KEEPALIVE = encoder.encode(': keepalive\n\n');

/**
 * A turn's UI message chunks, numbered from 1, and the readers following them.
 * Chunk `seq` is `chunks[seq - 1]`; every reader receives each chunk as it is
 * appended, so several tabs can follow one turn.
 */
export class ChunkLog {
  private readonly readers = new Map<Reader, ReturnType<typeof setInterval>>();

  constructor(
    readonly chunks: Chunk[] = [],
    private ended = false,
    private readonly persist?: (seq: number, chunk: Chunk) => void,
  ) {}

  get isEnded() {
    return this.ended;
  }

  append(...chunks: Chunk[]) {
    if (this.ended) throw new Error('The turn has already ended.');
    for (const chunk of chunks) {
      this.chunks.push(chunk);
      const seq = this.chunks.length;
      this.persist?.(seq, chunk);
      for (const reader of this.readers.keys()) this.send(reader, frame(chunk, seq));
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const reader of [...this.readers.keys()]) {
      this.send(reader, DONE);
      this.detach(reader);
      try {
        reader.close();
      } catch {
        /* The reader already went away. */
      }
    }
  }

  /**
   * The UI message stream after `after`: `id: <seq>` + `data: <chunk>` frames,
   * then live chunks until the turn ends with `data: [DONE]`. An ended turn with
   * nothing after the cursor answers 204.
   */
  response(after: number): Response {
    if (this.ended && after >= this.chunks.length) return new Response(null, { status: 204 });
    let self: Reader;
    const stream = new ReadableStream<Uint8Array>({
      start: (reader) => {
        self = reader;
        for (let seq = after + 1; seq <= this.chunks.length; seq++)
          reader.enqueue(frame(this.chunks[seq - 1]!, seq));
        if (this.ended) {
          reader.enqueue(DONE);
          reader.close();
          return;
        }
        this.readers.set(
          reader,
          setInterval(() => this.send(reader, KEEPALIVE), KEEPALIVE_MS),
        );
      },
      cancel: () => this.detach(self),
    });
    return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
  }

  private send(reader: Reader, bytes: Uint8Array) {
    try {
      reader.enqueue(bytes);
    } catch {
      this.detach(reader);
    }
  }

  private detach(reader: Reader) {
    clearInterval(this.readers.get(reader));
    this.readers.delete(reader);
  }
}
