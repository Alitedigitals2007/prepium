require('./_envload.cjs');
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    const r = await p.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('cgpa_profiles','cgpa_courses')`);
    console.log(JSON.stringify(r.rows));
    const r2 = await p.query(`SELECT * FROM cgpa_profiles LIMIT 1`);
    console.log('cgpa_profiles unqualified works, rows=', r2.rowCount);
    const r3 = await p.query(`SELECT * FROM public.cgpa_profiles LIMIT 1`);
    console.log('public.cgpa_profiles works, rows=', r3.rowCount);
    await p.end();
  } catch (e) { console.log('ERR', e.message); }
})();
