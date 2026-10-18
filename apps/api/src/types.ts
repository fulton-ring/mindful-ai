import type { AccountPolicy } from '@walden/contracts';
import type { AppAuth } from './auth/better-auth';
import type { ChatTurn } from './chat/turns/turn-object';
import type { AppDatabase } from './db/database';
import type { NativeExecutionHost } from './execution/native-agent';
import type { EntitlementsProvider } from './policy';
import type { ResearchBrowser, SavedSources } from './services/research/ports';
import type { DocumentExtractor } from './storage/document-extractor';
import type { ObjectStore } from './storage/object-store';

export type Bindings = {
  DB: AppDatabase;
  CHAT_TURN?: DurableObjectNamespace<ChatTurn>;
  TURNS?: {
    get(turnId: string): {
      start(turnId: string): Promise<unknown>;
      stream(turnId: string, after: number): Promise<Response>;
      stop(turnId: string): Promise<boolean>;
    };
  };
  FILES?: ObjectStore;
  DOCUMENT_EXTRACTOR?: DocumentExtractor;
  RESEARCH_BROWSER?: ResearchBrowser;
  SAVED_SOURCES?: SavedSources;
  EXECUTION?: NativeExecutionHost;
  AUTH?: AppAuth;
  /** Optional hosted adapter. Self-hosting requires no billing configuration. */
  ENTITLEMENTS?: EntitlementsProvider;
  APP_POLICY_JSON?: string;
  APP_PLANS_JSON?: string;
  APP_DEFAULT_PLAN?: string;
  APP_ACCOUNT_PLANS_JSON?: string;
  AUTH_MODE?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  AUTH_ADMIN_SECRET?: string;
  APP_URL?: string;
  AI?: Ai;
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_BACKGROUND_MODEL?: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODELS_JSON?: string;
  WEB_SEARCH_MODEL?: string;
  OPENROUTER_SEARCH_MODEL?: string;
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
  /** Message points allowed per window (default 20). */
  MESSAGE_LIMIT?: string;
  /** Window length in hours (default 4). */
  MESSAGE_WINDOW_HOURS?: string;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
};

export type Variables = {
  userId: string;
  authSubject: string;
  accountPolicy?: AccountPolicy;
};
