import { describe, expect, it, vi } from 'vitest';
import { TurnProposals } from '../../agent/interventions';
import { createMcpService } from '../mcp';

const listTools = vi.hoisted(() => vi.fn());
vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    listTools = listTools;
  },
}));

describe('agent policy', () => {
  it('allows only one intervention per turn', () => {
    const proposals = new TurnProposals();
    expect(
      proposals.propose({
        id: 'one',
        kind: 'learning_check',
        questions: [{ id: 'q', header: 'Q', format: 'short_answer', question: 'Why A?' }],
      }).accepted,
    ).toBe(true);
    expect(
      proposals.propose({
        id: 'two',
        kind: 'learning_check',
        questions: [{ id: 'q', header: 'Q', format: 'short_answer', question: 'Why B?' }],
      }).accepted,
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

describe('MCP tool policy', () => {
  it('exposes no fixture tools without configured MCP services', async () => {
    await expect(createMcpService({}).tools()).resolves.toEqual({});
  });

  it('exposes only allowlisted tools classified as read-only', async () => {
    const tools = { read: {}, write: {}, unlisted: {}, unknown: {} };
    listTools.mockResolvedValueOnce(tools);
    await expect(
      createMcpService({
        MCP_SERVER_URL: 'https://example.com/mcp',
        MCP_ALLOWED_TOOLS: 'read,write,unknown',
        MCP_TOOL_EFFECTS: JSON.stringify({
          read: 'read-only',
          write: 'reversible',
          unlisted: 'read-only',
        }),
      }).tools(),
    ).resolves.toEqual({ read: tools.read });
  });

  it('rejects private MCP endpoints before connecting', async () => {
    await expect(
      createMcpService({ MCP_SERVER_URL: 'https://127.0.0.1/mcp' }).tools(),
    ).rejects.toThrow('Private-network MCP endpoints are not allowed.');
  });
});
