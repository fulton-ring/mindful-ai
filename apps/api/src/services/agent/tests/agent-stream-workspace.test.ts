import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from '../../types';
import { createTurnWorkspace, includeRecentImage } from '../agent-stream';

const input = {
  ownerId: 'owner',
  conversation: { id: 'thread' },
} as AgentTurnInput;

describe('turn workspace', () => {
  it('omits the workspace when local R2 is unconfigured', () => {
    expect(createTurnWorkspace({}, input)).toBeUndefined();
  });

  it('supplies the most recent prior image as native model input on a follow-up', async () => {
    const imageId = '00112233-4455-6677-8899-aabbccddeeff';
    const get = vi.fn(async () => ({
      size: 3,
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { name: 'blue.png' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    }));
    const followup = {
      ...input,
      conversation: {
        id: 'thread',
        messages: [
          {
            role: 'user',
            attachments: [{ id: imageId, name: 'blue.png', mimeType: 'image/png', size: 3 }],
          },
        ],
      },
      attachments: [],
    } as unknown as AgentTurnInput;
    const result = await includeRecentImage({ FILES: { get } as unknown as R2Bucket }, followup);
    expect(result.attachments).toEqual([
      expect.objectContaining({ id: imageId, bytes: expect.any(Uint8Array) }),
    ]);
    expect(get).toHaveBeenCalledOnce();
  });
});
