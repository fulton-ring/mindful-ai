import { type Intervention, uiMessageText, type WaldenUIMessage } from '@walden/contracts';
import { z } from 'zod';
import { stableId } from './interventions';
import { learningCheckInputSchema, singleLearningCheckInputSchema } from './tool-schemas';

export function normalizeLearningCheck(
  input: z.infer<typeof learningCheckInputSchema> | z.infer<typeof singleLearningCheckInputSchema>,
  turnId: string,
): Intervention {
  const inputs =
    'questions' in input ? input.questions : [{ id: 'question', header: 'Question', ...input }];
  return {
    id: stableId('check', turnId, ...inputs.map(({ question }) => question)),
    kind: 'learning_check',
    questions: inputs.map((question, index) =>
      'options' in question
        ? {
            ...question,
            id: question.id ?? `question_${index + 1}`,
            header: question.header ?? `Question ${index + 1}`,
            format: 'multiple_choice' as const,
          }
        : {
            ...question,
            id: question.id ?? `question_${index + 1}`,
            header: question.header ?? `Question ${index + 1}`,
            format: 'short_answer' as const,
          },
    ),
  };
}

export const learningCheckIntervention = normalizeLearningCheck;

export type RecoveredFrontendToolCall = {
  name: 'proposeLearningCheck';
  input: z.infer<typeof learningCheckInputSchema> | z.infer<typeof singleLearningCheckInputSchema>;
};

const GEMMA_TOOL_MARKERS = ['proposeLearningCheck{'] as const;
const SENTINEL_QUOTE = '<|"|>';

function completeObjectEnd(value: string, openingBrace: number): number | null {
  let depth = 0;
  let sentinelString = false;
  let jsonString = false;
  let escaped = false;
  for (let index = openingBrace; index < value.length; index += 1) {
    if (!jsonString && value.startsWith(SENTINEL_QUOTE, index)) {
      sentinelString = !sentinelString;
      index += SENTINEL_QUOTE.length - 1;
      continue;
    }
    const character = value[index];
    if (!sentinelString && character === '"' && !escaped) jsonString = !jsonString;
    if (jsonString && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    escaped = false;
    if (sentinelString || jsonString) continue;
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index + 1;
  }
  return null;
}

function parseGemmaToolLeak(value: string): RecoveredFrontendToolCall | null {
  const marker = GEMMA_TOOL_MARKERS.find((candidate) => value.startsWith(candidate));
  if (!marker) return null;
  const name = marker.slice(0, -1) as RecoveredFrontendToolCall['name'];
  try {
    const json = value
      .slice(name.length)
      .replaceAll(SENTINEL_QUOTE, '"')
      .replace(/([{,]\s*)(id|header|question|questions|options)\s*:/gu, '$1"$2":');
    const parsed = JSON.parse(json) as unknown;
    const batch = learningCheckInputSchema.safeParse(parsed);
    if (batch.success) return { name, input: batch.data };
    const single = singleLearningCheckInputSchema.safeParse(parsed);
    return single.success ? { name, input: single.data } : null;
  } catch {
    return null;
  }
}

export class GemmaToolLeakDecoder {
  #buffer = '';

  push(chunk: string): { text: string; calls: RecoveredFrontendToolCall[] } {
    this.#buffer += chunk;
    let text = '';
    const calls: RecoveredFrontendToolCall[] = [];
    while (this.#buffer) {
      const positions = GEMMA_TOOL_MARKERS.map((marker) => this.#buffer.indexOf(marker)).filter(
        (index) => index >= 0,
      );
      const markerIndex = positions.length ? Math.min(...positions) : -1;
      if (markerIndex < 0) {
        const held = Math.max(
          0,
          ...GEMMA_TOOL_MARKERS.map((marker) => {
            for (
              let length = Math.min(marker.length - 1, this.#buffer.length);
              length > 0;
              length -= 1
            )
              if (this.#buffer.endsWith(marker.slice(0, length))) return length;
            return 0;
          }),
        );
        text += this.#buffer.slice(0, this.#buffer.length - held);
        this.#buffer = this.#buffer.slice(this.#buffer.length - held);
        break;
      }
      text += this.#buffer.slice(0, markerIndex);
      this.#buffer = this.#buffer.slice(markerIndex);
      const openingBrace = this.#buffer.indexOf('{');
      const end = completeObjectEnd(this.#buffer, openingBrace);
      if (end === null) break;
      const candidate = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end);
      const call = parseGemmaToolLeak(candidate);
      if (call) calls.push(call);
      else text += candidate;
    }
    return { text, calls };
  }

  finish(): string {
    const text = this.#buffer;
    this.#buffer = '';
    return text;
  }
}

export function recoveredFrontendIntervention(
  call: RecoveredFrontendToolCall,
  turnId: string,
  learningChecksEnabled: boolean,
): Intervention | null {
  if (!learningChecksEnabled) return null;
  return normalizeLearningCheck(call.input, turnId);
}

/** Recover only a complete quiz-shaped reply; this does not decide when to quiz. */
export function standaloneLearningCheck(text: string, turnId: string): Intervention | null {
  const lines = text
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let count = 4; count >= 2; count -= 1) {
    const questionIndex = lines.length - count - 1;
    if (questionIndex < 0 || questionIndex > 1 || !lines[questionIndex]?.endsWith('?')) continue;
    const options = lines.slice(questionIndex + 1).map((line, index) => {
      const match = /^([A-D1-4])[).]\s+(.+)$/u.exec(line);
      return match?.[1] === String.fromCharCode(65 + index) || match?.[1] === String(index + 1)
        ? match[2]
        : null;
    });
    if (options.some((option) => !option)) continue;
    const parsed = singleLearningCheckInputSchema.safeParse({
      question: lines[questionIndex],
      options,
    });
    if (!parsed.success) continue;
    return normalizeLearningCheck(parsed.data, turnId);
  }
  return null;
}

export function standaloneShortAnswerCheck(text: string, turnId: string): Intervention | null {
  const question = text.trim();
  if (question.includes('\n') || !question.endsWith('?')) return null;
  const parsed = singleLearningCheckInputSchema.safeParse({ question });
  return parsed.success ? normalizeLearningCheck(parsed.data, turnId) : null;
}

/**
 * A reply that was nothing but a quiz is shown as the quiz card, so its
 * duplicate text is not kept in the stored message.
 */
export function withoutQuizText(message: WaldenUIMessage): WaldenUIMessage {
  const check = message.parts.find(
    (part) => part.type === 'data-intervention' && part.data.kind === 'learning_check',
  );
  if (check?.type !== 'data-intervention') return message;
  if (!isQuizOnlyText(uiMessageText(message), check.data.id, message.id)) return message;
  return { ...message, parts: message.parts.filter((part) => part.type !== 'text') };
}

/** Whether a reply's text is nothing but the quiz its learning check `checkId` shows. */
export function isQuizOnlyText(text: string, checkId: string, turnId: string): boolean {
  const recovered =
    standaloneLearningCheck(text, turnId) ?? standaloneShortAnswerCheck(text, turnId);
  return recovered?.id === checkId;
}
