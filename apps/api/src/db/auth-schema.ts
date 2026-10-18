import {
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Native D1 and Drizzle share ISO timestamps so database exports remain portable.
const isoDate = customType<{ data: Date; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => new Date(value),
});
const dates = () => ({
  createdAt: isoDate('created_at').notNull(),
  updatedAt: isoDate('updated_at').notNull(),
});
export const authUser = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  ...dates(),
});
export const authSession = sqliteTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    expiresAt: isoDate('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...dates(),
  },
  (table) => [index('auth_session_user').on(table.userId)],
);
export const authAccount = sqliteTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: isoDate('access_token_expires_at'),
    refreshTokenExpiresAt: isoDate('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    ...dates(),
  },
  (table) => [
    index('auth_account_user').on(table.userId),
    uniqueIndex('auth_account_identity').on(table.providerId, table.accountId),
  ],
);
export const authVerification = sqliteTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: isoDate('expires_at').notNull(),
    ...dates(),
  },
  (table) => [index('auth_verification_identifier').on(table.identifier)],
);
export const sqliteAuthSchema = {
  auth_user: authUser,
  auth_session: authSession,
  auth_account: authAccount,
  auth_verification: authVerification,
};
