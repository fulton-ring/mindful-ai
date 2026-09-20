/**
 * A readable thread name derived from the message that opened it.
 *
 * The title was previously the first 200 characters of the raw prompt, so
 * threads and their notes were named things like "Explain in about 400 words
 * why bridges have expansion joints, covering thermal expansion, mat…" - the
 * instruction scaffolding crowding out the subject. This keeps the user's own
 * words but drops the parts that describe the request rather than the topic.
 *
 * Deliberately deterministic: naming a thread should not depend on a model
 * call, cost a round trip, or have a failure mode.
 */

const MAX_TITLE = 60;

/** Directions about form rather than subject: "in about 400 words", "in three sentences". */
const LENGTH_DIRECTIVE =
  /\b(?:in|to|using|with)\s+(?:about|around|roughly|approximately|exactly|no more than|under|at most)?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:short\s+|numbered\s+|brief\s+)?(?:words?|sentences?|paragraphs?|bullets?|bullet points?|lines?|items?)\b,?\s*/giu;

/** Trailing housekeeping aimed at the assistant, not at the topic. */
const TRAILING_INSTRUCTION =
  /(?:^|[.!?]\s+)(?:(?:please\s+)?(?:do not|don't|never)\b[^.!?]*|(?:please\s+)?(?:reply|respond|answer|record|note|summari[sz]e|suggest|propose|keep|make|use|format|write)\b[^.!?]*)[.!?]?\s*$/iu;

/** Lead-ins that add no subject: "Can you explain …", "I want you to …". */
const LEAD_IN =
  /^(?:hey|hi|hello|ok(?:ay)?|so|now|please|could you|can you|would you|i(?:'d| would) like you to|i want you to|i need you to|help me)\b[\s,:-]*/iu;

export function conversationTitle(message: string): string {
  let text = message.replace(/\s+/gu, ' ').trim();
  if (!text) return 'New thread';

  // Strip trailing instructions repeatedly: prompts often stack two or three.
  for (let pass = 0; pass < 3; pass += 1) {
    const stripped = text.replace(TRAILING_INSTRUCTION, '').trim();
    if (stripped === text || !stripped) break;
    text = stripped;
  }
  text = text.replace(LENGTH_DIRECTIVE, ' ').replace(/\s+/gu, ' ').trim();
  text = text.replace(LEAD_IN, '').trim();
  if (!text) return message.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE) || 'New thread';

  // Prefer the first sentence when it already reads as a title.
  const sentence = text.match(/^[^.!?]+[.!?]?/u)?.[0]?.trim() ?? text;
  if (sentence.length <= MAX_TITLE) text = sentence;

  text = text.replace(/[\s,;:]+$/u, '');
  if (text.length <= MAX_TITLE) {
    const single = text.replace(/[.]$/u, '');
    return single.charAt(0).toUpperCase() + single.slice(1) || 'New thread';
  }

  // Truncate on a word boundary rather than mid-word.
  const clipped = text.slice(0, MAX_TITLE);
  const lastSpace = clipped.lastIndexOf(' ');
  const body = (lastSpace > MAX_TITLE * 0.5 ? clipped.slice(0, lastSpace) : clipped).replace(
    /[\s,;:.]+$/u,
    '',
  );
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}…`;
}
