import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { boolean, pgTable, text as pgText, timestamp } from 'drizzle-orm/pg-core';
import { sqliteAuthSchema } from '../db/auth-schema';
import { type AuthSettings, createBetterAuth } from './better-auth';

function postgresSchema() {
  const date = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
  const dates = () => ({
    createdAt: date('created_at').notNull(),
    updatedAt: date('updated_at').notNull(),
  });
  return {
    auth_user: pgTable('auth_user', {
      id: pgText('id').primaryKey(),
      name: pgText('name').notNull(),
      email: pgText('email').notNull().unique(),
      emailVerified: boolean('email_verified').notNull(),
      image: pgText('image'),
      ...dates(),
    }),
    auth_session: pgTable('auth_session', {
      id: pgText('id').primaryKey(),
      token: pgText('token').notNull().unique(),
      userId: pgText('user_id').notNull(),
      expiresAt: date('expires_at').notNull(),
      ipAddress: pgText('ip_address'),
      userAgent: pgText('user_agent'),
      ...dates(),
    }),
    auth_account: pgTable('auth_account', {
      id: pgText('id').primaryKey(),
      accountId: pgText('account_id').notNull(),
      providerId: pgText('provider_id').notNull(),
      userId: pgText('user_id').notNull(),
      accessToken: pgText('access_token'),
      refreshToken: pgText('refresh_token'),
      idToken: pgText('id_token'),
      accessTokenExpiresAt: date('access_token_expires_at'),
      refreshTokenExpiresAt: date('refresh_token_expires_at'),
      scope: pgText('scope'),
      password: pgText('password'),
      ...dates(),
    }),
    auth_verification: pgTable('auth_verification', {
      id: pgText('id').primaryKey(),
      identifier: pgText('identifier').notNull(),
      value: pgText('value').notNull(),
      expiresAt: date('expires_at').notNull(),
      ...dates(),
    }),
  };
}

export { sqliteAuthSchema } from '../db/auth-schema';
export const postgresAuthSchema = postgresSchema();
export function createDrizzleAuth(
  database: Parameters<typeof drizzleAdapter>[0],
  provider: 'sqlite' | 'pg',
  settings: AuthSettings,
) {
  return createBetterAuth(
    drizzleAdapter(database, {
      provider,
      schema: provider === 'sqlite' ? sqliteAuthSchema : postgresAuthSchema,
      transaction: true,
    }),
    settings,
    'drizzle',
  );
}
