import { describe, expect, it } from 'vitest';
import type { AgentTurnInput } from '../../types';
import { createTurnWorkspace } from '../agent-stream';

const input = {
  ownerId: 'owner',
  conversation: { id: 'thread' },
} as AgentTurnInput;

describe('turn workspace', () => {
  it('omits the workspace when local R2 is unconfigured', () => {
    expect(createTurnWorkspace({}, input)).toBeUndefined();
  });
});
