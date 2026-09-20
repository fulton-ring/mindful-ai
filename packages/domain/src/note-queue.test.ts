import { describe, expect, it } from 'vitest';
import { acceptQueueEdit, minimalEdit, renderWithQueue, soleInsertion } from './note-queue';

const apply = (markdown: string, edit: { from: number; to: number; insert: string } | null) =>
  edit ? markdown.slice(0, edit.from) + edit.insert + markdown.slice(edit.to) : markdown;

const queue = [
  { id: 'a', text: '- The pilot budget is 40k' },
  { id: 'b', text: '- Hiring pauses until June' },
  { id: 'c', text: '- The office moves in August' },
];

describe('rendering a note with its queue', () => {
  it('lays the queue out in order below an empty note', () => {
    const rendered = renderWithQueue('', queue);

    expect(rendered.markdown).toBe(
      '- The pilot budget is 40k\n\n- Hiring pauses until June\n\n- The office moves in August',
    );
    expect(rendered.spans.map((span) => span.id)).toEqual(['a', 'b', 'c']);
  });

  it('attributes each span to the addition that produced it', () => {
    const rendered = renderWithQueue('Existing note.', queue);

    for (const span of rendered.spans) {
      const item = queue.find((entry) => entry.id === span.id)!;
      expect(rendered.markdown.slice(span.from, span.to)).toBe(item.text);
    }
    expect(rendered.markdown.startsWith('Existing note.')).toBe(true);
  });

  it('still gives a span to an addition whose text has not arrived yet', () => {
    // A streaming suggestion starts empty. It has to occupy a place in the
    // queue from the beginning, or the reader sees nothing pending where one
    // is about to appear.
    const rendered = renderWithQueue('Note.', [{ id: 'streaming', text: '' }]);

    expect(rendered.markdown).toBe('Note.');
    // Nothing is inserted yet, so the span holds a place without any text.
    expect(rendered.spans).toEqual([
      { id: 'streaming', from: 5, to: 5, sourceFrom: 5, insert: '' },
    ]);
  });
});

describe('accepting out of order', () => {
  it('puts an accepted addition exactly where the preview showed it', () => {
    // The reported bug: accepting the second suggestion first put it at the top
    // of the note with the first one after it.
    const rendered = renderWithQueue('', queue);
    const second = rendered.spans.find((span) => span.id === 'b')!;
    const previewed = rendered.markdown.slice(second.from, second.to);

    const note = apply('', acceptQueueEdit('', queue, 'b'));

    expect(note).toBe(previewed);
  });

  it('keeps the remaining queue in its original order around it', () => {
    const afterB = apply('', acceptQueueEdit('', queue, 'b'));
    // The accepted item stays in the queue, marked accepted: that is how the
    // ones still pending keep their place relative to it.
    const remaining = queue.map((item) => (item.id === 'b' ? { ...item, accepted: true } : item));

    expect(renderWithQueue(afterB, remaining).markdown).toBe(
      '- The pilot budget is 40k\n\n- Hiring pauses until June\n\n- The office moves in August',
    );
  });

  it('reaches the same note however the queue is accepted', () => {
    const orders = [
      ['a', 'b', 'c'],
      ['c', 'b', 'a'],
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
    ];
    const results = orders.map((order) => {
      let note = '';
      let pending = queue.map((item) => ({ ...item }));
      for (const id of order) {
        note = apply(note, acceptQueueEdit(note, pending, id));
        pending = pending.map((item) => (item.id === id ? { ...item, accepted: true } : item));
      }
      return note;
    });

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(
      '- The pilot budget is 40k\n\n- Hiring pauses until June\n\n- The office moves in August',
    );
  });

  it('keeps accepted text in place when a note already has content', () => {
    const note = '# Budget\n\nFixed at 40k.';
    const rendered = renderWithQueue(note, queue);
    const span = rendered.spans.find((entry) => entry.id === 'c')!;
    const previewedBefore = rendered.markdown.slice(0, span.from);

    const applied = apply(note, acceptQueueEdit(note, queue, 'c'));

    // Everything the reader saw above the accepted line, minus the other
    // pending chunks, still precedes it.
    expect(applied.indexOf(queue[2]!.text)).toBeGreaterThan(0);
    expect(previewedBefore).toContain('# Budget');
    expect(applied).toContain('# Budget\n\nFixed at 40k.');
  });

  it('returns nothing for an id that is not queued', () => {
    expect(acceptQueueEdit('Note.', queue, 'missing')).toBeNull();
  });
});

describe('validating a submitted note', () => {
  it('finds the single insertion that produced it', () => {
    expect(soleInsertion('First.', 'First.\n\nSecond.')).toEqual({
      from: 6,
      to: 6,
      insert: '\n\nSecond.',
    });
    expect(soleInsertion('First.', 'Zero.\n\nFirst.')).toEqual({
      from: 0,
      to: 0,
      insert: 'Zero.\n\n',
    });
  });

  it('refuses anything that is not purely an insertion', () => {
    // Accepting a suggestion may only add its own text. Without this the
    // endpoint would take whatever markdown the client sent.
    expect(soleInsertion('First.', 'Second.')).toBeNull();
    // Two separate insertions are not one insertion.
    expect(soleInsertion('First second.', 'First changed second.\n\nExtra.')).toBeNull();
    expect(soleInsertion('Hello there.', 'Hello world.')).toBeNull();
    expect(soleInsertion('Same.', 'Same.')).toBeNull();
    expect(soleInsertion('Longer text.', 'Short.')).toBeNull();
  });
});

describe('span accuracy', () => {
  it('reports the exact text of every span, wherever its separator sits', () => {
    // An addition that lands before existing text has its blank line after it,
    // not before. Assuming otherwise put the span two characters out.
    for (const note of ['', 'Existing note.', '# Heading\n\nBody text.'])
      for (const order of [queue, [...queue].reverse()]) {
        const rendered = renderWithQueue(note, order);
        for (const span of rendered.spans) {
          const item = order.find((entry) => entry.id === span.id)!;
          expect(rendered.markdown.slice(span.from, span.to)).toBe(item.text);
        }
      }
  });

  it('puts a span at the very start when the addition comes first', () => {
    const rendered = renderWithQueue('Existing.', [
      { id: 'first', text: 'Before it.' },
      { id: 'anchor', text: 'Existing.', accepted: true },
    ]);

    expect(rendered.markdown).toBe('Before it.\n\nExisting.');
    // `insert` carries the trailing separator; `from`..`to` bound only the text.
    expect(rendered.spans).toEqual([
      { id: 'first', from: 0, to: 10, sourceFrom: 0, insert: 'Before it.\n\n' },
    ]);
  });
});

describe('source offsets', () => {
  it('reports where each addition inserts in the saved note', () => {
    // The editor maps between the note and what it renders using these. Saying
    // every addition appends made that map wrong the moment one landed
    // anywhere else, and typing beside a suggestion lost the typing.
    const note = '# Budget\n\nFixed at 40k.';
    const rendered = renderWithQueue(note, [
      { id: 'budget', text: 'Budget review is monthly.' },
      { id: 'other', text: 'Priya runs the pilot.' },
    ]);

    for (const span of rendered.spans) {
      expect(span.sourceFrom).toBeGreaterThanOrEqual(0);
      expect(span.sourceFrom).toBeLessThanOrEqual(note.length);
    }
    // Applying the spans back to the note, in source order, rebuilds the render.
    let rebuilt = note;
    for (const span of [...rendered.spans].sort((a, b) => b.sourceFrom - a.sourceFrom)) {
      const text = rendered.markdown.slice(span.from, span.to);
      rebuilt = rebuilt.slice(0, span.sourceFrom) + text + rebuilt.slice(span.sourceFrom);
    }
    for (const span of rendered.spans)
      expect(rebuilt).toContain(rendered.markdown.slice(span.from, span.to));
    expect(rebuilt).toContain('# Budget');
    expect(rebuilt).toContain('Fixed at 40k.');
  });
});

describe('minimal edits', () => {
  const applied = (before: string, after: string) => {
    const edit = minimalEdit(before, after);
    return before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
  };

  it('touches only the part that differs', () => {
    // A whole-document replacement moves the caret, which scattered characters
    // when typing beside a suggestion.
    const edit = minimalEdit(
      'Keep this. Change me. Keep that.',
      'Keep this. Changed it. Keep that.',
    );

    expect(edit.from).toBeGreaterThan(0);
    expect(edit.to).toBeLessThan('Keep this. Change me. Keep that.'.length);
  });

  it('rebuilds the target for insertions, deletions and replacements', () => {
    const cases: Array<[string, string]> = [
      ['', 'all new'],
      ['all gone', ''],
      ['same', 'same'],
      ['a\n\nb', 'a\n\nmiddle\n\nb'],
      ['a\n\nmiddle\n\nb', 'a\n\nb'],
      ['- One\n\n- Two', '- One\n\n- Two\n\n- Three'],
    ];
    for (const [before, after] of cases) expect(applied(before, after)).toBe(after);
  });
});
