import { MCPClient } from '@mastra/mcp';
import type { ServiceEnv } from './types';

export type ToolEffect = 'read-only' | 'reversible' | 'irreversible' | 'unknown';
export type ToolDecision = {
  effect: ToolEffect;
  confirmationRequired: boolean;
  allowed: boolean;
  reason: string;
};
export type McpTools = Awaited<ReturnType<MCPClient['listTools']>>;

export function classifyTool(
  toolName: string,
  configured: Record<string, ToolEffect>,
): ToolDecision {
  const effect = configured[toolName] ?? 'unknown';
  if (effect === 'read-only')
    return {
      effect,
      confirmationRequired: false,
      allowed: true,
      reason: 'Operator-classified read-only tool.',
    };
  if (effect === 'reversible')
    return {
      effect,
      confirmationRequired: false,
      allowed: false,
      reason:
        'Reversible execution is not supported in V1 because compensation is not implemented.',
    };
  return {
    effect,
    confirmationRequired: true,
    allowed: false,
    reason:
      effect === 'unknown'
        ? 'Unknown-effect execution is not supported in V1.'
        : 'Irreversible execution is not supported in V1.',
  };
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('MCP endpoint must use HTTPS.');
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
    throw new Error('Private-network MCP endpoints are not allowed.');
  return url;
}
function effects(env: ServiceEnv): Record<string, ToolEffect> {
  if (!env.MCP_TOOL_EFFECTS) return {};
  try {
    return JSON.parse(env.MCP_TOOL_EFFECTS) as Record<string, ToolEffect>;
  } catch {
    throw new Error('MCP_TOOL_EFFECTS must be a JSON object.');
  }
}

export function createMcpService(env: ServiceEnv) {
  const allowed = new Set(
    (env.MCP_ALLOWED_TOOLS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const configuredEffects = effects(env);
  return {
    configured: Boolean(env.MCP_SERVER_URL),
    classify: (toolName: string) => classifyTool(toolName, configuredEffects),
    async tools(): Promise<McpTools> {
      if (!env.MCP_SERVER_URL) return {};
      const serverUrl = endpoint(env.MCP_SERVER_URL);
      const client = new MCPClient({
        servers: {
          walden: {
            url: serverUrl,
            fetch: async (target: RequestInfo | URL, init?: RequestInit) => {
              endpoint(String(target));
              const headers = new Headers(init?.headers);
              if (env.MCP_SERVER_TOKEN)
                headers.set('Authorization', `Bearer ${env.MCP_SERVER_TOKEN}`);
              const response = await fetch(target, { ...init, headers, redirect: 'manual' });
              if (response.status >= 300 && response.status < 400)
                throw new Error('MCP redirects are disabled.');
              return response;
            },
          },
        },
      });
      const tools = await client.listTools();
      return Object.fromEntries(
        Object.entries(tools).filter(
          ([name]) =>
            allowed.has(name) && classifyTool(name, configuredEffects).effect === 'read-only',
        ),
      );
    },
  };
}
