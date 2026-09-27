import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { LoadedAttachment } from '../chat/attachments/attachments';
import {
  attachmentKey,
  attachmentWorkspacePath,
  DOCUMENT_TYPES,
} from '../chat/attachments/attachments';
import type { McpTools } from '../services/mcp';
import type { AgentTurnInput, ServiceEnv } from '../services/types';

type DocumentFile = Pick<LoadedAttachment, 'id' | 'name' | 'mimeType'>;

function isDocumentFile(file: DocumentFile): boolean {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return Boolean(extension && DOCUMENT_TYPES[extension] === file.mimeType);
}

async function extractDocumentMarkdown(
  env: Pick<ServiceEnv, 'FILES' | 'AI'>,
  ownerId: string,
  conversationId: string,
  file: DocumentFile,
) {
  if (!env.FILES || !env.AI) throw new Error('Document extraction is unavailable.');
  const sidecarKey = attachmentKey(ownerId, conversationId, `${file.id}.md`);
  const path = `${attachmentWorkspacePath(file.id, file.name)}.md`;
  const cached = await env.FILES.get(sidecarKey);
  if (cached)
    return { path, text: new TextDecoder().decode(await cached.arrayBuffer()), cached: true };
  const original = await env.FILES.get(attachmentKey(ownerId, conversationId, file.id));
  if (!original) throw new Error(`Attached document "${file.name}" is unavailable.`);
  const bytes = await original.arrayBuffer();
  const conversion = await env.AI.toMarkdown({
    name: file.name,
    blob: new Blob([bytes], { type: file.mimeType }),
  });
  if (conversion.format === 'error' || !conversion.data)
    throw new Error(`Could not extract text from "${file.name}".`);
  await env.FILES.put(sidecarKey, conversion.data, {
    httpMetadata: { contentType: 'text/markdown' },
    customMetadata: { name: `${file.name}.md` },
  });
  return { path, text: conversion.data, tokens: conversion.tokens };
}

export function createDocumentTools(env: ServiceEnv, input: AgentTurnInput): McpTools {
  if (!env.FILES || !input.ownerId) return {};
  const files = [
    ...input.conversation.messages.flatMap((message) => message.attachments ?? []),
    ...(input.attachments ?? []),
  ];
  const documents = new Map(
    files
      .filter(isDocumentFile)
      .map((file) => [attachmentWorkspacePath(file.id, file.name), file] as const),
  );
  if (documents.size === 0) return {};
  const ownerId = input.ownerId;
  const conversationId = input.conversation.id;
  return {
    extractDocument: createTool({
      id: 'extract_document',
      description:
        'Convert an attached PDF, DOCX, or XLSX into searchable Markdown. Returns the Markdown workspace path; use workspace read file or grep to inspect it.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const file = documents.get(path);
        if (!file) throw new Error('Document is not attached to this thread.');
        const result = await extractDocumentMarkdown(env, ownerId, conversationId, file);
        return result.cached
          ? { path: result.path, cached: true }
          : { path: result.path, tokens: result.tokens };
      },
    }),
  };
}
