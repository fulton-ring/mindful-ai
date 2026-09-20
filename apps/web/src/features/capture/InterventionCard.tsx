import type { Intervention } from '@walden/contracts';

export function InterventionCard({
  intervention,
  onResolve,
  onCapture,
  onDismiss,
}: {
  intervention: Exclude<Intervention, { kind: 'ghost' }>;
  onResolve(value: string): void;
  onCapture(value: string, verbatim: boolean): void;
  onDismiss(): void;
}) {
  if (intervention.kind === 'record')
    return (
      <section className="intervention" aria-label="Capture suggestion">
        <p className="eyebrow">A thought worth keeping</p>
        <blockquote>{intervention.text}</blockquote>
        <p className="muted">{intervention.reason}</p>
        <div className="button-row">
          <button
            className="primary"
            onClick={() => onResolve(`Help me put this in my own words: ${intervention.text}`)}
          >
            Put it in my words
          </button>
          <button onClick={() => onCapture(intervention.text, true)}>Record as-is</button>
          <button
            onClick={() => onResolve(`Ask me about this before we record it: ${intervention.text}`)}
          >
            Ask about this
          </button>
          <button onClick={onDismiss}>Dismiss</button>
        </div>
      </section>
    );
  const choices = intervention.options ?? [];
  return (
    <section
      className="intervention"
      aria-label={intervention.kind === 'ask' ? 'Clarifying question' : 'Learning check'}
    >
      <p className="eyebrow">
        {intervention.kind === 'ask' ? 'Clarify the note' : 'Check your understanding'}
      </p>
      <p>{intervention.question}</p>
      {choices.length > 0 && (
        <div className="choice-list">
          {choices.map((choice) => (
            <button
              key={choice}
              onClick={() =>
                intervention.kind === 'ask'
                  ? onCapture(choice, true)
                  : onResolve(`${intervention.question}\n${choice}`)
              }
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      <div className="button-row">
        <button onClick={() => onResolve(`${intervention.question}\nOther: `)}>Other</button>
        <button onClick={onDismiss}>Skip</button>
      </div>
    </section>
  );
}
