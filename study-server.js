require('./_envload.cjs');
const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKeys = [process.env.GEMINI_API_KEY_PRIMARY, process.env.GEMINI_API_KEY_SECONDARY].filter(Boolean);
const genAI = new GoogleGenerativeAI(apiKeys[0] || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_courses (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_name VARCHAR(255) NOT NULL, course_code VARCHAR(50) DEFAULT '',
        unit INTEGER DEFAULT 3, source VARCHAR(20) DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_topics (
        id SERIAL PRIMARY KEY, course_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL, title VARCHAR(500) NOT NULL,
        topic_name VARCHAR(500), order_index INTEGER DEFAULT 0,
        completed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_subtopics (
        id SERIAL PRIMARY KEY, topic_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        title VARCHAR(500) NOT NULL, subtopic_name VARCHAR(500),
        status VARCHAR(20) DEFAULT 'pending',
        content TEXT DEFAULT '', notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0,
        subject_id INTEGER DEFAULT 0, course_name VARCHAR(255) DEFAULT '',
        duration_minutes INTEGER DEFAULT 0, elapsed_seconds INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active', notes TEXT DEFAULT '',
        session_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_progress (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_id INTEGER DEFAULT 0, course_name VARCHAR(255) NOT NULL,
        total_sessions INTEGER DEFAULT 0, total_minutes INTEGER DEFAULT 0,
        last_studied TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_chat_messages (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0,
        role VARCHAR(20) DEFAULT 'user', message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_flashcards (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0,
        front TEXT NOT NULL, back TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_quiz_attempts (
        id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
        course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0,
        question_type VARCHAR(50) DEFAULT 'multiple_choice',
        question_count INTEGER DEFAULT 10,
        time_limit INTEGER DEFAULT 0, score INTEGER DEFAULT 0,
        total_questions INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'in_progress',
        total INTEGER DEFAULT 0, answers JSONB,
        started_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_quiz_questions (
        id SERIAL PRIMARY KEY, attempt_id INTEGER NOT NULL,
        user_id INTEGER, question TEXT NOT NULL, options JSONB,
        correct_answer TEXT, user_answer TEXT,
        is_correct BOOLEAN, explanation TEXT, question_type VARCHAR(50),
        order_index INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_youtube_videos (
        id SERIAL PRIMARY KEY, course_id INTEGER DEFAULT 0,
        subtopic_id INTEGER DEFAULT 0, title VARCHAR(500),
        url VARCHAR(500), thumbnail VARCHAR(500),
        channel VARCHAR(255), created_at TIMESTAMP DEFAULT NOW()
      )`);

    // Compatibility migration: ensure columns exist on legacy tables
    const adds = [
      ['study_courses', 'unit', 'INTEGER DEFAULT 3'],
      ['study_courses', 'source', "VARCHAR(20) DEFAULT 'manual'"],
      ['study_courses', 'updated_at', 'TIMESTAMP DEFAULT NOW()'],
      ['study_topics', 'topic_name', 'VARCHAR(500)'],
      ['study_topics', 'order_index', 'INTEGER DEFAULT 0'],
      ['study_topics', 'completed', 'BOOLEAN DEFAULT false'],
      ['study_subtopics', 'subtopic_name', 'VARCHAR(500)'],
      ['study_subtopics', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_subtopics', 'content', "TEXT DEFAULT ''"],
      ['study_subtopics', 'notes', "TEXT DEFAULT ''"],
      ['study_sessions', 'subtopic_id', 'INTEGER DEFAULT 0'],
      ['study_sessions', 'subject_id', 'INTEGER DEFAULT 0'],
      ['study_sessions', 'duration_minutes', 'INTEGER DEFAULT 0'],
      ['study_sessions', 'session_date', 'DATE DEFAULT CURRENT_DATE'],
      ['study_chat_messages', 'subtopic_id', 'INTEGER DEFAULT 0'],
      ['study_flashcards', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'question_type', "VARCHAR(50) DEFAULT 'multiple_choice'"],
      ['study_quiz_attempts', 'question_count', 'INTEGER DEFAULT 10'],
      ['study_quiz_attempts', 'time_limit', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'total_questions', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'status', "VARCHAR(20) DEFAULT 'in_progress'"],
      ['study_quiz_attempts', 'started_at', 'TIMESTAMP DEFAULT NOW()'],
      ['study_quiz_attempts', 'created_at', 'TIMESTAMP DEFAULT NOW()'],
      ['study_quiz_questions', 'attempt_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_questions', 'user_answer', 'TEXT'],
      ['study_quiz_questions', 'is_correct', 'BOOLEAN'],
      ['study_quiz_questions', 'order_index', 'INTEGER DEFAULT 0'],
    ];
    for (const [t, c, d] of adds) {
      try { await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${d}`); } catch(e) {}
    }
    await pool.query(`UPDATE study_topics SET topic_name = COALESCE(topic_name, title) WHERE topic_name IS NULL`).catch(()=>{});
    await pool.query(`UPDATE study_subtopics SET subtopic_name = COALESCE(subtopic_name, title) WHERE subtopic_name IS NULL`).catch(()=>{});
    try { await pool.query(`ALTER TABLE study_progress DROP CONSTRAINT IF EXISTS study_progress_user_course`); } catch(e) {}
    try { await pool.query(`ALTER TABLE study_progress ADD CONSTRAINT study_progress_user_course UNIQUE (user_id, course_name)`); } catch(e) {}
    console.log('[DB] All study tables ready');
  } catch (err) {
    console.error('[DB] Study tables setup:', err.message);
  }
}
initDB();

const pgSession = require('connect-pg-simple')(session);
const app = express();
const PORT = process.env.STUDY_PORT || 3001;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'prepium-secret-key-2024',
  resave: false, saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

function isAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json')))
    return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function parseRetryDelay(msg) {
  const m = msg.match(/retry\s*in\s*([\d.]+)\s*s/i);
  return m ? Math.min(Math.round(parseFloat(m[1]) * 1000) + 500, 30000) : null;
}

async function promptAI(prompt) {
  if (apiKeys.length === 0) return { text: 'AI service not configured. Please set GEMINI_API_KEY in .env' };
  let lastErr = null;
  for (let i = 0; i < Math.max(apiKeys.length, 3); i++) {
    const key = apiKeys[i % apiKeys.length];
    try {
      const gai = require('@google/generative-ai');
      const ai = new gai.GoogleGenerativeAI(key);
      const m = ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const r = await m.generateContent(prompt);
      return { text: r.response.text() };
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      const isQuota = /429|quota|rate|exhausted|resource_exhausted|503|unavailable/i.test(msg);
      if (!isQuota) break;
      const delayMs = parseRetryDelay(msg) || 7000;
      console.log(`[AI] waiting ${delayMs}ms before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { text: 'AI error: ' + ((lastErr && lastErr.message) || 'all keys exhausted') };
}

// ============ STUDY DASHBOARD ============
app.get('/study', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [coursesRes, progressRes, sessionsRes] = await Promise.all([
      pool.query('SELECT * FROM study_courses WHERE user_id = $1 ORDER BY course_name ASC', [uid]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 ORDER BY last_studied DESC', [uid]),
      pool.query('SELECT * FROM study_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [uid])
    ]);
    res.render('study', {
      user: req.session.user, courses: coursesRes.rows,
      progress: progressRes.rows, recentSessions: sessionsRes.rows,
      subjects: []
    });
  } catch (err) {
    console.error('Study page error:', err);
    res.status(500).send('Error loading study page');
  }
});

// ============ COURSE MANAGEMENT ============
app.get('/study/course/:id', isAuth, async (req, res) => {
  try {
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (course.rows.length === 0) return res.status(404).send('Course not found');
    const [topicsRes, sessionsRes, progressRes, flashcardsRes] = await Promise.all([
      pool.query('SELECT * FROM study_topics WHERE course_id = $1 ORDER BY order_index ASC', [req.params.id]),
      pool.query('SELECT * FROM study_sessions WHERE user_id = $1 AND course_id = $2 ORDER BY created_at DESC LIMIT 20', [req.session.user.id, req.params.id]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 AND course_id = $2', [req.session.user.id, req.params.id]),
      pool.query('SELECT COUNT(*) as count FROM study_flashcards WHERE user_id = $1 AND course_id = $2', [req.session.user.id, req.params.id])
    ]);
    res.render('study-course', {
      user: req.session.user, course: course.rows[0],
      topics: topicsRes.rows, sessions: sessionsRes.rows,
      progress: progressRes.rows[0] || null,
      flashcardCount: flashcardsRes.rows[0].count
    });
  } catch (err) {
    console.error('Study course error:', err);
    res.status(500).send('Error loading course');
  }
});

app.post('/api/study/courses/add', isAuth, async (req, res) => {
  try {
    const { courseName, courseCode, unit } = req.body;
    const r = await pool.query(
      'INSERT INTO study_courses (user_id, course_name, course_code, unit) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.session.user.id, courseName, courseCode || '', unit || 3]
    );
    res.json({ success: true, course: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/courses/delete/:id', isAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    await pool.query('DELETE FROM study_topics WHERE course_id = $1', [req.params.id]);
    await pool.query('DELETE FROM study_subtopics WHERE course_id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/import-timetable', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const tt = await pool.query('SELECT DISTINCT course, course_code, unit FROM timetables WHERE user_id = $1', [uid]);
    let count = 0;
    for (const row of tt.rows) {
      const exists = await pool.query('SELECT id FROM study_courses WHERE user_id = $1 AND course_name = $2', [uid, row.course]);
      if (exists.rows.length === 0) {
        await pool.query('INSERT INTO study_courses (user_id, course_name, course_code, unit, source) VALUES ($1, $2, $3, $4, $5)',
          [uid, row.course, row.course_code || '', row.unit || 3, 'timetable']);
        count++;
      }
    }
    res.json({ success: true, imported: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ TOPICS & SUBTOPICS (Scheme of Work) ============
app.post('/api/study/topics/add', isAuth, async (req, res) => {
  try {
    const { courseId, title } = req.body;
    const max = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 as n FROM study_topics WHERE course_id = $1::integer', [courseId]);
    const r = await pool.query(
      'INSERT INTO study_topics (course_id, user_id, title, order_index) VALUES ($1::integer, $2::integer, $3::text, $4::integer) RETURNING *',
      [courseId, req.session.user.id, title, max.rows[0].n]
    );
    res.json({ success: true, topic: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/topics/delete/:id', isAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_topics WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM study_subtopics WHERE topic_id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/subtopics/ai-generate', isAuth, async (req, res) => {
  try {
    const { topicId, courseId, topicTitle, courseName } = req.body;
    const prompt = `For the topic "${topicTitle}" in the course "${courseName}", generate a list of 5-8 specific subtopics that should be studied. 
Return ONLY a JSON array of strings, nothing else. Example: ["Subtopic 1", "Subtopic 2", "Subtopic 3"]`;
    const aiRes = await promptAI(prompt);
    if (aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text });
    let subtopics = [];
    try {
      const cleaned = aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim();
      subtopics = JSON.parse(cleaned);
    } catch {
      subtopics = aiRes.text.split('\n').filter(l => l.trim().match(/^["\w]/)).map(l => l.replace(/^[\d.-\s"']+|["'\s]+$/g, '')).filter(Boolean);
    }
    const uid = req.session.user.id;
    const results = [];
    for (const st of subtopics.slice(0, 10)) {
      const cleanName = st.replace(/^["'\s]+|["'\s]+$/g, '').trim();
      if (!cleanName) continue;
      const r = await pool.query(
        'INSERT INTO study_subtopics (topic_id, course_id, user_id, subtopic_name, title, status) VALUES ($1::integer, $2::integer, $3::integer, $4::text, $5::text, $6::text) RETURNING *',
        [parseInt(topicId) || 0, parseInt(courseId) || 0, parseInt(uid) || 0, cleanName, cleanName, 'pending']
      );
      results.push(r.rows[0]);
    }
    res.json({ success: true, subtopics: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/subtopics/update', isAuth, async (req, res) => {
  try {
    const { id, title, status } = req.body;
    await pool.query('UPDATE study_subtopics SET title = COALESCE($1, title), status = COALESCE($2, status) WHERE id = $3',
      [title, status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/subtopics/delete/:id', isAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_subtopics WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/topics/:courseId', isAuth, async (req, res) => {
  try {
    const topics = await pool.query(
      'SELECT t.*, (SELECT COUNT(*) FROM study_subtopics WHERE topic_id = t.id) as subtopic_count FROM study_topics t WHERE t.course_id = $1 ORDER BY t.order_index ASC',
      [req.params.courseId]
    );
    const subtopics = await pool.query(
      'SELECT * FROM study_subtopics WHERE course_id = $1 ORDER BY topic_id, id ASC',
      [req.params.courseId]
    );
    res.json({ topics: topics.rows, subtopics: subtopics.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STUDY SESSIONS ============
app.get('/study/session/:id', isAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM study_sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).send('Session not found');
    const videos = await pool.query('SELECT * FROM study_youtube_videos WHERE subtopic_id = $1 ORDER BY created_at DESC LIMIT 10',
      [result.rows[0].subtopic_id]);
    res.render('study-session', {
      user: req.session.user, session: result.rows[0],
      videos: videos.rows
    });
  } catch (err) {
    console.error('Study session error:', err);
    res.status(500).send('Error loading session');
  }
});

app.post('/api/study/sessions/start', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId, courseName, durationMinutes } = req.body;
    const r = await pool.query(
      `INSERT INTO study_sessions (user_id, course_id, subtopic_id, course_name, duration_minutes, status)
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
      [req.session.user.id, courseId || 0, subtopicId || 0, courseName || 'General Study', durationMinutes || 60]
    );
    res.json({ success: true, session: r.rows[0], redirect: `/study/session/${r.rows[0].id}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/sessions/end', isAuth, async (req, res) => {
  try {
    const { sessionId, elapsedSeconds, notes } = req.body;
    await pool.query(
      `UPDATE study_sessions SET status = 'completed', elapsed_seconds = $1, notes = $2, completed_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [elapsedSeconds || 0, notes || '', sessionId, req.session.user.id]
    );
    const s = (await pool.query('SELECT * FROM study_sessions WHERE id = $1', [sessionId])).rows[0];
    if (s) {
      const mins = Math.ceil((elapsedSeconds || 0) / 60);
      await pool.query(
        `INSERT INTO study_progress (user_id, course_id, course_name, total_sessions, total_minutes, last_studied)
         VALUES ($1, $2, $3, 1, $4, NOW())
         ON CONFLICT (user_id, course_name) DO UPDATE SET
           total_sessions = study_progress.total_sessions + 1,
           total_minutes = study_progress.total_minutes + $4,
           last_studied = NOW()`,
        [s.user_id, s.course_id, s.course_name, mins]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/study/sessions/update', isAuth, async (req, res) => {
  try {
    const { sessionId, elapsedSeconds, notes } = req.body;
    await pool.query(
      `UPDATE study_sessions SET elapsed_seconds = $1, notes = COALESCE($2, notes) WHERE id = $3 AND user_id = $4`,
      [elapsedSeconds || 0, notes || null, sessionId, req.session.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ AI STUDY CHAT ============
app.post('/api/study/chat', isAuth, async (req, res) => {
  try {
    const { message, courseId, subtopicId, courseName } = req.body;
    const uid = req.session.user.id;
    await pool.query(
      'INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, $2, $3, $4, $5)',
      [uid, courseId || 0, subtopicId || 0, 'user', message]
    );
    const context = courseName ? `Context: Student is studying "${courseName}". ` : '';
    const prompt = `${context}You are a helpful study assistant for university students. 
Answer the following question clearly and concisely. Include explanations, examples, and study tips where relevant.

Student's question: ${message}

Provide a thorough, educational response. If the question involves formulas or technical concepts, explain them step by step.`;
    const aiRes = await promptAI(prompt);
    const reply = aiRes.text;
    await pool.query(
      'INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, $2, $3, $4, $5)',
      [uid, courseId || 0, subtopicId || 0, 'ai', reply]
    );
    res.json({ success: true, reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/chat/history', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId } = req.query;
    let query = 'SELECT * FROM study_chat_messages WHERE user_id = $1';
    const params = [req.session.user.id];
    if (courseId) { query += ' AND course_id = $2'; params.push(courseId); }
    if (subtopicId) { query += subtopicId ? ` AND subtopic_id = $${params.length + 1}` : ''; if (subtopicId) params.push(subtopicId); }
    query += ' ORDER BY created_at ASC LIMIT 100';
    const r = await pool.query(query, params);
    res.json({ messages: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ YOUTUBE VIDEOS ============
app.post('/api/study/youtube/search', isAuth, async (req, res) => {
  try {
    const { query: searchQuery, subtopicId, courseId } = req.body;
    const prompt = `Generate a list of 5 YouTube video search queries for studying the topic: "${searchQuery}".
Return ONLY a JSON array of strings with search terms. Example: ["term1", "term2", "term3", "term4", "term5"]`;
    const aiRes = await promptAI(prompt);
    let terms = [];
    try {
      terms = JSON.parse(aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
      terms = [searchQuery];
    }
    const html = terms.map((t, i) => {
      const encoded = encodeURIComponent(t);
      return `<div class="yt-card" onclick="window.open('https://www.youtube.com/results?search_query=${encoded}','_blank')">
        <i class="fab fa-youtube" style="color:#ff0000;font-size:1.5rem;"></i>
        <div><strong>${t}</strong><br><span style="font-size:0.75rem;color:var(--text-sub)">Click to search on YouTube</span></div>
      </div>`;
    }).join('');
    if (subtopicId && subtopicId > 0) {
      for (const t of terms.slice(0, 3)) {
        await pool.query(
          'INSERT INTO study_youtube_videos (course_id, subtopic_id, title, url) VALUES ($1, $2, $3, $4)',
          [courseId || 0, subtopicId, t, `https://www.youtube.com/results?search_query=${encodeURIComponent(t)}`]
        );
      }
    }
    res.json({ success: true, html, terms });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ AI QUIZ GENERATION ============
app.post('/api/study/quiz/generate', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId, topicTitle, questionType, questionCount, timeLimit } = req.body;
    const count = parseInt(questionCount) || 10;
    const uid = req.session.user.id;

    const prompt = `Generate ${count} ${questionType || 'multiple_choice'} questions about "${topicTitle}" for university exam preparation.
For each question include:
- The question text
- 4 answer options (for multiple choice) or a short answer (for theory)
- The correct answer
- A detailed explanation

Return as JSON array: [{ "question": "...", "options": ["A...", "B...", "C...", "D..."], "correctAnswer": "A", "explanation": "..." }]
For theory questions, use options: [] and correctAnswer as the expected answer.`;

    const aiRes = await promptAI(prompt);
    let questions = [];
    try {
      const cleaned = aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim();
      questions = JSON.parse(cleaned);
    } catch {
      throw new Error('Failed to parse AI response. Please try again.');
    }

    const attempt = await pool.query(
      `INSERT INTO study_quiz_attempts (user_id, course_id, subtopic_id, question_type, question_count, time_limit, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress') RETURNING *`,
      [uid, courseId || 0, subtopicId || 0, questionType || 'multiple_choice', questions.length, timeLimit || 0]
    );
    const attemptId = attempt.rows[0].id;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await pool.query(
        `INSERT INTO study_quiz_questions (attempt_id, question, options, correct_answer, explanation, order_index)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [attemptId, q.question, JSON.stringify(q.options || []), q.correctAnswer, q.explanation || '', i]
      );
    }

    res.json({ success: true, attempt: attempt.rows[0], questions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/study/quiz/:attemptId', isAuth, async (req, res) => {
  try {
    const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1 AND user_id = $2',
      [req.params.attemptId, req.session.user.id]);
    if (attempt.rows.length === 0) return res.status(404).send('Quiz not found');
    const questions = await pool.query(
      'SELECT id, question, options, order_index FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC',
      [req.params.attemptId]
    );
    res.render('study-quiz', {
      user: req.session.user, attempt: attempt.rows[0],
      questions: questions.rows
    });
  } catch (err) {
    res.status(500).send('Error loading quiz');
  }
});

app.post('/api/study/quiz/submit', isAuth, async (req, res) => {
  try {
    const { attemptId, answers } = req.body;
    let score = 0;
    for (const a of answers) {
      const q = await pool.query('SELECT * FROM study_quiz_questions WHERE id = $1 AND attempt_id = $2',
        [a.questionId, attemptId]);
      if (q.rows.length > 0) {
        const isCorrect = String(a.answer).trim().toUpperCase() === String(q.rows[0].correct_answer).trim().toUpperCase();
        if (isCorrect) score++;
        await pool.query(
          'UPDATE study_quiz_questions SET user_answer = $1, is_correct = $2 WHERE id = $3',
          [a.answer, isCorrect, a.questionId]
        );
      }
    }
    const total = (await pool.query('SELECT COUNT(*) as c FROM study_quiz_questions WHERE attempt_id = $1', [attemptId])).rows[0].c;
    await pool.query(
      `UPDATE study_quiz_attempts SET score = $1, total_questions = $2, status = 'completed', completed_at = NOW() WHERE id = $3`,
      [score, total, attemptId]
    );
    res.json({ success: true, score, total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/quiz/result/:attemptId', isAuth, async (req, res) => {
  try {
    const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1 AND user_id = $2',
      [req.params.attemptId, req.session.user.id]);
    const questions = await pool.query(
      'SELECT * FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC',
      [req.params.attemptId]
    );
    res.json({ attempt: attempt.rows[0], questions: questions.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ FLASHCARDS ============
app.get('/study/flashcards/:courseId', isAuth, async (req, res) => {
  try {
    res.render('study-flashcards', { user: req.session.user, courseId: parseInt(req.params.courseId) });
  } catch (err) {
    res.status(500).send('Error loading flashcards');
  }
});

app.post('/api/study/flashcards/generate', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId, topicTitle } = req.body;
    const uid = req.session.user.id;
    const prompt = `Generate 10 flashcards for studying "${topicTitle}". 
Each flashcard should have a front (question/term) and back (answer/definition).
Return ONLY a JSON array: [{ "front": "...", "back": "..." }]`;
    const aiRes = await promptAI(prompt);
    let cards = [];
    try {
      cards = JSON.parse(aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim());
    } catch {
      throw new Error('Failed to generate flashcards');
    }
    for (const c of cards) {
      await pool.query(
        'INSERT INTO study_flashcards (user_id, course_id, subtopic_id, front, back) VALUES ($1, $2, $3, $4, $5)',
        [uid, courseId || 0, subtopicId || 0, c.front, c.back]
      );
    }
    res.json({ success: true, count: cards.length, cards });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/flashcards', isAuth, async (req, res) => {
  try {
    const { courseId } = req.query;
    let q = 'SELECT * FROM study_flashcards WHERE user_id = $1';
    const p = [req.session.user.id];
    if (courseId) { q += ' AND course_id = $2'; p.push(courseId); }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    res.json({ flashcards: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/study/flashcards/delete/:id', isAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_flashcards WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ STUDY STATS & PROGRESS ============
app.get('/api/study/stats', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [ts, tm, ad, tc, fc] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM study_sessions WHERE user_id = $1 AND status = $2', [uid, 'completed']),
      pool.query('SELECT COALESCE(SUM(elapsed_seconds), 0) as t FROM study_sessions WHERE user_id = $1 AND status = $2', [uid, 'completed']),
      pool.query('SELECT COUNT(DISTINCT session_date) as d FROM study_sessions WHERE user_id = $1 AND status = $2', [uid, 'completed']),
      pool.query('SELECT COUNT(*) as c FROM study_courses WHERE user_id = $1', [uid]),
      pool.query('SELECT COUNT(*) as c FROM study_flashcards WHERE user_id = $1', [uid])
    ]);
    res.json({
      totalSessions: parseInt(ts.rows[0].c), totalMinutes: Math.floor(parseInt(tm.rows[0].t) / 60),
      activeDays: parseInt(ad.rows[0].d), totalCourses: parseInt(tc.rows[0].c),
      totalFlashcards: parseInt(fc.rows[0].c)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/study/courses', isAuth, async (req, res) => {
  try {
    const courses = await pool.query('SELECT * FROM study_courses WHERE user_id = $1 ORDER BY course_name ASC', [req.session.user.id]);
    res.json({ courses: courses.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SUBTOPIC DETAIL (AI class, videos, quick quiz) ============
app.get('/api/study/subtopic/:id', isAuth, async (req, res) => {
  try {
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (st.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const videos = await pool.query('SELECT * FROM study_youtube_videos WHERE subtopic_id = $1 ORDER BY created_at DESC LIMIT 5', [req.params.id]);
    const flashcards = await pool.query('SELECT * FROM study_flashcards WHERE subtopic_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json({ subtopic: st.rows[0], videos: videos.rows, flashcards: flashcards.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CGPA ENHANCEMENT: Auto-fill from study courses ============
app.post('/api/study/cgpa-sync', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const courses = await pool.query('SELECT * FROM study_courses WHERE user_id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) {
      return res.json({ success: false, error: 'Set up CGPA profile first (visit /cgpa).' });
    }
    let synced = 0;
    const level = parseInt(profile.rows[0].current_level) || 300;
    for (const c of courses.rows) {
      const courseKey = (c.course_code || c.course_name || '').trim();
      if (!courseKey) continue;
      const exists = await pool.query(
        'SELECT id FROM cgpa_courses WHERE user_id = $1 AND course_code = $2 AND deleted = false',
        [uid, courseKey]
      );
      if (exists.rows.length === 0) {
        await pool.query(
          `INSERT INTO cgpa_courses (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)`,
          [uid, courseKey, c.course_name, level, 1, parseInt(c.unit) || 3, 'A']
        );
        synced++;
      }
    }
    res.json({ success: true, synced });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ EXPORT ============
app.get('/api/study/export/:courseId', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const course = (await pool.query('SELECT * FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.courseId, uid])).rows[0];
    if (!course) return res.status(404).json({ error: 'Not found' });
    const topics = await pool.query('SELECT * FROM study_topics WHERE course_id = $1 ORDER BY order_index', [req.params.courseId]);
    const subtopics = await pool.query('SELECT * FROM study_subtopics WHERE course_id = $1 ORDER BY id', [req.params.courseId]);
    const flashcards = await pool.query('SELECT * FROM study_flashcards WHERE course_id = $1 AND user_id = $2', [req.params.courseId, uid]);
    const progress = await pool.query('SELECT * FROM study_progress WHERE course_id = $1 AND user_id = $2', [req.params.courseId, uid]);
    const sessions = await pool.query('SELECT * FROM study_sessions WHERE course_id = $1 AND user_id = $2 ORDER BY created_at DESC', [req.params.courseId, uid]);
    const quizAttempts = await pool.query('SELECT * FROM study_quiz_attempts WHERE course_id = $1 AND user_id = $2 ORDER BY created_at DESC', [req.params.courseId, uid]);
    res.json({
      course, topics, subtopics: subtopics.rows,
      flashcards: flashcards.rows, progress: progress.rows[0] || null,
      sessions: sessions.rows, quizAttempts: quizAttempts.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Study server error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Study server running on http://localhost:${PORT}`);
});
