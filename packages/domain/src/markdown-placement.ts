type MarkdownBlock = { id: number; start: number; end: number; text: string };

export const markdownBlocks = (markdown: string): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = [];
  let start: number | null = null;
  let end = 0;
  for (const match of markdown.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const line = match[0].endsWith('\n') ? match[0].slice(0, -1) : match[0];
    if (line.trim()) {
      start ??= match.index;
      end = match.index + line.length;
    } else if (start !== null) {
      blocks.push({ id: blocks.length, start, end, text: markdown.slice(start, end) });
      start = null;
    }
  }
  if (start !== null)
    blocks.push({ id: blocks.length, start, end, text: markdown.slice(start, end) });
  return blocks;
};

/**
 * Words that carry no identifying content. A candidate note addition is only
 * treated as redundant when its *meaningful* words are already present, so
 * these are dropped before comparing.
 */
const STOP_WORDS = new Set(
  `a an the and or but of to in on at for from by with as into than then so if not no do does did
   is are was were be been being will would shall should can could may might must have has had
   i me my we us our you your he him his she her it its they them their this that these those
   there here what which who whom when where why how all any both each few more most other some
   such only own same too very just also about after before over under again further once`.split(
    /\s+/u,
  ),
);

/**
 * Coarse stem so that "ships"/"ship", "capped"/"cap" and "running"/"run"
 * compare equal. This is deliberately crude: it only has to be good enough to
 * recognise the same fact restated, and it must never depend on a model.
 */
const stem = (word: string) =>
  word.replace(/(?:ing|ed|es|s)$/u, '').replace(/([bcdfghjklmnpqrstvwxz])\1$/u, '$1');

/** Meaningful word stems in a fragment of Markdown, ignoring list/heading syntax. */
const significantStems = (text: string): Set<string> => {
  const stems = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word || STOP_WORDS.has(word)) continue;
    const stemmed = stem(word);
    if (stemmed) stems.add(stemmed);
  }
  return stems;
};

/**
 * True when `addition` says nothing that `existing` does not already say.
 *
 * Deliberately conservative: it requires *every* meaningful stem of the
 * addition to already be present, so "beta ships March 21" is still a real
 * addition next to "beta ships March 14" (the number differs), while
 * "Beta ships March 14, pilot capped at 50 users" is redundant next to
 * "Team will ship the beta on March 14 and cap the pilot at 50 users."
 */
export function isRedundantAddition(existing: string, addition: string): boolean {
  const added = significantStems(addition);
  if (added.size < 2) return false;
  const present = significantStems(existing);
  for (const word of added) if (!present.has(word)) return false;
  return true;
}

const HEADING = /^(#{1,6})[ \t]+\S/u;

/** Heading level of a block, or 0 when it is not a heading. */
const headingLevel = (text: string) => HEADING.exec(text)?.[1]?.length ?? 0;

/**
 * Where an addition goes in the note *right now*, as a zero-width insertion.
 *
 * Additions carry no anchor. They used to: a proposal stored the exact oldText
 * it was written against plus the markdown it was based on, and all of it went
 * stale the moment the note changed — which is why empty notes needed a special
 * insertion mode, why pending suggestions had to be rebased and checked for
 * conflicts, and why a reader could be told to retry an edit they had already
 * reviewed.
 *
 * An addition inserts; it does not rewrite anything. Returning a zero-width
 * edit says exactly that, and two additions can therefore never conflict, even
 * when they land beside the same paragraph. Placement is deterministic and
 * costs nothing, so it is simply recomputed whenever it is needed: preview and
 * apply run this over the same markdown and agree, and when the note has moved
 * on the text lands where it belongs in the note as it actually is.
 */
export function additionEdit(
  markdown: string,
  text: string,
): { from: number; to: number; insert: string } {
  const blocks = markdownBlocks(markdown);
  if (!blocks.length || !text.trim())
    return { from: markdown.length, to: markdown.length, insert: text };

  const added = significantStems(text);
  let bestId = blocks.length - 1;
  let bestScore = 0;
  for (const block of blocks) {
    const stems = significantStems(block.text);
    let score = 0;
    for (const word of added) if (stems.has(word)) score += 1;
    // Later blocks win ties: a note is read top to bottom, and the most recent
    // matching material is the likelier place to continue.
    if (score >= bestScore && score > 0) {
      bestScore = score;
      bestId = block.id;
    }
  }

  // Filing under a heading means after everything already in that section, not
  // wedged between the heading and its first line.
  const level = headingLevel(blocks[bestId]!.text);
  let target = bestId;
  if (level > 0)
    while (target + 1 < blocks.length) {
      const next = headingLevel(blocks[target + 1]!.text);
      if (next > 0 && next <= level) break;
      target += 1;
    }
  const at = blocks[target]!.end;
  return { from: at, to: at, insert: `\n\n${text}` };
}
