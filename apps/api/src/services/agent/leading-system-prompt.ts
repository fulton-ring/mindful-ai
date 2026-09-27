import type { LanguageModelV3Middleware, LanguageModelV3Prompt } from '@ai-sdk/provider';

/**
 * Persona instructions, note context, and memory each add a system message, some
 * after the history. Chat templates such as Qwen's accept exactly one, first, and
 * reject anything else with "System message must be at the beginning."
 */
export function leadingSystemPrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  const system = prompt.flatMap((message) => (message.role === 'system' ? [message.content] : []));
  if (system.length === 0 || (system.length === 1 && prompt[0]?.role === 'system')) return prompt;
  return [
    { role: 'system', content: system.join('\n\n') },
    ...prompt.filter((message) => message.role !== 'system'),
  ];
}

export const leadingSystemPromptMiddleware: LanguageModelV3Middleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => ({
    ...params,
    prompt: leadingSystemPrompt(params.prompt),
  }),
};
