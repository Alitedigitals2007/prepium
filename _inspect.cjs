require('./_envload.cjs');
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  const tables = ['study_courses', 'study_topics', 'study_subtopics', 'study_sessions', 'study_progress', 'study_chat_messages', 'study_flashcards', 'study_quiz_attempts', 'study_quiz_questions', 'study_youtube_videos', 'timetables', 'reading_timetables', 'cgpa_profiles', 'cgpa_courses', 'users', 'quiz_results'];
  for (const t of tables) {
    try {
      const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
      console.log(`\n=== ${t} ===`);
      console.log(r.rows.map(x => x.column_name).join(', '));
    } catch (e) {
      console.log(`\n=== ${t} === TABLE NOT FOUND: ${e.message}`);
    }
  }
  await c.end();
})();
