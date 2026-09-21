# Lint Clean Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Biome complexity and size diagnostic by giving each module one focused responsibility while preserving Walden's current behavior.

**Architecture:** Keep public routes, component exports, and contract shapes stable. Move orchestration into small hooks and service modules; move rendering into focused components; move fixtures and scenario assertions into test helpers and feature-specific test files. Enable the existing Biome limits as errors only after the repository reports zero diagnostics.

**Tech Stack:** TypeScript, React, Hono, Mastra, Vitest, Biome.

---

### Task 1: Establish a measurable lint baseline

**Files:**
- Modify: `biome.json`
- Create: `docs/superpowers/plans/2026-09-21-lint-clean-architecture.md`

- [ ] **Step 1: Capture diagnostics by file and rule**

Run: `NO_COLOR=1 pnpm exec biome ci --reporter=json . > /tmp/walden-biome.json`

Expected: JSON reports 169 warnings grouped under `noExcessiveLinesPerFunction`, `noExcessiveCognitiveComplexity`, and `noExcessiveLinesPerFile`.

- [ ] **Step 2: Keep limits enabled while refactoring**

Do not suppress diagnostics with ignores, widen limits, or disable rules. The final configuration changes each configured level from `warn` to `error` only after the source tree passes unchanged limits.

- [ ] **Step 3: Verify the baseline report remains machine-readable**

Run: `NO_COLOR=1 pnpm exec biome ci --reporter=json .`

Expected: JSON output can be parsed without ANSI control codes.

### Task 2: Split client application orchestration

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/app/use-conversation-data.ts`
- Create: `apps/web/src/app/use-persona-data.ts`
- Create: `apps/web/src/app/AppRoutes.tsx`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/App.proposals.test.tsx`

- [ ] **Step 1: Add a failing route composition test**

```tsx
it('renders the active note route without mounting the chat panel', () => {
  render(<AppRoutes route={{ kind: 'note', noteId: 'note-1' }} />);
  expect(screen.getByRole('main', { name: 'Note' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Thread' })).toBeNull();
});
```

- [ ] **Step 2: Run the targeted test**

Run: `pnpm --filter @walden/web test -- App.test.ts`

Expected: FAIL because route composition is still owned by `App`.

- [ ] **Step 3: Move data loading and route rendering behind named boundaries**

`use-conversation-data.ts` owns conversation queries and mutations. `use-persona-data.ts` owns persona queries and mutations. `AppRoutes.tsx` selects the current page and receives already-resolved callbacks as props. `App.tsx` only composes providers, the sidebar, and these hooks.

- [ ] **Step 4: Run application tests**

Run: `pnpm --filter @walden/web test -- App.test.ts App.proposals.test.tsx`

Expected: PASS.

### Task 3: Split chat presentation from chat transport

**Files:**
- Modify: `apps/web/src/features/chat/ChatPanel.tsx`
- Create: `apps/web/src/features/chat/use-chat-turn.ts`
- Create: `apps/web/src/features/chat/use-message-actions.ts`
- Create: `apps/web/src/features/chat/ChatTranscript.tsx`
- Create: `apps/web/src/features/chat/ChatComposer.tsx`
- Create: `apps/web/src/features/chat/ChatToolsMenu.tsx`
- Modify: `apps/web/src/features/chat/ChatPanel.test.tsx`
- Create: `apps/web/src/features/chat/ChatTranscript.test.tsx`
- Create: `apps/web/src/features/chat/ChatComposer.test.tsx`

- [ ] **Step 1: Add a failing transcript test for persisted learning checks**

```tsx
it('renders a learning check, structured answers, and later feedback in order', () => {
  render(<ChatTranscript messages={quizConversation.messages} />);
  expect(screen.getByLabelText('Learning check')).toBeTruthy();
  expect(screen.getByText('My answers')).toBeTruthy();
  expect(screen.getByText('You got both correct!')).toBeTruthy();
});
```

- [ ] **Step 2: Run the targeted test**

Run: `pnpm --filter @walden/web test -- ChatTranscript.test.tsx`

Expected: FAIL because the transcript is embedded in `ChatPanel`.

- [ ] **Step 3: Extract stable units**

`use-chat-turn.ts` owns stream lifecycle, optimistic messages, cancellation, and event reduction. `use-message-actions.ts` owns edit, regenerate, capture, highlights, and proposal operations. `ChatTranscript.tsx` owns only ordered message rendering. `ChatComposer.tsx` owns message entry and send affordances. `ChatToolsMenu.tsx` owns per-thread preference controls. `ChatPanel.tsx` only wires these units together.

- [ ] **Step 4: Run chat tests**

Run: `pnpm --filter @walden/web test -- ChatPanel.test.tsx ChatTranscript.test.tsx ChatComposer.test.tsx`

Expected: PASS with no Biome diagnostic from `ChatPanel.tsx`.

### Task 4: Split note and highlight rendering pipelines

**Files:**
- Modify: `apps/web/src/features/notes/NotesEditor.tsx`
- Create: `apps/web/src/features/notes/use-note-editor.ts`
- Create: `apps/web/src/features/notes/NoteSuggestionList.tsx`
- Modify: `apps/web/src/features/highlights/AnnotatedText.tsx`
- Create: `apps/web/src/features/highlights/use-annotation-selection.ts`
- Create: `apps/web/src/features/highlights/AnnotationActions.tsx`
- Modify: corresponding `*.test.tsx` files

- [ ] **Step 1: Add focused tests for proposal rendering and selection actions**

```tsx
it('keeps a rejected suggestion out of the editor value', () => {
  render(<NoteSuggestionList suggestions={[rejectedSuggestion]} />);
  expect(screen.queryByText(rejectedSuggestion.newText)).toBeNull();
});
```

```tsx
it('opens annotation actions for a completed assistant response', () => {
  render(<AnnotationActions message={completedMessage} selection={selection} />);
  expect(screen.getByRole('button', { name: 'Capture' })).toBeTruthy();
});
```

- [ ] **Step 2: Run focused tests and confirm they fail before extraction**

Run: `pnpm --filter @walden/web test -- NotesEditor.test.tsx AnnotatedText.test.tsx`

Expected: FAIL until the focused units exist.

- [ ] **Step 3: Extract state, rendering, and DOM selection responsibilities**

`use-note-editor.ts` owns editor state and save sequencing. `NoteSuggestionList.tsx` owns suggestion controls. `use-annotation-selection.ts` owns selection normalization. `AnnotationActions.tsx` owns action menu rendering. Existing exports remain thin composition components.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @walden/web test -- NotesEditor.test.tsx AnnotatedText.test.tsx`

Expected: PASS with no relevant complexity diagnostics.

### Task 5: Split API agent construction and streaming

**Files:**
- Modify: `apps/api/src/agent/index.ts`
- Create: `apps/api/src/agent/tool-schemas.ts`
- Create: `apps/api/src/agent/learning-checks.ts`
- Create: `apps/api/src/agent/note-proposals.ts`
- Create: `apps/api/src/agent/stream-events.ts`
- Create: `apps/api/src/agent/mastra-turn.ts`
- Modify: `apps/api/src/agent/*.test.ts`

- [ ] **Step 1: Add a failing learning-check normalization test**

```ts
it('normalizes a mixed question batch into a durable learning check', () => {
  expect(normalizeLearningCheck(batch, 'turn-1')).toMatchObject({
    kind: 'learning_check',
    questions: [
      { format: 'multiple_choice' },
      { format: 'short_answer' },
    ],
  });
});
```

- [ ] **Step 2: Run the targeted test**

Run: `pnpm --filter @walden/api test -- learning-checks.test.ts`

Expected: FAIL until the focused module exports the normalizer.

- [ ] **Step 3: Move independent agent responsibilities into modules**

`tool-schemas.ts` owns Zod inputs. `learning-checks.ts` owns normalization and fallback parsing. `note-proposals.ts` owns validation, repair, and diagnostics. `stream-events.ts` owns conversion from provider chunks into public events. `mastra-turn.ts` composes tools, prompt context, stream processing, and the done event. `index.ts` exports the existing public API only.

- [ ] **Step 4: Run agent tests**

Run: `pnpm --filter @walden/api test -- agent`

Expected: PASS with no diagnostic from `agent/index.ts`.

### Task 6: Split API route orchestration and services

**Files:**
- Modify: `apps/api/src/chat/followups.ts`
- Modify: `apps/api/src/chat/conversations.ts`
- Modify: `apps/api/src/chat/routes.ts`
- Modify: `apps/api/src/notes/routes.ts`
- Modify: `apps/api/src/services/agent.ts`
- Create focused request, persistence, and stream helper modules beside each owner
- Modify corresponding route and service tests

- [ ] **Step 1: Add failing persistence and stream boundary tests**

```ts
it('persists the terminal assistant message after emitting its done event', async () => {
  const events = await collect(runTurn(fixture));
  expect(events.at(-1)?.type).toBe('done');
  expect(await repository.message(events.at(-1)!.message.id)).toBeTruthy();
});
```

- [ ] **Step 2: Run route tests**

Run: `pnpm --filter @walden/api test -- chat`

Expected: FAIL until the behavior is expressed through testable boundaries.

- [ ] **Step 3: Extract routes from business rules**

Route modules parse HTTP input and select status codes. Service modules own state transitions. Repository modules own D1 statements. Stream helpers own generation lifecycle and persistence. Tests use small fixtures and describe one behavior each.

- [ ] **Step 4: Run API tests**

Run: `pnpm --filter @walden/api test`

Expected: PASS with no API source diagnostic.

### Task 7: Split oversized test suites and stylesheets

**Files:**
- Modify: all test files reported by Biome
- Modify: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/chat.css`
- Create: `apps/web/src/styles/notes.css`
- Create: `apps/web/src/styles/settings.css`

- [ ] **Step 1: Move test scenarios by feature boundary**

Each test file gets one responsibility. Shared fixtures become exported constructors in a colocated `*.fixtures.ts` module. Each `describe` callback contains at most one feature grouping and no setup factory over sixty lines.

- [ ] **Step 2: Move CSS by screen ownership**

Keep design tokens in `tokens.css`; import chat, note, and settings styles from the application stylesheet. No stylesheet exceeds 800 lines.

- [ ] **Step 3: Run test suites after each split**

Run: `pnpm test`

Expected: PASS.

### Task 8: Enforce the clean boundary

**Files:**
- Modify: `biome.json`

- [ ] **Step 1: Run the complete lint check**

Run: `pnpm check:ci`

Expected: zero warnings and zero errors.

- [ ] **Step 2: Promote the three architecture rules to errors**

```json
"noExcessiveCognitiveComplexity": { "level": "error", "options": { "maxAllowedComplexity": 20 } }
```

Apply the same `"level": "error"` change to `noExcessiveLinesPerFunction` and `noExcessiveLinesPerFile`; keep their existing numeric limits.

- [ ] **Step 3: Run full verification**

Run: `pnpm check:ci`

Expected: exit 0 with zero diagnostics.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm test`

Expected: exit 0.

Run: `pnpm build`

Expected: exit 0.
