import { z } from 'zod';

/** Null quotas are unlimited; null retention keeps conversations indefinitely. */
export const appPolicySchema = z
  .object({
    messages: z
      .object({
        limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        windowHours: z.number().finite().positive().max(876_000),
      })
      .strict(),
    uploads: z
      .object({
        maxBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
        maxFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      })
      .strict(),
    retention: z
      .object({ idleDays: z.number().finite().positive().max(365_000).nullable() })
      .strict(),
    features: z
      .object({
        mcp: z.boolean(),
        documentExtraction: z.boolean(),
        webResearch: z.boolean(),
        webSearch: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type AppPolicy = z.infer<typeof appPolicySchema>;
export const accountPolicySchema = z
  .object({ planId: z.string().min(1), policy: appPolicySchema })
  .strict();
export type AccountPolicy = z.infer<typeof accountPolicySchema>;
export const DEFAULT_APP_POLICY: AppPolicy = {
  messages: { limit: 20, windowHours: 4 },
  uploads: { maxBytes: 1_000_000, maxFiles: 5 },
  retention: { idleDays: 7 },
  features: { mcp: true, documentExtraction: true, webResearch: true, webSearch: true },
};
