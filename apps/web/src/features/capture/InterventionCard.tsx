import type { Intervention, LearningCheck, LearningCheckResponse } from '@walden/contracts';
import { useState } from 'react';

type Props = {
  intervention: Exclude<Intervention, { kind: 'ghost' }>;
  onResolve(value: string | LearningCheckResponse): void;
  onCapture(value: string, verbatim: boolean): void;
  onDismiss(): void;
  resolved?: LearningCheckResponse;
};

export function InterventionCard(props: Props) {
  if (props.intervention.kind === 'record') return <RecordCard {...props} />;
  if (props.intervention.kind === 'ask') return <AskCard {...props} />;
  if (props.resolved) return <ResolvedLearningCheck check={props.intervention} />;
  return (
    <LearningCheckCard
      check={props.intervention}
      onResolve={props.onResolve}
      onDismiss={props.onDismiss}
    />
  );
}

function RecordCard({ intervention, onResolve, onCapture, onDismiss }: Props) {
  if (intervention.kind !== 'record') return null;
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
}

function AskCard({ intervention, onCapture, onDismiss }: Props) {
  const [writingAnswer, setWritingAnswer] = useState(false);
  const [answer, setAnswer] = useState('');
  if (intervention.kind !== 'ask') return null;
  const submitAnswer = () => {
    const value = answer.trim();
    if (value) onCapture(value, true);
  };
  return (
    <section className="intervention" aria-label="Clarifying question">
      <p className="eyebrow">Clarify the note</p>
      <p>{intervention.question}</p>
      <div className="choice-list">
        {intervention.options.map((choice) => (
          <button key={choice} onClick={() => onCapture(choice, true)}>
            {choice}
          </button>
        ))}
      </div>
      {writingAnswer && (
        <AnswerForm
          id={`intervention-answer-${intervention.id}`}
          value={answer}
          onChange={setAnswer}
          onSubmit={submitAnswer}
          label="Your answer"
        />
      )}
      <div className="button-row">
        {!writingAnswer && <button onClick={() => setWritingAnswer(true)}>Other</button>}
        <button onClick={onDismiss}>Skip</button>
      </div>
    </section>
  );
}

function ResolvedLearningCheck({ check }: { check: LearningCheck }) {
  return (
    <section className="intervention intervention-resolved" aria-label="Learning check">
      <p className="eyebrow">Check your understanding</p>
      {check.questions.map((question) => (
        <p key={question.id}>{question.question}</p>
      ))}
    </section>
  );
}

function LearningCheckCard({
  check,
  onResolve,
  onDismiss,
}: {
  check: LearningCheck;
  onResolve(value: LearningCheckResponse): void;
  onDismiss(): void;
}) {
  const [answers, setAnswers] = useState<LearningCheckResponse['answers']>({});
  const [activeStep, setActiveStep] = useState(0);
  const allAnswered = check.questions.every((question) => {
    const answer = answers[question.id]?.answers[0]?.trim();
    return Boolean(answer);
  });
  const question = check.questions[activeStep];
  const reviewingAnswers = !question;
  const updateAnswer = (questionId: string, value: string) => {
    setAnswers((current) => ({ ...current, [questionId]: { answers: [value] } }));
  };
  const advance = () => setActiveStep((current) => Math.min(current + 1, check.questions.length));

  return (
    <section className="intervention" aria-label="Learning check">
      <p className="eyebrow">
        {check.questions.length > 1 ? 'Quick check' : 'Check your understanding'}
      </p>
      <div className="learning-check-tabs" role="tablist" aria-label="Learning check questions">
        {check.questions.map((item, index) => (
          <button
            key={item.id}
            aria-selected={activeStep === index}
            role="tab"
            type="button"
            onClick={() => setActiveStep(index)}
          >
            {index + 1}
          </button>
        ))}
        <button
          aria-selected={reviewingAnswers}
          role="tab"
          type="button"
          onClick={() => setActiveStep(check.questions.length)}
        >
          Submit
        </button>
      </div>
      {question ? (
        <LearningCheckQuestionCard
          checkId={check.id}
          question={question}
          questionNumber={check.questions.length > 1 ? activeStep + 1 : undefined}
          value={answers[question.id]?.answers[0] ?? ''}
          onChange={(value) => updateAnswer(question.id, value)}
          onContinue={advance}
        />
      ) : (
        <div className="learning-check-submit">
          <p>
            {allAnswered
              ? 'Ready to send your answers?'
              : 'Answer every question before submitting.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={!allAnswered}
              onClick={() => onResolve({ checkId: check.id, answers })}
            >
              Submit answers
            </button>
            <button onClick={onDismiss}>Skip</button>
          </div>
        </div>
      )}
    </section>
  );
}

function LearningCheckQuestionCard({
  checkId,
  onChange,
  onContinue,
  question,
  questionNumber,
  value,
}: {
  checkId: string;
  onChange(value: string): void;
  onContinue(): void;
  question: LearningCheck['questions'][number];
  questionNumber?: number;
  value: string;
}) {
  const label = questionNumber ? `${questionNumber}. ${question.question}` : question.question;
  if (question.format === 'short_answer') {
    return (
      <div className="learning-check-question">
        <p>{label}</p>
        <label className="learning-check-answer" htmlFor={`${checkId}-${question.id}`}>
          Your answer: {question.header}
        </label>
        <input
          id={`${checkId}-${question.id}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="button-row learning-check-continue">
          <button type="button" className="primary" disabled={!value.trim()} onClick={onContinue}>
            Next
          </button>
        </div>
      </div>
    );
  }
  return (
    <fieldset className="learning-check-question">
      <legend>{label}</legend>
      <div className="choice-list">
        {question.options.map((choice) => (
          <label key={choice} className="learning-check-choice">
            <input
              checked={value === choice}
              name={`${checkId}-${question.id}`}
              type="radio"
              value={choice}
              onChange={() => {
                onChange(choice);
                onContinue();
              }}
            />
            {choice}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AnswerForm({
  id,
  value,
  onChange,
  onSubmit,
  label,
  submitLabel = 'Submit answer',
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  label: string;
  submitLabel?: string;
}) {
  return (
    <form
      className="intervention-answer"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit();
      }}
    >
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} />
      <button type="submit" className="primary" disabled={!value.trim()}>
        {submitLabel}
      </button>
    </form>
  );
}
