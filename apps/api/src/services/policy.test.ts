import { describe, expect, it } from 'vitest';
import { TurnProposals } from '../agent/interventions';
import { classifyTool, createMcpService } from './mcp';

describe('agent policy', () => {
  it('allows only one intervention per turn', () => {
    const proposals = new TurnProposals();
    expect(
      proposals.propose({ id: 'one', kind: 'record', text: 'A', reason: 'requested' }).accepted,
    ).toBe(true);
    expect(
      proposals.propose({ id: 'two', kind: 'record', text: 'B', reason: 'requested' }).accepted,
    ).toBe(false);
  });

  it('grounds annotations in exact source text', () => {
    const proposals = new TurnProposals();
    expect(
      proposals.annotate(
        { id: 'a', quote: 'exact words', kind: 'claim', whose: 'user' },
        'These are exact words.',
      ).accepted,
    ).toBe(true);
    expect(
      proposals.annotate(
        { id: 'b', quote: 'paraphrase', kind: 'claim', whose: 'user' },
        'These are exact words.',
      ).accepted,
    ).toBe(false);
  });
});

describe('MCP action policy', () => {
  it('requires confirmation for unknown and irreversible tools', () => {
    expect(classifyTool('missing', {}).confirmationRequired).toBe(true);
    expect(classifyTool('missing', {}).allowed).toBe(false);
    expect(classifyTool('read', { read: 'read-only' }).confirmationRequired).toBe(false);
    expect(classifyTool('write', { write: 'reversible' }).allowed).toBe(false);
  });

  it('exposes no fixture tools without configured MCP services', async () => {
    await expect(createMcpService({}).tools()).resolves.toEqual({});
  });
});
