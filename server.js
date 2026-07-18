require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        subject_id INTEGER DEFAULT 0,
        course_name VARCHAR(255) NOT NULL DEFAULT '',
        duration_minutes INTEGER DEFAULT 0,
        elapsed_seconds INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        notes TEXT DEFAULT '',
        session_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS study_progress (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        subject_id INTEGER DEFAULT 0,
        course_name VARCHAR(255) NOT NULL DEFAULT '',
        total_sessions INTEGER DEFAULT 0,
        total_minutes INTEGER DEFAULT 0,
        last_studied TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('[DB] study tables ready');
  } catch (err) {
    console.error('[DB] study tables setup:', err.message);
  }
})();

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
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const isAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

app.get('/study', isAuth, async (req, res) => {
  try {
    const [subjectsRes, coursesRes, progressRes] = await Promise.all([
      pool.query('SELECT * FROM subjects ORDER BY name ASC'),
      pool.query('SELECT * FROM user_courses WHERE user_id = $1 ORDER BY course_name ASC', [req.session.user.id]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 ORDER BY last_studied DESC', [req.session.user.id])
    ]);
    res.render('study', {
      user: req.session.user,
      subjects: subjectsRes.rows,
      courses: coursesRes.rows,
      progress: progressRes.rows
    });
  } catch (err) {
    console.error('Study page error:', err);
    res.status(500).send('Error loading study page');
  }
});

app.get('/study/course/:id', isAuth, async (req, res) => {
  try {
    const course = await pool.query('SELECT * FROM user_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (course.rows.length === 0) return res.status(404).send('Course not found');
    const [sessionsRes, progressRes] = await Promise.all([
      pool.query('SELECT * FROM study_sessions WHERE user_id = $1 AND course_name = $2 ORDER BY created_at DESC',
        [req.session.user.id, course.rows[0].course_name]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 AND course_name = $2',
        [req.session.user.id, course.rows[0].course_name])
    ]);
    res.render('study-course', {
      user: req.session.user,
      course: course.rows[0],
      sessions: sessionsRes.rows,
      progress: progressRes.rows[0] || null
    });
  } catch (err) {
    console.error('Study course error:', err);
    res.status(500).send('Error loading course');
  }
});

app.get('/study/session/:id', isAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM study_sessions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).send('Session not found');
    res.render('study-session', {
      user: req.session.user,
      session: result.rows[0]
    });
  } catch (err) {
    console.error('Study session error:', err);
    res.status(500).send('Error loading session');
  }
});

app.post('/api/study/sessions/start', isAuth, async (req, res) => {
  try {
    const { courseName, subjectId, durationMinutes } = req.body;
    const result = await pool.query(
      `INSERT INTO study_sessions (user_id, subject_id, course_name, duration_minutes, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
      [req.session.user.id, subjectId || 0, courseName || 'General Study', durationMinutes || 60]
    );
    res.json({ success: true, session: result.rows[0] });
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
    const session = await pool.query('SELECT * FROM study_sessions WHERE id = $1', [sessionId]);
    if (session.rows.length > 0) {
      const s = session.rows[0];
      const mins = Math.ceil((elapsedSeconds || 0) / 60);
      await pool.query(
        `INSERT INTO study_progress (user_id, subject_id, course_name, total_sessions, total_minutes, last_studied)
         VALUES ($1, $2, $3, 1, $4, NOW())
         ON CONFLICT (user_id, course_name) DO UPDATE SET
           total_sessions = study_progress.total_sessions + 1,
           total_minutes = study_progress.total_minutes + $4,
           last_studied = NOW()`,
        [s.user_id, s.subject_id, s.course_name, mins]
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
      `UPDATE study_sessions SET elapsed_seconds = $1, notes = COALESCE($2, notes)
       WHERE id = $3 AND user_id = $4`,
      [elapsedSeconds || 0, notes || null, sessionId, req.session.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/progress', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM study_progress WHERE user_id = $1 ORDER BY last_studied DESC',
      [req.session.user.id]
    );
    const total = result.rows.reduce((sum, p) => sum + p.total_minutes, 0);
    res.json({ progress: result.rows, totalMinutes: total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

app.get('/api/study/sessions', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM study_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.session.user.id]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.get('/api/study/sessions/recent', isAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ss.*, sp.total_minutes, sp.total_sessions
       FROM study_sessions ss
       LEFT JOIN study_progress sp ON sp.user_id = ss.user_id AND sp.course_name = ss.course_name
       WHERE ss.user_id = $1
       ORDER BY ss.created_at DESC LIMIT 10`,
      [req.session.user.id]
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recent sessions' });
  }
});

app.get('/api/study/stats', isAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [totalSessions, totalMinutes, streakRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM study_sessions WHERE user_id = $1 AND status = $2`, [userId, 'completed']),
      pool.query(`SELECT COALESCE(SUM(elapsed_seconds), 0) as total FROM study_sessions WHERE user_id = $1 AND status = $2`, [userId, 'completed']),
      pool.query(`SELECT COUNT(DISTINCT session_date) as days FROM study_sessions WHERE user_id = $1 AND status = $2`, [userId, 'completed'])
    ]);
    res.json({
      totalSessions: parseInt(totalSessions.rows[0].count),
      totalMinutes: Math.floor(parseInt(totalMinutes.rows[0].total) / 60),
      activeDays: parseInt(streakRes.rows[0].days)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Study server running on http://localhost:${PORT}`);
});
