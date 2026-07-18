require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  const r = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
  console.log('Tables:', r.rows.map(t => t.table_name).join(', '));
  await pool.end();
}
main().catch(e => { console.log('ERR:', e.message); process.exit(1); });
