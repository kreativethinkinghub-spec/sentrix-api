import 'dotenv/config';
import { readFileSync } from 'fs';
import { pool } from './client.js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

try {
  await pool.query(schema);
  console.log('Migration complete — all tables created.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
