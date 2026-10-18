import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createTool } from '@mastra/core/tools';
import type { Conversation } from '@walden/contracts';
import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import { compactAgentMemory } from './memory/memory';

type CompactToolOptions = {
  db: AppDatabase;
  ownerId: string;
  conversation: Conversation;
  /** The default fast model; summaries never use the persona's model. */
  model: LanguageModelV3;
  signal: AbortSignal;
};

/** Lets the model summarize the older conversation now, rather than wait for the threshold. */
export function createCompactTools({
  db,
  ownerId,
  conversation,
  model,
  signal,
}: CompactToolOptions) {
  let used = false;
  return {
    compactConversation: createTool({
      id: 'compact_conversation',
      description:
        'Summarize the older part of this conversation into memory now, so later messages carry a compact summary instead of the full transcript. Use it when the conversation has moved on from earlier material, when the user asks to start fresh or to focus on something, or when context is large. The most recent messages always stay word for word. Takes effect from the next message. Pass focus to say what the summary must keep.',
      inputSchema: z.object({ focus: z.string().trim().max(300).optional() }),
      execute: async ({ focus }) => {
        if (used) throw new Error('The conversation was already compacted in this reply.');
        used = true;
        return compactAgentMemory(db, ownerId, conversation, { model, signal, focus });
      },
    }),
  };
}
