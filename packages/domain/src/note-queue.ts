import { additionEdit } from './markdown-placement';

export type QueuedAddition = {
  id: string;
  text: string;
  /** Already part of the note. Kept in the queue so the order the reader saw survives. */
  accepted?: boolean;
  /** Saved-note offset chosen when a streaming addition first appears. */
  at?: number;
};

/** Where one queued addition landed in the rendered note. */
type QueuedSpan = {
  id: string;
  from: number;
  to: number;
  /**
   * The offset in the *saved* note this addition inserts at. The editor maps
   * between the note and what it renders, so it needs to know where each
   * insertion belongs in the original text, not only where it ended up.
   */
  sourceFrom: number;
  /**
   * The text this addition actually puts into the note at `sourceFrom`, blank
   * lines included. The separators are not part of `from`..`to` — those bound
   * the addition's own text, which is what gets decorated — so anything mapping
   * between the note and what is rendered has to use this instead, or it lands
   * two characters short for every addition above it.
   */
  insert: string;
};

type RenderedNote = {
  /** The note as it reads with every queued addition applied, in order. */
  markdown: string;
  /** The text each addition contributed, so the reader can be shown what is pending. */
  spans: QueuedSpan[];
};

/**
 * A chunk as inserted, in rendered coordinates, including the blank line that
 * separates it from its neighbour. Source offsets are derived from these once
 * the whole queue is laid out, which is why this is not a QueuedSpan.
 */
type Entry = {
  id: string;
  from: number;
  to: number;
  editFrom: number;
  sourceFrom: number;
  insert: string;
  text: string;
};

/**
 * The text to insert at `at`, with blank lines only where they are needed.
 * Separators depend on what is actually on each side, which is why they are
 * decided here rather than baked into a stored edit: the same addition needs a
 * leading blank line when it follows something and a trailing one when it comes
 * first.
 */
function chunkAt(document: string, at: number, text: string): string {
  const before = document.slice(0, at);
  const after = document.slice(at);
  const lead = before.trim() && !before.endsWith('\n\n') ? '\n\n' : '';
  const tail = after.trim() && !after.startsWith('\n') ? '\n\n' : '';
  return `${lead}${text}${tail}`;
}

function renderedOffset(source: number, markdownLength: number, entries: readonly Entry[]): number {
  const at = Math.max(0, Math.min(source, markdownLength));
  return (
    at +
    entries
      .filter((entry) => entry.sourceFrom <= at)
      .reduce((total, entry) => total + entry.insert.length, 0)
  );
}

function savedOffset(rendered: number, markdownLength: number, entries: readonly Entry[]): number {
  const insertedBefore = entries
    .filter((entry) => entry.editFrom <= rendered)
    .reduce((total, entry) => total + entry.insert.length, 0);
  return Math.max(0, Math.min(rendered - insertedBefore, markdownLength));
}

function shiftLaterEntries(
  positions: Map<string, { start: number; end: number }>,
  entries: Entry[],
  at: number,
  length: number,
) {
  for (const [, position] of positions)
    if (position.start >= at) {
      position.start += length;
      position.end += length;
    }
  for (const entry of entries)
    if (entry.editFrom >= at) {
      entry.editFrom += length;
      entry.from += length;
      entry.to += length;
    }
}

/**
 * Lay the whole queue into the note at once.
 *
 * Each addition is placed into the document *including the ones before it*, so
 * the queue is positioned as a whole rather than as N independent answers the
 * client then has to reconcile. Items already accepted stay in the queue,
 * marked, and act as fixed points: a pending addition is kept after the sibling
 * before it and before the sibling after it, so taking one out of order cannot
 * reshuffle what the reader saw. Within those bounds, placement is semantic.
 *
 * Deterministic, so a preview and the edit that follows it cannot disagree.
 */
function render(
  markdown: string,
  queue: readonly QueuedAddition[],
): { markdown: string; entries: Entry[] } {
  let document = markdown;
  // Every queued item is laid out, including one whose text has not arrived
  // yet: it still gets a span, so the reader sees that something is pending
  // there rather than nothing at all.
  const items = [...queue];
  // Where each item sits in the document as it currently stands.
  const positions = new Map<string, { start: number; end: number }>();
  for (const item of items)
    if (item.accepted && item.text) {
      const at = document.indexOf(item.text);
      if (at >= 0) positions.set(item.id, { start: at, end: at + item.text.length });
    }

  const entries: Entry[] = [];
  items.forEach((item, index) => {
    if (item.accepted) return;
    const before = items
      .slice(0, index)
      .reverse()
      .map((sibling) => positions.get(sibling.id))
      .find(Boolean);
    const after = items
      .slice(index + 1)
      .map((sibling) => positions.get(sibling.id))
      .find(Boolean);
    const lower = before?.end ?? 0;
    const upper = after?.start ?? document.length;

    const placed = additionEdit(document, item.text);
    const pinned =
      item.at === undefined ? placed.from : renderedOffset(item.at, markdown.length, entries);
    const at = Math.min(Math.max(pinned, lower), Math.max(upper, lower));
    const sourceFrom = savedOffset(at, markdown.length, entries);
    const insert = item.text ? chunkAt(document, at, item.text) : '';
    const length = insert.length;

    shiftLaterEntries(positions, entries, at, length);

    // Find the text inside the chunk rather than assuming where it sits: the
    // blank line goes before it when it follows something and after it when it
    // comes first, and guessing put every span two characters out — enough to
    // render a suggestion's controls against the wrong line.
    const textFrom = at + insert.indexOf(item.text);
    entries.push({
      id: item.id,
      from: textFrom,
      to: textFrom + item.text.length,
      editFrom: at,
      sourceFrom,
      insert,
      text: item.text,
    });
    positions.set(item.id, { start: textFrom, end: textFrom + item.text.length });
    document = document.slice(0, at) + insert + document.slice(at);
  });
  return { markdown: document, entries };
}

export function renderWithQueue(markdown: string, queue: readonly QueuedAddition[]): RenderedNote {
  const { markdown: rendered, entries } = render(markdown, queue);
  return {
    markdown: rendered,
    spans: entries.map((entry) => ({
      id: entry.id,
      from: entry.from,
      to: entry.to,
      insert: entry.insert,
      // Back to saved-note coordinates: drop the chunks inserted before it.
      sourceFrom: entry.sourceFrom,
    })),
  };
}

/**
 * The edit that accepting one queued addition makes to the note.
 *
 * It lands exactly where the reader saw it: the queue is rendered, then every
 * chunk except this one is taken back out, which leaves the note plus this
 * addition at the position the preview showed. Accepting out of order therefore
 * cannot move it, and the additions still pending keep their relative order.
 */
export function acceptQueueEdit(
  markdown: string,
  queue: readonly QueuedAddition[],
  id: string,
): { from: number; to: number; insert: string } | null {
  const { entries } = render(markdown, queue);
  const accepted = entries.find((entry) => entry.id === id);
  if (!accepted) return null;
  // Map back to the saved note by removing the chunks that precede it.
  const shift = entries
    .filter((entry) => entry.id !== id && entry.editFrom < accepted.editFrom)
    .reduce((total, entry) => total + entry.insert.length, 0);
  const from = accepted.editFrom - shift;
  // Separators belonged to the render, where siblings surrounded it. Once those
  // are taken back out they may not be needed, so they are decided again
  // against the note this edit actually lands in.
  return { from, to: from, insert: chunkAt(markdown, from, accepted.text) };
}

/**
 * The single insertion that turns `before` into `after`, or null when the
 * difference is anything else.
 *
 * Used to check that a note submitted with an accepted suggestion really is the
 * note plus that suggestion, and nothing more.
 */
export function soleInsertion(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (after.length <= before.length) return null;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  if (prefix + suffix !== before.length) return null;
  return { from: prefix, to: prefix, insert: after.slice(prefix, after.length - suffix) };
}

/** Shift pending saved-note anchors past an accepted insertion. */
export function rebaseQueueAfterAcceptance<T extends QueuedAddition>(
  before: string,
  after: string,
  queue: readonly T[],
  acceptedId: string,
): T[] {
  const insertion = soleInsertion(before, after);
  if (!insertion) return [...queue];
  const acceptedIndex = queue.findIndex((item) => item.id === acceptedId);
  return queue.map((item, index) => {
    if (item.accepted || item.id === acceptedId || item.at === undefined) return item;
    const followsInsertion =
      item.at > insertion.from ||
      (item.at === insertion.from && acceptedIndex >= 0 && index > acceptedIndex);
    return followsInsertion ? { ...item, at: item.at + insertion.insert.length } : item;
  });
}

/**
 * The smallest single change that turns `before` into `after`: the differing
 * middle, with the shared prefix and suffix left alone.
 *
 * The editor used to hand CodeMirror a whole-document replacement whenever the
 * pending suggestions changed shape. Replacing every character moves the
 * caret — so typing next to a suggestion put the first letter in one place and
 * the rest somewhere else. Touching only what changed keeps the selection where
 * the reader left it.
 */
export function minimalEdit(
  before: string,
  after: string,
): { from: number; to: number; insert: string } {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}
