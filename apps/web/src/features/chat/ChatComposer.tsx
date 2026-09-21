import { ArrowUp, Square } from 'lucide-react';
import type { ComponentProps, RefObject } from 'react';

import { effectivePersona, PersonaPicker } from '../personas/PersonaPicker';
import { ChatToolsMenu } from './ChatToolsMenu';

type ComposerProps = {
  input: string;
  sending: boolean;
  savingChatPreference: boolean;
  webSearch: boolean;
  learningChecks: boolean;
  autoHighlights: boolean;
  personas: ComponentProps<typeof PersonaPicker>['personas'];
  personaId: string;
  messageInput: RefObject<HTMLTextAreaElement | null>;
  onInput(value: string): void;
  onSend(): void;
  onStop(): void;
  onPersona(id: string): void;
  onPreference(setting: 'learningChecks' | 'webSearch', enabled: boolean): void;
  onAutoHighlights(enabled: boolean): void;
};

export function ChatComposer({
  input,
  sending,
  savingChatPreference,
  webSearch,
  learningChecks,
  autoHighlights,
  personas,
  personaId,
  messageInput,
  onInput,
  onSend,
  onStop,
  onPersona,
  onPreference,
  onAutoHighlights,
}: ComposerProps) {
  const selectedPersona = effectivePersona(personas, personaId);

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={messageInput}
        aria-label="Message"
        rows={2}
        placeholder="Message…"
        value={input}
        onChange={(event) => onInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-tools">
          <ChatToolsMenu
            webSearch={webSearch}
            learningChecks={learningChecks}
            autoHighlights={autoHighlights}
            disabled={sending || savingChatPreference}
            onPreference={onPreference}
            onAutoHighlights={onAutoHighlights}
          />
          <PersonaPicker
            personas={personas}
            value={selectedPersona?.id ?? personaId}
            onChange={onPersona}
          />
        </div>
        <button
          className="send-button"
          type={sending ? 'button' : 'submit'}
          aria-label={sending ? 'Stop response' : 'Send message'}
          disabled={savingChatPreference || (!sending && !input.trim())}
          onClick={sending ? onStop : undefined}
        >
          {sending ? <Square /> : <ArrowUp />}
        </button>
      </div>
    </form>
  );
}
