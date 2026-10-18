import { type AppDatabase, type AppStatement, normalizeDatabaseError } from './database';

const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
};

/** D1 supplies the transaction; wrappers only normalize errors and identify the dialect. */
export const createD1Database = (binding: AppDatabase): AppDatabase => {
  const statements = new WeakMap<AppStatement, AppStatement>();
  const wrap = (native: AppStatement): AppStatement => {
    const statement: AppStatement = {
      bind(...values) {
        return wrap(native.bind(...values));
      },
      first: <T>(columnName?: string) => guarded(() => native.first<T>(columnName)),
      all: <T>() => guarded(() => native.all<T>()),
      run: <T>() => guarded(() => native.run<T>()),
      raw: <T>() => guarded(() => native.raw<T>()),
    };
    statements.set(statement, native);
    return statement;
  };
  return {
    dialect: 'sqlite',
    identity: binding.identity ?? binding,
    prepare: (sql) => wrap(binding.prepare(sql)),
    batch: (batch) =>
      guarded(() =>
        binding.batch(
          batch.map((statement) => {
            const native = statements.get(statement);
            if (!native) throw new Error('Cannot batch statements from a different database');
            return native;
          }),
        ),
      ),
    exec: (sql) => guarded(() => binding.exec(sql)),
  };
};
