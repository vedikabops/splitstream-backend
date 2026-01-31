import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

config();

const sql = neon(process.env.DATABASE_URL)
export const db = drizzle(sql, { schema })
// Without schema: You can run raw SQL but can't use db.select().from(users)
