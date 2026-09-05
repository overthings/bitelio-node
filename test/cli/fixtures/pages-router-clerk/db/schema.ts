import {pgTable, text, timestamp} from 'drizzle-orm/pg-core';

export const members = pgTable('members', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});
