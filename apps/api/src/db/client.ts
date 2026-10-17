import type { AppStatement } from './database';

export async function first<T>(statement: AppStatement): Promise<T | null> {
  return (await statement.first<T>()) ?? null;
}

export async function all<T>(statement: AppStatement): Promise<T[]> {
  return (await statement.all<T>()).results;
}

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
