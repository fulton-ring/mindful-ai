export type Bindings = {
  DB: D1Database;
  CHAT_WORKFLOW?: Workflow<{ turnId: string }>;
  FILES?: R2Bucket;
  AI?: Ai;
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  UPLOAD_LOCAL_FALLBACK?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  MCP_SERVER_URL?: string;
  MCP_SERVER_TOKEN?: string;
  MCP_ALLOWED_TOOLS?: string;
  MCP_TOOL_EFFECTS?: string;
  /** Messages allowed per sliding window (default 20). */
  MESSAGE_LIMIT?: string;
  /** Sliding window length in hours (default 4). */
  MESSAGE_WINDOW_HOURS?: string;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
};

export type Variables = {
  userId: string;
  authSubject: string;
};
