import { pgTable, serial, text, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

// users table
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    googleId: text('google_id').unique(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    profilePicture: text('profile_picture'), // set something default. can be randomized 
    createdAt: timestamp('created_at').defaultNow()
});

// rooms table
export const rooms = pgTable('rooms', {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    hostId: integer('host_id').notNull().references(() => users.id),
    roomType: text('room_type').notNull().default('collaborative'),
    maxCapacity: integer('max_capacity').default(10),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow()
});