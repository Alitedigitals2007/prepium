require('./_envload.cjs');
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    await p.query('SELECT 1');
    console.log('DB OK');
    // Fetch real schema of study_courses
    const r1 = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'study_courses' ORDER BY ordinal_position`);
    console.log('study_courses cols:', r1.rows.map(x => x.column_name).join(', '));
    const r2 = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'timetables' ORDER BY ordinal_position`);
    console.log('timetables cols:', r2.rows.map(x => x.column_name).join(', '));
    await p.end();
  } catch (e) { console.log('ERR', e.message); }
})();
