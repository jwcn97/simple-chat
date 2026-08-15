// migrate.js — applies schema.sql to the database. Re-run any time after
// pulling schema changes; every statement is idempotent (IF NOT EXISTS).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

await pool.query(sql);
console.log('Schema is up to date.');
await pool.end();
