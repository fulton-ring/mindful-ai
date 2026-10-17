import { describe, expect, it } from 'vitest';

// Loading this way makes the initial red assertion describe the missing adapter.
const adapter = await import('./postgres').catch(() => null);

describe('Postgres parameter binding', () => {
  it('normalizes numbered and positional placeholders without changing SQL literals or comments', () => {
    expect(adapter?.postgresParameters).toBeTypeOf('function');
    const bound = adapter!.postgresParameters('SELECT ?2,?1,?2,\'?\',"?",$$?$$ -- ?\n/* ? */', [
      'one',
      'two',
    ]);
    expect(bound).toEqual({
      text: 'SELECT $1,$2,$1,\'?\',"?",$$?$$ -- ?\n/* ? */',
      values: ['two', 'one'],
    });
    expect(adapter!.postgresParameters('SELECT ?,?', [1, null])).toEqual({
      text: 'SELECT $1,$2',
      values: [1, null],
    });
  });
  it('keeps escaped string literals and nested comments unchanged', () => {
    const sql = String.raw`SELECT E'escaped \' ? string',? /* nested /* ? */ ? */`;
    expect(adapter!.postgresParameters(sql, [4])).toEqual({
      text: sql.replace(',?', ',$1'),
      values: [4],
    });
  });
});
