import { DEFAULT_PERSONAS } from '@walden/contracts';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentTurnInput, ServiceEnv } from '../../types';

const mocks = vi.hoisted(() => ({ policy: vi.fn(), stream: vi.fn(), listTools: vi.fn() }));
vi.mock('../../../policy', () => ({ getAccountPolicy: mocks.policy }));
vi.mock('../../../agent/mastra-turn', () => ({ streamMastraTurn: mocks.stream }));
vi.mock('@mastra/mcp', () => ({
  MCPClient: class {
    listTools = mocks.listTools;
  },
}));

import { streamTurnChunks } from '../agent-stream';

const enabled = { mcp: true, documentExtraction: true, webResearch: true, webSearch: true };
const families = {
  mcp: ['safe_read'],
  documentExtraction: ['extractDocument'],
  webResearch: ['readWebPage', 'searchSources', 'listWebLinks', 'screenshotWebPage'],
  webSearch: ['searchWeb'],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.policy.mockResolvedValue({ planId: 'default', policy: { features: enabled } });
  mocks.listTools.mockResolvedValue({ safe_read: {}, unsafe_write: {}, unlisted: {} });
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'text-delta', id: 'reply', delta: 'Answer' };
  });
});
function fixture() {
  const input = {
    ownerId: 'trusted-owner',
    turnId: 'turn',
    requestId: 'request',
    note: null,
    persona: DEFAULT_PERSONAS[0]!,
    message: 'Read https://example.com/',
    conversation: {
      id: 'thread',
      title: 'Title',
      noteId: null,
      messages: [],
      branchId: 'branch',
      branches: [],
      learningChecksEnabled: true,
      expiresAt: '2999-01-01',
    },
    attachments: [
      {
        id: '00112233-4455-6677-8899-aabbccddeeff',
        name: 'notes.pdf',
        mimeType: 'application/pdf',
        size: 1,
        bytes: new Uint8Array([1]),
      },
    ],
  } as AgentTurnInput;
  const env = {
    FILES: { get: vi.fn() },
    DOCUMENT_EXTRACTOR: { extract: vi.fn() },
    RESEARCH_BROWSER: { readMarkdown: vi.fn(), listVisibleLinks: vi.fn(), screenshot: vi.fn() },
    SAVED_SOURCES: { upsert: vi.fn(), search: vi.fn(), deleteOwner: vi.fn() },
    OPENROUTER_API_KEY: 'configured-search-provider',
    MCP_SERVER_URL: 'https://example.com/mcp',
    MCP_ALLOWED_TOOLS: 'safe_read,unsafe_write',
    MCP_TOOL_EFFECTS: JSON.stringify({
      safe_read: 'read-only',
      unsafe_write: 'reversible',
      unlisted: 'read-only',
    }),
  } as unknown as ServiceEnv;
  return { input, env };
}
async function run(env: ServiceEnv, input: AgentTurnInput) {
  for await (const _event of streamTurnChunks({
    env,
    input,
    modelName: 'fixture',
    model: {} as never,
    memoryModel: {} as never,
    signal: new AbortController().signal,
  })) {
    /* Drain the real tool assembly. */
  }
  return mocks.stream.mock.calls.at(-1)?.[0] as {
    tools: Record<string, unknown>;
    runtime: { workspace?: unknown };
  };
}

it('resolves one trusted account policy and retains configured read-only tools by default', async () => {
  const { env, input } = fixture();
  const result = await run(env, input);
  expect(mocks.policy).toHaveBeenCalledExactlyOnceWith(env, 'trusted-owner');
  expect(Object.keys(result.tools).sort()).toEqual(Object.values(families).flat().sort());
  expect(mocks.listTools).toHaveBeenCalledOnce();
  expect(result.tools).not.toHaveProperty('unsafe_write');
  expect(result.tools).not.toHaveProperty('unlisted');
});

it.each(Object.keys(families) as Array<keyof typeof families>)(
  'omits denied %s tools before discovery and preserves the other features',
  async (feature) => {
    const { env, input } = fixture();
    mocks.policy.mockResolvedValue({
      planId: 'limited',
      policy: { features: { ...enabled, [feature]: false } },
    });
    if (feature === 'mcp') env.MCP_SERVER_URL = 'https://127.0.0.1/private';
    const { tools } = await run(env, input);
    for (const name of families[feature]) expect(tools).not.toHaveProperty(name);
    for (const [name, members] of Object.entries(families))
      if (name !== feature) for (const member of members) expect(tools).toHaveProperty(member);
    expect(mocks.listTools).toHaveBeenCalledTimes(feature === 'mcp' ? 0 : 1);
  },
);

it('does not grant tools for missing physical capabilities when policy allows them', async () => {
  const { input } = fixture();
  expect((await run({}, input)).tools).toEqual({});
  expect(mocks.listTools).not.toHaveBeenCalled();
});

it('keeps accepted files readable through the workspace when document extraction is denied', async () => {
  const { env, input } = fixture();
  mocks.policy.mockResolvedValue({
    planId: 'limited',
    policy: { features: { ...enabled, documentExtraction: false } },
  });
  const result = await run(env, input);
  expect(result.runtime.workspace).toBeDefined();
  expect(result.tools).not.toHaveProperty('extractDocument');
});

it('respects the conversation web-search preference even when the plan permits search', async () => {
  const { env, input } = fixture();
  input.conversation.webSearchEnabled = false;
  const { tools } = await run(env, input);
  expect(tools).not.toHaveProperty('searchWeb');
  expect(tools).toHaveProperty('readWebPage');
});

it('fails closed on policy resolution failure without starting MCP discovery or a model stream', async () => {
  const { env, input } = fixture();
  mocks.policy.mockRejectedValue(new Error('Unknown account plan'));
  await expect(run(env, input)).rejects.toThrow('Unknown account plan');
  expect(mocks.listTools).not.toHaveBeenCalled();
  expect(mocks.stream).not.toHaveBeenCalled();
});

it('rejects unowned tool assembly instead of resolving default entitlements', async () => {
  const { env, input } = fixture();
  delete input.ownerId;
  await expect(run(env, input)).rejects.toThrow(/account|owner/i);
  expect(mocks.policy).not.toHaveBeenCalled();
  expect(mocks.listTools).not.toHaveBeenCalled();
});

it('resolves features separately for each trusted owner instead of reusing another account policy', async () => {
  const { env, input } = fixture();
  mocks.policy.mockImplementation(async (_env: ServiceEnv, ownerId: string) => ({
    planId: ownerId,
    policy: {
      features: {
        mcp: false,
        documentExtraction: false,
        webResearch: false,
        webSearch: ownerId === 'search-owner',
      },
    },
  }));
  expect((await run(env, input)).tools).toEqual({});
  expect(Object.keys((await run(env, { ...input, ownerId: 'search-owner' })).tools)).toEqual([
    'searchWeb',
  ]);
  expect(mocks.policy.mock.calls.map((call) => call[1])).toEqual(['trusted-owner', 'search-owner']);
});
