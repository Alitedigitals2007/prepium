const express = require('express');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();

const app = express();
const multer = require('multer');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Premium price (configurable via env)
const PREMIUM_PRICE = parseInt(process.env.PREMIUM_PRICE) || 2000;

const pdfToText = require('pdf-to-text');

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'uploads', 'materials');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
            cb(null, uniqueName);
        }
    }),
    limits: { fileSize: 100 * 1024 * 1024 }
});

// Memory storage for timetable extraction (need buffer)
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }
});

const pgSession = require('connect-pg-simple')(session);

// Simple in-memory rate limiter
const rateLimitStore = {};
function rateLimit(maxRequests = 10, windowMs = 60000) {
    return (req, res, next) => {
        const key = req.ip + req.path;
        const now = Date.now();
        if (!rateLimitStore[key] || now - rateLimitStore[key].start > windowMs) {
            rateLimitStore[key] = { start: now, count: 1 };
            return next();
        }
        rateLimitStore[key].count++;
        if (rateLimitStore[key].count > maxRequests) {
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        next();
    };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  family: 4
});

// Handle pool errors gracefully
pool.on('error', (err) => {
    console.error('[DB] Pool error:', err.message);
});

// Test database connection on startup
(async () => {
    try {
        await pool.query('SELECT 1');
        console.log('[DB] Connected to PostgreSQL successfully');
    } catch (err) {
        console.error('[DB] CONNECTION FAILED:', err.message);
        console.error('[DB] Please check your DATABASE_URL in .env file');
        console.error('[DB] Get correct URL from: https://console.neon.tech');
    }
})();

// Auto-create student_materials table if it doesn't exist
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS student_materials (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT DEFAULT '',
                file_type VARCHAR(100),
                file_size INTEGER,
                file_path TEXT,
                file_data BYTEA,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Add file_path column to existing tables if missing
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE student_materials ADD COLUMN IF NOT EXISTS file_path TEXT;
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
        console.log('[DB] student_materials table ready');
    } catch (err) {
        console.error('[DB] student_materials table setup:', err.message);
    }
})();

// Auto-create user_sessions table for PostgreSQL session store
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "user_sessions" (
                "sid" varchar NOT NULL COLLATE "default",
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL,
                CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
            );
            CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
        `);
        console.log('[DB] user_sessions table ready');
    } catch (err) {
        console.error('[DB] user_sessions table setup:', err.message);
    }
})();

// Auto-create reading_timetables and reading_settings tables
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reading_timetables (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                course VARCHAR(255) NOT NULL,
                course_code VARCHAR(50) DEFAULT '',
                unit INTEGER DEFAULT 3,
                day VARCHAR(20) NOT NULL,
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                source VARCHAR(20) DEFAULT 'school',
                week_start DATE DEFAULT CURRENT_DATE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reading_settings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE NOT NULL,
                use_school_timetable BOOLEAN DEFAULT true,
                daily_hours DECIMAL(4,1) DEFAULT 3.0,
                session_minutes INTEGER DEFAULT 45,
                sessions_per_course INTEGER DEFAULT 2,
                preferred_time_start TIME DEFAULT '09:00',
                preferred_time_end TIME DEFAULT '21:00',
                excluded_courses TEXT[] DEFAULT '{}',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE timetables ADD COLUMN IF NOT EXISTS course_code VARCHAR(50) DEFAULT '';
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE timetables ADD COLUMN IF NOT EXISTS unit INTEGER DEFAULT 3;
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
        console.log('[DB] reading_timetables & reading_settings tables ready');
    } catch (err) {
        console.error('[DB] reading tables setup:', err.message);
    }
})();

// ── Auto-create login_streaks ────────────────────────────────────────────────
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS login_streaks (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE NOT NULL,
                current_streak INTEGER DEFAULT 0,
                longest_streak INTEGER DEFAULT 0,
                last_login_date DATE DEFAULT CURRENT_DATE,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('[DB] login_streaks table ready');
    } catch (err) {
        console.error('[DB] login_streaks setup:', err.message);
    }
})();

// ── Auto-create daily_task_items & personal_goals & weekly_analytics ────────
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS personal_goals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                goal TEXT NOT NULL,
                target_date DATE,
                is_completed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_task_items (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                task_date DATE DEFAULT CURRENT_DATE,
                task_type VARCHAR(50) NOT NULL,
                task_label TEXT NOT NULL,
                is_done BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS weekly_analytics (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                week_start DATE NOT NULL,
                total_tasks INTEGER DEFAULT 0,
                completed_tasks INTEGER DEFAULT 0,
                study_minutes INTEGER DEFAULT 0,
                quiz_count INTEGER DEFAULT 0,
                avg_score DECIMAL(5,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, week_start)
            )
        `);
        console.log('[DB] daily_task_items, personal_goals, weekly_analytics tables ready');
    } catch (err) {
        console.error('[DB] daily task tables setup:', err.message);
    }
})();

// ── Auto-create deadlines table ─────────────────────────────────────────────
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS deadlines (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL,
                due_date DATE NOT NULL,
                due_time TIME NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_deadlines_user_date ON deadlines(user_id, due_date)`);
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS due_time TIME;
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
        console.log('[DB] deadlines table ready');
    } catch (err) {
        console.error('[DB] deadlines table setup:', err.message);
    }
})();

// Auto-create quiz_results if it doesn't have title column (used by save-ai-quiz-results)
(async () => {
    try {
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE quiz_results ADD COLUMN IF NOT EXISTS title VARCHAR(500);
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
    } catch (err) { /* ignore */ }
})();

// Auto-create payout_requests table for ambassador withdrawals
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS payout_requests (
                id SERIAL PRIMARY KEY,
                ambassador_id INTEGER NOT NULL,
                amount_requested NUMERIC(12,2) NOT NULL,
                fee_amount NUMERIC(12,2) NOT NULL,
                net_payout NUMERIC(12,2) NOT NULL,
                bank_details TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                processed_at TIMESTAMP,
                processed_by VARCHAR(255)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_payout_requests_amb ON payout_requests(ambassador_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status)`);
        console.log('[DB] payout_requests table ready');
    } catch (err) {
        console.error('[DB] payout_requests table setup:', err.message);
    }
})();

// Auto-create missing columns on ambassadors
(async () => {
    try {
        await pool.query(`
            DO $$ BEGIN
                ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS active_invite_count INTEGER DEFAULT 0;
                ALTER TABLE ambassadors ADD COLUMN IF NOT EXISTS free_invite_count INTEGER DEFAULT 0;
            EXCEPTION WHEN duplicate_column THEN null;
            END $$;
        `);
    } catch (err) { /* ignore */ }
})();

// Auto-create user_groups table for admin email grouping
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_groups (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_group_members (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(group_id, user_id)
            )
        `);
        console.log('[DB] user_groups tables ready');
    } catch (err) {
        console.error('[DB] user_groups setup:', err.message);
    }
})();

// Auto-create user_courses table
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_courses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                course_name VARCHAR(255) NOT NULL,
                course_code VARCHAR(50) DEFAULT '',
                unit INTEGER DEFAULT 3,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('[DB] user_courses table ready');
    } catch (err) {
        console.error('[DB] user_courses setup:', err.message);
    }
})();

const transporter = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
    : null;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('view cache');

// Paystack webhook needs raw body BEFORE express.json() consumes it
app.post('/paystack-webhook', express.raw({ type: '*/*' }), async (req, res) => {
    try {
        const secret = process.env.PAYSTACK_SECRET_KEY;
        if (!secret) return res.status(500).send('Server config missing');

        const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
        if (hash !== req.headers['x-paystack-signature']) {
            return res.status(401).send('Invalid signature');
        }

        const event = JSON.parse(req.body.toString());
        if (event.event === 'charge.success') {
            const data = event.data;
            const ref = data.reference;
            const userId = data.metadata?.user_id;
            const couponCode = data.metadata?.coupon_code || null;

            if (!userId) {
                console.log('[Paystack Webhook] No user_id in metadata for', ref);
                return res.sendStatus(200);
            }

            const userCheck = await pool.query('SELECT has_paid, used_coupon FROM users WHERE id = $1', [userId]);
            if (userCheck.rows[0]?.has_paid) return res.sendStatus(200);

            const finalCoupon = (!userCheck.rows[0]?.used_coupon && couponCode) ? couponCode : null;
            await pool.query(
                'UPDATE users SET has_paid = true, used_coupon = COALESCE($1, used_coupon) WHERE id = $2',
                [finalCoupon, userId]
            );

            const amount = data.amount || 0;
            try {
                await pool.query(
                    `INSERT INTO payments (user_id, reference, amount, currency, status, coupon_code, channel, metadata, verified_at)
                     VALUES ($1,$2,$3,$4,'success',$5,$6,$7,NOW())
                     ON CONFLICT (reference) DO UPDATE SET status='success', verified_at=NOW()`,
                    [userId, ref, amount, data.currency || 'NGN', finalCoupon || '', data.channel || '', JSON.stringify(data)]
                );
            } catch (_) {}

            if (finalCoupon) {
                try { await pool.query('UPDATE coupons SET times_used = times_used + 1 WHERE LOWER(code) = LOWER($1)', [finalCoupon]); } catch (_) {}
            }

            const uniqueCode = await pool.query('SELECT unique_code FROM users WHERE id = $1', [userId]);
            if (uniqueCode.rows[0]?.unique_code) {
                const codeClean = uniqueCode.rows[0].unique_code.trim().toLowerCase();
                const amb = await pool.query('SELECT id, name FROM ambassadors WHERE LOWER(TRIM(unique_code)) = $1', [codeClean]);
                if (amb.rows[0]) {
                    const commission = Math.round(PREMIUM_PRICE * 0.15);
                    await pool.query('UPDATE ambassadors SET total_earned = CAST(COALESCE(total_earned,0) AS INTEGER) + $1, total_referrals = CAST(COALESCE(total_referrals,0) AS INTEGER) + 1 WHERE id = $2', [commission, amb.rows[0].id]);
                }
            }

            console.log(`[Paystack Webhook] User ${userId} activated via webhook (ref: ${ref})`);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('[Paystack Webhook] Error:', e.message);
        res.sendStatus(200);
    }
});

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Add this line directly ABOVE your app.use(session({...})) middleware declaration
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    }
}));

// Middleware to check if user is logged in
const isAuth = (req, res, next) => {
    if (req.session.user) return next();
    if (req.xhr || req.headers.accept?.includes('json') || req.headers['content-type']?.includes('multipart') || req.headers['content-type']?.includes('json') || req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    res.redirect('/login');
};

// Middleware to check payment status
const hasPaid = (req, res, next) => {
    if (req.session.user.has_paid) return next();
    res.redirect('/dashboard');
};

const requirePaid = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    if (req.session.user.has_paid === true) return next();
    pool.query('SELECT has_paid FROM users WHERE id = $1', [req.session.user.id]).then(function(dbUser) {
        if (dbUser.rows[0]?.has_paid) {
            req.session.user.has_paid = true;
            return next();
        }
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/')) {
            return res.status(402).json({ success: false, message: 'Premium required', premium_required: true });
        }
        return res.redirect('/dashboard?msg=Premium+feature.+Tap+%22Unlock+Premium%22+to+continue');
    }).catch(function() {
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/')) {
            return res.status(402).json({ success: false, message: 'Premium required', premium_required: true });
        }
        return res.redirect('/dashboard?msg=Premium+feature.+Tap+%22Unlock+Premium%22+to+continue');
    });
};

const isAdmin = (req, res, next) => {
    // Check if the session user exists AND the is_admin flag is true
    if (req.session.user && req.session.user.is_admin === true) {
        return next();
    }

    // If they aren't an admin, they stay out
    res.status(403).send("Access Denied: Admins Only");
};

// ======================== SEO Middleware ========================
const BASE_URL = 'https://theprepium.vercel.app';

app.use(function seoDefaults(req, res, next) {
  res.locals.seo = {
    title: 'Prepium | Smart Exam Mastery',
    description: 'Your Academic CBT Practice Platform — master exams with AI-powered study tools, quizzes, and personalized learning.',
    url: BASE_URL + req.originalUrl,
    image: '/images/og-image.svg',
    type: 'website',
    robots: 'index,follow'
  };
  next();
});

// ======================== robots.txt ========================
app.get('/robots.txt', function (req, res) {
  res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: ' + BASE_URL + '/sitemap.xml\n');
});

// ======================== sitemap.xml ========================
app.get('/sitemap.xml', async function (req, res) {
  try {
    const pages = [
      { loc: BASE_URL + '/', priority: '1.0', changefreq: 'weekly' },
      { loc: BASE_URL + '/guide', priority: '0.6', changefreq: 'monthly' },
      { loc: BASE_URL + '/how-it-works', priority: '0.7', changefreq: 'monthly' },
      { loc: BASE_URL + '/signup', priority: '0.5', changefreq: 'monthly' },
      { loc: BASE_URL + '/login', priority: '0.5', changefreq: 'monthly' }
    ];
    const courses = await pool.query("SELECT id, course_name, updated_at FROM study_courses ORDER BY id").catch(() => ({ rows: [] }));
    for (const c of courses.rows) {
      pages.push({ loc: BASE_URL + '/study/course/' + c.id, priority: '0.8', changefreq: 'weekly', lastmod: c.updated_at });
    }
    const topics = await pool.query("SELECT id, topic_name, updated_at FROM study_topics ORDER BY id").catch(() => ({ rows: [] }));
    for (const t of topics.rows) {
      pages.push({ loc: BASE_URL + '/study/topic/' + t.id, priority: '0.7', changefreq: 'weekly', lastmod: t.updated_at });
    }
    const subtopics = await pool.query("SELECT id, subtopic_name, updated_at FROM study_subtopics ORDER BY id").catch(() => ({ rows: [] }));
    for (const s of subtopics.rows) {
      pages.push({ loc: BASE_URL + '/study/subtopic/' + s.id, priority: '0.6', changefreq: 'weekly', lastmod: s.updated_at });
    }
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const p of pages) {
      xml += '  <url>\n    <loc>' + p.loc + '</loc>\n    <priority>' + p.priority + '</priority>\n    <changefreq>' + p.changefreq + '</changefreq>\n';
      if (p.lastmod) xml += '    <lastmod>' + new Date(p.lastmod).toISOString().split('T')[0] + '</lastmod>\n';
      xml += '  </url>\n';
    }
    xml += '</urlset>';
    res.type('application/xml').send(xml);
  } catch (e) {
    res.type('application/xml').status(500).send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

// Generate Test (The Logic)
app.post('/start-test', isAuth, hasPaid, async (req, res) => {
    const { subjectIds, numQuestions } = req.body; // array of IDs
    const query = `
        SELECT q.*, s.name as subject_name 
        FROM questions q 
        JOIN subjects s ON q.subject_id = s.id 
        WHERE q.subject_id = ANY($1) 
        ORDER BY RANDOM() 
        LIMIT $2`;
    
    const testQuestions = await pool.query(query, [subjectIds, numQuestions]);
    req.session.currentTest = testQuestions.rows;
    res.render('test-screen', { questions: testQuestions.rows });
});

// Submit Test
app.post('/submit-test', isAuth, async (req, res) => {
    const userAnswers = req.body.answers; // object {questionId: selectedOption}
    const questions = req.session.currentTest;
    let score = 0;

    questions.forEach(q => {
        if (userAnswers[q.id] === q.correct_option) {
            score++;
        }
    });

    await pool.query('INSERT INTO results (user_id, score, total_questions) VALUES ($1, $2, $3)', 
        [req.session.user.id, score, questions.length]);

    res.render('score-screen', { score, total: questions.length, questions, userAnswers });
});

// Front Page
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/guide', (req, res) => {
    res.locals.seo.title = 'Prepium | User Guide';
    res.locals.seo.description = 'Complete guide to Prepium — learn how to use CBT practice, AI study tools, flashcards, quizzes, and more to ace your exams.';
    res.render('guide', { user: req.session.user || null });
});

// Auth Routes
app.get('/signup', async (req, res) => {
    try {
        // Fetch the list of schools from the database
        const result = await pool.query('SELECT * FROM universities ORDER BY name ASC');
        
        // Pass the results to the EJS template
        res.render('signup', { universities: result.rows });
    } catch (err) {
        console.error("Error loading schools:", err);
        // Fallback to empty array so the page doesn't crash
        res.render('signup', { universities: [] }); 
    }
});

app.post('/auth/signup', rateLimit(5, 60000), async (req, res) => {
    const { fullname, email, password, university_id, referred_by } = req.body; 

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const cleanReferralCode = referred_by ? referred_by.trim().toLowerCase() : null;
        const uniId = university_id ? parseInt(university_id, 10) || null : null;

        // Ensure the array [fullname, email, ..., university_id, ...]
        // matches the $1, $2, $3, $4 order
        await pool.query(
            'INSERT INTO users (fullname, email, password, university_id, unique_code, has_paid) VALUES ($1, $2, $3, $4, $5, $6)',
            [
                fullname,
                email.toLowerCase(),
                hashedPassword,
                uniId,
                cleanReferralCode,
                false
            ]
        );

        res.redirect('/login?msg=Account created! Please login.');

    } catch (err) {
        console.error("Signup Error:", err);
        res.redirect('/signup?error=Error creating account.');
    }
});


// Payment verification handled via GET /verify-payment (Paystack callback)

// --- GET Login Page ---
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// --- POST Login Handler (Updated for AJAX) ---
app.post('/auth/login', rateLimit(10, 60000), async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Find user by email
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            
            // 2. Compare hashed password
            const isMatch = await bcrypt.compare(password, user.password);

            if (isMatch) {
                // 4. Construct Session Object
                req.session.user = { 
                    id: user.id, 
                    fullname: user.fullname, 
                    email: user.email,
                    is_admin: user.is_admin === true, 
                    has_paid: user.has_paid,
                    current_streak: user.current_streak || 0,
                    university_id: user.university_id
                };

                // 5. Explicitly save session before responding
                return req.session.save(async (err) => {
                    if (err) {
                        console.error("Session Save Error:", err);
                        return res.status(500).json({ success: false, message: "Session setup failed" });
                    }

                    // 6. Update login streak
                    try {
                        const today = new Date().toISOString().split('T')[0];
                        const streakRes = await pool.query('SELECT * FROM login_streaks WHERE user_id = $1', [user.id]);
                        if (streakRes.rows.length === 0) {
                            await pool.query('INSERT INTO login_streaks (user_id, current_streak, longest_streak, last_login_date) VALUES ($1, 1, 1, $2)', [user.id, today]);
                            req.session.user.current_streak = 1;
                        } else {
                            const s = streakRes.rows[0];
                            const lastDate = s.last_login_date ? new Date(s.last_login_date).toISOString().split('T')[0] : null;
                            if (lastDate !== today) {
                                const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                                let newStreak = lastDate === yesterday ? (s.current_streak || 0) + 1 : 1;
                                const newLongest = Math.max(newStreak, s.longest_streak || 0);
                                await pool.query('UPDATE login_streaks SET current_streak = $1, longest_streak = $2, last_login_date = $3, updated_at = NOW() WHERE user_id = $4',
                                  [newStreak, newLongest, today, user.id]);
                                req.session.user.current_streak = newStreak;
                            } else {
                                req.session.user.current_streak = s.current_streak;
                            }
                        }
                    } catch (streakErr) {
                        console.error('Streak update error:', streakErr.message);
                    }

                    // 7. Return JSON success with the redirect URL
                    const redirectUrl = req.session.user.is_admin ? '/admin/dashboard' : '/dashboard';
                    return res.status(200).json({ success: true, redirect: redirectUrl });
                });
            }
        }

        // If credentials don't match, return JSON error
        return res.status(401).json({ success: false, message: "Invalid email or password" });
        
    } catch (err) {
        console.error("Critical Login Error:", err);
        res.status(500).json({ success: false, message: "A server error occurred. Please try again." });
    }
});

// ─── Coupon validate API ───
app.post('/api/coupon/validate', isAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const uid = req.session.user.id;
    if (!code || !code.trim()) return res.json({ valid: false, message: 'Enter a coupon code' });

    // Check if this user already used a coupon
    const userCheck = await pool.query('SELECT used_coupon, has_paid FROM users WHERE id = $1', [uid]);
    if (userCheck.rows[0]?.used_coupon) return res.json({ valid: false, message: 'You already used a coupon' });
    if (userCheck.rows[0]?.has_paid) return res.json({ valid: false, message: 'Account is already premium' });

    const c = await pool.query('SELECT * FROM coupons WHERE LOWER(code) = LOWER($1) AND is_active = true AND (max_uses = 0 OR times_used < max_uses) AND (expires_at IS NULL OR expires_at > NOW())', [code.trim()]);
    if (!c.rows[0]) return res.json({ valid: false, message: 'Invalid or expired coupon code' });
    const coupon = c.rows[0];
    let discountLabel = '';
    let finalAmount = PREMIUM_PRICE;
    if (coupon.discount_type === 'percent') {
      finalAmount = Math.round(PREMIUM_PRICE * (100 - coupon.discount_value) / 100);
      discountLabel = coupon.discount_value + '% off';
    } else {
      finalAmount = PREMIUM_PRICE - coupon.discount_value;
      discountLabel = '₦' + coupon.discount_value + ' off';
    }
    finalAmount = Math.max(50, finalAmount);
    res.json({ valid: true, code: coupon.code, discount_type: coupon.discount_type, discount_value: coupon.discount_value, original_amount: PREMIUM_PRICE, final_amount: finalAmount, discountLabel });
  } catch (e) { res.json({ valid: false, message: 'Server error' }); }
});

// ─── Admin: Coupons ───
app.get('/admin/coupons', isAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.render('admin/coupons', { coupons: r.rows });
  } catch (e) { res.status(500).send(e.message); }
});

app.post('/admin/coupons/add', isAdmin, async (req, res) => {
  try {
    const { code, discount_type, discount_value, max_uses, expires_at } = req.body;
    if (!code || !discount_type || !discount_value) return res.redirect('/admin/coupons?error=Missing fields');
    await pool.query('INSERT INTO coupons (code, discount_type, discount_value, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5)', [code.toUpperCase(), discount_type, parseInt(discount_value), parseInt(max_uses) || 0, expires_at || null]);
    res.redirect('/admin/coupons?msg=Created');
  } catch (e) { res.redirect('/admin/coupons?error=' + encodeURIComponent(e.message)); }
});

app.post('/admin/coupons/toggle/:id', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE coupons SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
    res.redirect('/admin/coupons');
  } catch (e) { res.redirect('/admin/coupons?error=' + encodeURIComponent(e.message)); }
});

app.post('/admin/coupons/delete/:id', isAdmin, async (req, res) => {
  try { await pool.query('DELETE FROM coupons WHERE id = $1', [req.params.id]); res.redirect('/admin/coupons'); }
  catch (e) { res.redirect('/admin/coupons?error=' + encodeURIComponent(e.message)); }
});

// Verify Payment (modified to track coupon usage)
app.get('/verify-payment', rateLimit(5, 300000), async (req, res) => {
    const { reference } = req.query;

    if (!req.session.user) {
        return res.redirect('/login');
    }

    if (!reference) {
        return res.redirect('/dashboard?payment=failed&reason=no_reference');
    }

    const userId = req.session.user.id;

    try {
        // 0. Verify the transaction with Paystack API
        const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
        if (!paystackSecret) {
            console.error('[Paystack] Missing PAYSTACK_SECRET_KEY');
            return res.redirect('/dashboard?payment=failed&reason=server_misconfigured');
        }
        const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                'Authorization': `Bearer ${paystackSecret}`,
                'Content-Type': 'application/json'
            }
        });
        const paystackData = await paystackRes.json();

        // Basic sanity check on the response shape
        if (!paystackData || !paystackData.status || !paystackData.data) {
            console.error(`[Paystack] Unexpected response for ${reference}:`, JSON.stringify(paystackData).slice(0, 800));
            return res.redirect('/dashboard?payment=failed&reason=invalid_response');
        }

        console.log(`[Paystack] Verify ${reference}: status=${paystackData.data.status}, amount=${paystackData.data.amount}, currency=${paystackData.data.currency}`);
        if (paystackData.data.status !== 'success') {
            return res.redirect('/dashboard?payment=failed&reason=transaction_not_successful');
        }

        // Server-side amount validation (minimum N50 floor — prevents kobo fraud)
        const paidAmount = paystackData.data.amount / 100;
        if (paidAmount < 50) {
            console.error(`[Paystack] Amount too low for ${reference}: paid N${paidAmount}`);
            return res.redirect('/dashboard?payment=failed&reason=invalid_amount');
        }

        // 1. Fetch user data
        const userQuery = await pool.query(
            'SELECT unique_code, has_paid FROM users WHERE id = $1', 
            [userId]
        );

        if (userQuery.rows.length === 0) {
            return res.redirect('/dashboard?payment=failed&reason=user_not_found');
        }

        const user = userQuery.rows[0];

        // 2. Prevent double-crediting
        if (user.has_paid === true) {
            req.session.user.has_paid = true;
            return res.redirect('/dashboard?payment=success');
        }

        // 3. Mark the user as activated (Paid)
        const couponCode = req.query.coupon || null;
        // Only set used_coupon if not already set (prevents overwriting)
        const userCouponCheck = await pool.query('SELECT used_coupon FROM users WHERE id = $1', [userId]);
        const finalCoupon = (!userCouponCheck.rows[0]?.used_coupon && couponCode) ? couponCode : null;
        const updateRes = await pool.query(
            'UPDATE users SET has_paid = true, used_coupon = COALESCE($1, used_coupon) WHERE id = $2 RETURNING has_paid',
            [finalCoupon, userId]
        );
        console.log(`[Paystack] Success: User ID ${userId} marked as paid (has_paid=${updateRes.rows[0]?.has_paid})${finalCoupon ? ' (coupon: ' + finalCoupon + ')' : ''}.`);

        // 3b. Log payment to payments table
        try {
            await pool.query(
                `INSERT INTO payments (user_id, reference, amount, currency, status, coupon_code, channel, metadata, verified_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
                 ON CONFLICT (reference) DO UPDATE SET status = 'success', verified_at = NOW()`,
                [userId, reference, paidAmount * 100, paystackData.data.currency || 'NGN', 'success',
                 finalCoupon || '', paystackData.data.channel || '', JSON.stringify(paystackData.data)]
            );
        } catch (_) {}

        // 3c. Increment coupon usage if a coupon was used (only on first-time coupon use)
        if (finalCoupon) {
          try { await pool.query('UPDATE coupons SET times_used = times_used + 1 WHERE LOWER(code) = LOWER($1)', [finalCoupon]); } catch (_) {}
        }

        // 4. Update the logged-in session right away
        req.session.user.has_paid = true;
        req.session.save(function() { /* session persisted */ });

        // 5. Credit the Ambassador if a referral code was used
        if (user.unique_code) {
            const codeClean = user.unique_code.trim().toLowerCase();
            console.log(`[Referral Process] Looking for ambassador matching code: "${codeClean}"`);

            // Fetch to get the exact ambassador ID
            const ambCheck = await pool.query(
                'SELECT id, name FROM ambassadors WHERE LOWER(TRIM(unique_code)) = $1',
                [codeClean]
            );

            if (ambCheck.rows.length > 0) {
                const ambassador = ambCheck.rows[0];
                const commission = Math.round(PREMIUM_PRICE * 0.15);
                console.log(`[Referral Match] Adding ₦${commission} (15%) to Ambassador: ${ambassador.name}`);

                await pool.query(
                    `UPDATE ambassadors 
                     SET total_earned = CAST(COALESCE(total_earned, 0) AS INTEGER) + $1, 
                         total_referrals = CAST(COALESCE(total_referrals, 0) AS INTEGER) + 1 
                     WHERE id = $2`,
                    [commission, ambassador.id]
                );
                console.log(`[Success] ₦${commission} credited to Ambassador ID ${ambassador.id}.`);
            } else {
                console.log(`[Warning] No matching ambassador found for code: "${codeClean}"`);
            }
        } else {
            console.log(`[Referral Process] User ID ${userId} did not use a referral code.`);
        }

        // 6. Send them back to the dashboard with success parameter
        res.redirect('/dashboard?payment=success');

    } catch (err) {
        console.error("Paystack Verification Callback Error:", err);
        res.redirect('/dashboard?payment=failed');
    }
});

app.get('/profile', isAuth, async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.redirect('/login');
        }
        const userId = req.session.user.id;
        
        // 1. Get user info JOINED with university data
        const userRes = await pool.query(
            `SELECT u.fullname, u.email, u.has_paid, uni.name as university_name 
             FROM users u 
             LEFT JOIN universities uni ON u.university_id = uni.id 
             WHERE u.id = $1`, 
            [userId]
        );
        const user = userRes.rows[0];

        // Also update streak on profile visit if it's a new day
        try {
          const today = new Date().toISOString().split('T')[0];
          const sr = await pool.query('SELECT * FROM login_streaks WHERE user_id = $1', [userId]);
          if (sr.rows.length > 0) {
            const s = sr.rows[0];
            const lastDate = s.last_login_date ? new Date(s.last_login_date).toISOString().split('T')[0] : null;
            if (lastDate && lastDate !== today) {
              const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
              let newStreak = lastDate === yesterday ? (s.current_streak || 0) + 1 : 1;
              let newLongest = Math.max(newStreak, s.longest_streak || 0);
              await pool.query('UPDATE login_streaks SET current_streak = $1, longest_streak = $2, last_login_date = $3, updated_at = NOW() WHERE user_id = $4',
                [newStreak, newLongest, today, userId]);
              if (req.session.user) req.session.user.current_streak = newStreak;
            }
          }
        } catch (e) { console.error('Profile streak update:', e.message); }

        // 2. Get Stats from quiz_results
        const statsRes = await pool.query(
            'SELECT COUNT(*) as total_tests, AVG(percentage) as avg_score FROM quiz_results WHERE user_id = $1',
            [userId]
        );
        const statsRow = statsRes.rows[0];

        // 3. Get CGPA Profiles Metrics
        const cgpaProfileRes = await pool.query(
            'SELECT department, grading_scale, prev_units, prev_gp FROM public.cgpa_profiles WHERE user_id = $1',
            [userId]
        );
        const cgpaProfile = cgpaProfileRes.rows[0];

        // 4. Get Course Listing to Compute Dynamic Running Real-time Standing
        const coursesRes = await pool.query(
            'SELECT credit_units, grade FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false',
            [userId]
        );

        // Grade Value Points Map mapping scale logic seamlessly
        const scale = cgpaProfile ? parseInt(cgpaProfile.grading_scale) : 5;
        const gradePointsMap = scale === 4 
            ? { 'A': 4, 'B': 3, 'C': 2, 'D': 1, 'E': 0, 'F': 0 }
            : { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'E': 1, 'F': 0 };

        let totalUnits = cgpaProfile ? parseInt(cgpaProfile.prev_units) : 0;
        let totalPoints = cgpaProfile ? parseFloat(cgpaProfile.prev_gp) : 0.00;

        coursesRes.rows.forEach(course => {
            const units = parseInt(course.credit_units) || 0;
            const gradeLetter = (course.grade || 'F').toUpperCase();
            const pointValue = gradePointsMap[gradeLetter] !== undefined ? gradePointsMap[gradeLetter] : 0;
            
            totalUnits += units;
            totalPoints += (units * pointValue);
        });

        const calculatedCGPA = totalUnits > 0 ? parseFloat((totalPoints / totalUnits).toFixed(2)) : 0.00;

        // 5. Get login streak data
        const streakRes = await pool.query('SELECT * FROM login_streaks WHERE user_id = $1', [userId]);
        const streak = streakRes.rows[0] || { current_streak: 0, longest_streak: 0 };

        // 6. Get study stats
        const studyRes = await pool.query('SELECT COALESCE(SUM(total_minutes), 0) as mins FROM study_progress WHERE user_id = $1', [userId]);

        res.render('profile', { 
            user, 
            cgpaProfile: cgpaProfile || null,
            calculatedCGPA,
            streak,
            studyMinutes: parseInt(studyRes.rows[0].mins),
            stats: {
                total: parseInt(statsRow.total_tests) || 0,
                average: Math.round(statsRow.avg_score) || 0
            }
        });
    } catch (err) {
        console.error("Profile Error:", err);
        res.status(500).send("Error loading profile");
    }
});
app.get('/admin/dashboard', isAdmin, async (req, res) => {
    try {
        // 1. Fetch all counts in parallel
        const [statsResult, recentUsers] = await Promise.all([
            pool.query(`SELECT 
                (SELECT COUNT(*) FROM universities) as universities,
                (SELECT COUNT(*) FROM users) as students,
                (SELECT COUNT(*) FROM users WHERE has_paid = true) as premium,
                (SELECT COUNT(*) FROM subjects) as subjects,
                (SELECT COUNT(*) FROM questions) as questions`),
            
            // 2. Fetch 5 most recent signups with their university names
            pool.query(`
                SELECT u.fullname, u.email, u.has_paid, u.created_at, univ.name as university_name 
                FROM users u 
                LEFT JOIN universities univ ON u.university_id = univ.id 
                ORDER BY u.id DESC LIMIT 5`)
        ]);

        res.render('admin/dashboard', {
            user: req.session.user,
            stats: statsResult.rows[0],
            recentUsers: recentUsers.rows
        });

    } catch (err) {
        console.error("Admin Dashboard Error:", err);
        res.status(500).send("Database Error: Verify your table structures (users, universities, subjects, questions).");
    }
});

// ==========================================
// 1. UNIVERSITY MANAGEMENT (NEW)
// ==========================================

// View all universities
app.get('/admin/universities', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM universities ORDER BY name ASC');
        res.render('admin/universities', { universities: result.rows });
    } catch (err) {
        res.status(500).send("Error loading universities");
    }
});

// Add a university
app.post('/admin/universities/add', isAdmin, async (req, res) => {
    const { name, slug } = req.body;
    try {
        await pool.query('INSERT INTO universities (name, slug) VALUES ($1, $2)', [name, slug.toLowerCase()]);
        res.redirect('/admin/universities');
    } catch (err) {
        res.status(500).send("Error adding university");
    }
});

// ==========================================
// 2. SUBJECT MANAGEMENT (UPDATED)
// ==========================================

// VIEW ALL SUBJECTS (Now shows school name and drive link)
// [REMOVED: Subjects, Questions, and AI Quiz admin pages — managed via DB Manager]

// ==========================================
// PREMIUM UPGRADE PAGE
// ==========================================
app.get('/upgrade', isAuth, async (req, res) => {
  res.render('upgrade', { user: req.session.user });
});

// ==========================================
// 4. API FOR THE STUDENT APP
// ==========================================

// JSON API for getting subjects based on student's university
app.get('/api/subjects', async (req, res) => {
    try {
        // Assume user object has university_id from signup
        const userUni = req.session.user.university_id; 
        const result = await pool.query('SELECT * FROM subjects WHERE university_id = $1', [userUni]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch subjects" });
    }
});

// JSON API (To get questions for a subject)
app.get('/api/questions/:subject_id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM questions WHERE subject_id = $1', [req.params.subject_id]);
        res.json(result.rows); 
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch questions" });
    }
});

// GET: View and Create Notifications
app.get('/admin/notifications', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
        res.render('admin/notifications', { notifications: result.rows });
    } catch (err) {
        res.status(500).send("Database Error");
    }
});

// POST: Send a new Notification
app.post('/admin/notifications/send', isAdmin, async (req, res) => {
    const { title, message } = req.body;
    try {
        await pool.query(
            'INSERT INTO notifications (title, message) VALUES ($1, $2)',
            [title, message]
        );
        res.redirect('/admin/notifications');
    } catch (err) {
        res.status(500).send("Error sending notification");
    }
});

// --- USERS ROUTE ---
app.get('/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await pool.query('SELECT id, username, email, created_at FROM users ORDER BY created_at DESC');
        res.render('admin/users', { users: users.rows });
    } catch (err) {
        res.redirect('/admin/dashboard');
    }
});

// --- LOGOUT ROUTE ---
app.get('/logout', (req, res) => {
    // 1. Destroy the session on the server
    req.session.destroy((err) => {
        if (err) {
            console.log("Logout error:", err);
            return res.redirect('/admin/dashboard');
        }
        
        // 2. Clear the session cookie from the browser
        res.clearCookie('connect.sid'); 
        
        // 3. Redirect to login page
        res.redirect('/login');
    });
});

const isStudent = (req, res, next) => {
    if (req.session.user && !req.session.user.is_admin) {
        // Prevents browser from caching the dashboard after logout
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        return next();
    }
    res.redirect('/login');
};

app.get('/dashboard', isStudent, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Fetch Fresh User Data (Payment, Streak, and Quiz Attempts)
        const userRes = await pool.query(
            'SELECT has_paid, current_streak, quiz_attempts FROM users WHERE id = $1', 
            [userId]
        );
        const userData = userRes.rows[0];

        // 2. Notification Count (Unread)
        const notifCheck = await pool.query('SELECT COUNT(*) FROM notifications WHERE is_read = false');
        const unreadNotifs = parseInt(notifCheck.rows[0].count) || 0;

        // 3. Get Recent History
        const historyRes = await pool.query(`
            SELECT score, subject, TO_CHAR(taken_at, 'Mon DD, HH24:MI') as time 
            FROM results 
            WHERE user_id = $1 
            ORDER BY taken_at DESC 
            LIMIT 5`, [userId]);

        // 4. Get Active Competition & Subjects
        const compRes = await pool.query('SELECT * FROM competitions WHERE is_active = true LIMIT 1');
        const subjectsRes = await pool.query('SELECT * FROM subjects ORDER BY name ASC');

        // 5. Count upcoming deadlines (within 24 hours)
        const deadlineCount = await pool.query(
            `SELECT COUNT(*) FROM deadlines 
             WHERE user_id = $1 
             AND (due_date + due_time) > NOW() 
             AND (due_date + due_time) < NOW() + INTERVAL '24 hours'`,
            [userId]
        );
        const upcomingDeadlines = parseInt(deadlineCount.rows[0].count) || 0;

        // 6. Get study stats for dashboard
        const [studyStatsRes, quizCountRes, avgScoreRes, streakRes] = await Promise.all([
            pool.query('SELECT COALESCE(SUM(elapsed_seconds), 0) as t, COUNT(*) as s FROM study_sessions WHERE user_id = $1 AND status = $2', [userId, 'completed']),
            pool.query('SELECT COUNT(*) as c FROM results WHERE user_id = $1', [userId]),
            pool.query('SELECT COALESCE(AVG(score::float/NULLIF(total_questions,0)*100), 0) as avg FROM results WHERE user_id = $1 AND total_questions > 0', [userId]),
            pool.query('SELECT current_streak FROM login_streaks WHERE user_id = $1', [userId])
        ]);
        const streak = parseInt(streakRes.rows[0]?.current_streak) || 0;
        const studySessions = parseInt(studyStatsRes.rows[0].s) || 0;
        const quizCount = parseInt(quizCountRes.rows[0].c) || 0;
        const avgScore = Math.round(parseFloat(avgScoreRes.rows[0].avg) || 0);
        const aiQuizRes = await pool.query('SELECT COUNT(*) FROM quiz_results WHERE user_id = $1 AND subject_id IS NULL', [userId]);
        const aiQuizCount = parseInt(aiQuizRes.rows[0].count) || 0;

        // 7. Get recent quiz
        const recentQuizRes = await pool.query('SELECT subject, score, total_questions, TO_CHAR(taken_at, \'YYYY-MM-DD\') as date_taken FROM results WHERE user_id = $1 ORDER BY taken_at DESC LIMIT 1', [userId]);

        res.render('dashboard', { 
            user: { ...req.session.user, ...userData }, 
            competition: compRes.rows[0],
            subjects: subjectsRes.rows,
            history: historyRes.rows,
            unreadNotifs,
            upcomingDeadlines,
            streak,
            studySessions,
            quizCount,
            avgScore,
            aiQuizCount,
            recentQuiz: recentQuizRes.rows[0] || null,
            paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
            premiumPrice: PREMIUM_PRICE,
            currentTime: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.redirect('/login');
    }
});

app.get('/notifications', isStudent, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Fetch notifications
        const notifRes = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');

        // 2. Mark all as read for the user (or globally if it's a general system)
        await pool.query('UPDATE notifications SET is_read = true'); 
        // Note: Use 'WHERE user_id = $1' if notifications are private/unique to users

        res.render('student-notifications', { 
            notifications: notifRes.rows 
        });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

app.get('/subjects', isStudent, async (req, res) => {
    try {
        const universityId = req.session.user.university_id;
        const userId = req.session.user.id;

        // Fetch subjects, question counts, and the drive link
        const result = await pool.query(`
            SELECT 
                s.id, 
                s.name AS subject, 
                s.drive_link, 
                COUNT(q.id) as question_count 
            FROM subjects s
            LEFT JOIN questions q ON s.id = q.subject_id AND q.university_id = $1
            GROUP BY s.id, s.name, s.drive_link
            ORDER BY s.name ASC
        `, [universityId]);

        // Fetch student's uploaded materials
        const materialsRes = await pool.query(`
            SELECT id, name, description, file_type, file_size,
                   TO_CHAR(created_at, 'Mon DD, YYYY') as upload_date
            FROM student_materials 
            WHERE user_id = $1 
            ORDER BY created_at DESC
        `, [userId]);

        res.render('subjects-library', {
            user: req.session.user,
            subjects: result.rows,
            materials: materialsRes.rows
        });
    } catch (err) {
        console.error("Subjects Library Error:", err.message);
        // If table doesn't exist, render without materials
        const universityId = req.session.user.university_id;
        const result = await pool.query(`
            SELECT s.id, s.name AS subject, s.drive_link, COUNT(q.id) as question_count 
            FROM subjects s
            LEFT JOIN questions q ON s.id = q.subject_id AND q.university_id = $1
            GROUP BY s.id, s.name, s.drive_link
            ORDER BY s.name ASC
        `, [universityId]);
        res.render('subjects-library', {
            user: req.session.user,
            subjects: result.rows,
            materials: []
        });
    }
});

// API: Upload a study material
app.post('/api/materials/upload', isAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { name, description } = req.body;
        const userId = req.session.user.id;
        const file = req.file;

        await pool.query(`
            INSERT INTO student_materials (user_id, name, description, file_type, file_size, file_path)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            userId,
            name || file.originalname,
            description || '',
            file.mimetype,
            file.size,
            file.path
        ]);

        res.json({ success: true, message: 'Material uploaded successfully' });
    } catch (err) {
        console.error('Material upload error:', err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, message: 'Upload failed: ' + err.message });
    }
});

// API: Get user's materials
app.get('/api/materials', isAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, description, file_type, file_size,
                   TO_CHAR(created_at, 'Mon DD, YYYY') as upload_date
            FROM student_materials 
            WHERE user_id = $1 
            ORDER BY created_at DESC
        `, [req.session.user.id]);
        res.json({ materials: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load materials' });
    }
});

// API: Download/view a material file
app.get('/api/materials/:id/view', isAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT file_path, file_type, name FROM student_materials WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }
        const file = result.rows[0];
        if (!file.file_path || !fs.existsSync(file.file_path)) {
            return res.status(404).json({ error: 'File not found on disk' });
        }
        res.setHeader('Content-Type', file.file_type);
        res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
        res.sendFile(file.file_path);
    } catch (err) {
        console.error('View file error:', err);
        res.status(500).json({ error: 'Error loading file' });
    }
});

// API: Delete a material
app.post('/api/materials/:id/delete', isAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT file_path FROM student_materials WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        if (result.rows.length > 0 && result.rows[0].file_path && fs.existsSync(result.rows[0].file_path)) {
            fs.unlinkSync(result.rows[0].file_path);
        }
        await pool.query(
            'DELETE FROM student_materials WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete file error:', err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

app.get('/setup-test', isStudent, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Fetch user status and university_id
        const userQuery = await pool.query(
            'SELECT has_paid, quiz_attempts, university_id FROM users WHERE id = $1',
            [userId]
        );
        const userStatus = userQuery.rows[0];

        if (!userStatus) return res.redirect('/login');

        // 2. Check if the university_id is missing for this user
        if (!userStatus.university_id) {
            console.error(`User ${userId} has no university_id set.`);
            return res.render('setup-test', {
                user: { ...req.session.user, ...userStatus },
                subjects: [],
                error: "Please update your profile with your institution to see available tests."
            });
        }

        // 3. Gatekeeper for free attempts
        if (!userStatus.has_paid && userStatus.quiz_attempts >= 2) {
            return res.render('quiz-locked', {
                user: { ...req.session.user, ...userStatus },
                message: "You've used up your 2 free quiz attempts. Upgrade to Prepium Pro for unlimited practice tests!",
                paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
                premiumPrice: PREMIUM_PRICE,
                userEmail: req.session.user.email
            });
        }

        // 4. Fetch subjects specifically for this student's university
        const result = await pool.query(`
            SELECT s.id, s.name, COUNT(q.id) as total_questions 
            FROM subjects s
            INNER JOIN questions q ON s.id = q.subject_id 
            WHERE q.university_id = $1
            GROUP BY s.id, s.name
            ORDER BY s.name ASC
        `, [userStatus.university_id]);
        
        res.render('setup-test', {
            user: { ...req.session.user, ...userStatus },
            subjects: result.rows
        });

    } catch (err) {
        console.error("Setup Error:", err.message);
        res.redirect('/dashboard');
    }
});

app.post('/start-quiz', isStudent, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Fetch user status to prevent forged route submissions
        const userQuery = await pool.query(
            'SELECT has_paid, quiz_attempts FROM users WHERE id = $1',
            [userId]
        );
        const userStatus = userQuery.rows[0];

        if (!userStatus) {
            return res.redirect('/login');
        }

        // 2. Gatekeeper: Final server-side check
        if (!userStatus.has_paid && userStatus.quiz_attempts >= 2) {
            return res.render('quiz-locked', {
                user: { ...req.session.user, ...userStatus },
                message: "You've used up your 2 free quiz attempts. Upgrade to Prepium Pro for unlimited practice tests!",
                paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
                premiumPrice: PREMIUM_PRICE,
                userEmail: req.session.user.email
            });
        }

        // 3. Process the submitted test parameters
        const { subject_ids, duration } = req.body;
        const selectedIds = Array.isArray(subject_ids) ? subject_ids : [subject_ids];
        let summary = [];
        let totalQs = 0;

        for (const id of selectedIds) {
            const count = parseInt(req.body[`questions_${id}`]) || 0;
            if (count > 0) {
                const result = await pool.query("SELECT name FROM subjects WHERE id = $1", [id]);
                summary.push({ name: result.rows[0].name, count: count, id: id });
                totalQs += count;
            }
        }

        // 4. Store temporary setup in the session
        req.session.tempQuiz = {
            summary,
            duration,
            totalQs
        };

        res.render('quiz-lobby', {
            user: { ...req.session.user, ...userStatus },
            setup: req.session.tempQuiz
        });

    } catch (err) {
        console.error("Start Quiz Error:", err.message);
        res.redirect('/setup-test');
    }
});

// 1. GET THE QUESTIONS
app.post('/live-exam', isStudent, async (req, res) => {
    try {
        const setup = req.session.tempQuiz;
        if (!setup) return res.redirect('/setup-test');

        let allQuestions = [];
        // Pull questions subject by subject to prevent mixing
        for (const s of setup.summary) {
            const result = await pool.query(`
                SELECT q.*, s.name as subject_name 
                FROM questions q 
                JOIN subjects s ON q.subject_id = s.id
                WHERE q.subject_id = $1 ORDER BY RANDOM() LIMIT $2
            `, [s.id, s.count]);
            allQuestions = allQuestions.concat(result.rows);
        }

        req.session.activeQuiz = {
            questions: allQuestions,
            startTime: new Date(),
            duration: setup.duration,
            endTime: new Date(Date.now() + setup.duration * 60000)
        };

        res.render('quiz-page', { user: req.session.user, quiz: req.session.activeQuiz });
    } catch (err) {
        console.error(err);
        res.redirect('/dashboard');
    }
});

app.post('/submit-exam', isStudent, async (req, res) => {
    try {
        // Guard Clause: Ensure session exists
        if (!req.session.activeQuiz || !req.session.activeQuiz.questions) {
            console.error("Submission Error: No active quiz found in session.");
            return res.redirect('/dashboard');
        }

        // 1. Parse answers safely
        let userAnswers = [];
        try {
            userAnswers = JSON.parse(req.body.answers || "[]");
        } catch (e) {
            userAnswers = [];
        }

        const quizData = req.session.activeQuiz.questions;
        const timeUsed = req.body.timeUsed || "00:00";
        const rawSubjectId = quizData[0]?.subject_id || null;
        const subjectId = rawSubjectId !== null && rawSubjectId !== undefined ? parseInt(rawSubjectId, 10) || null : null;
        const userId = req.session.user.id;

        let score = 0;
        let subjectStats = {}; 

        // 2. Grade the exam
        const results = quizData.map((q, index) => {
            const dbAnswer = q.correct_option || ""; 
            const userChoice = userAnswers[index] || ""; // Handle unanswered
            
            // Case-insensitive comparison
            const isCorrect = userChoice && userChoice.toString().toLowerCase() === dbAnswer.toString().toLowerCase();
            
            if (isCorrect) score++;

            // Grouping results by subject name
            const sName = q.subject_name || "General";
            if (!subjectStats[sName]) {
                subjectStats[sName] = { correct: 0, total: 0 };
            }
            subjectStats[sName].total++;
            if (isCorrect) subjectStats[sName].correct++;

            return {
                ...q,
                userChoice,
                isCorrect,
                correctAnswer: dbAnswer 
            };
        });

        const totalQuestions = quizData.length;
        const percentage = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;

        // 3. Database Operations
        try {
            // Save attempt
            await pool.query(
                `INSERT INTO quiz_results (user_id, subject_id, score, total_questions, percentage, time_taken, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [userId, subjectId, score, totalQuestions, percentage, timeUsed]
            );

            // Increment trial for free users
            await pool.query(
                `UPDATE users 
                 SET quiz_attempts = quiz_attempts + 1 
                 WHERE id = $1 AND has_paid = false`,
                [userId]
            );
        } catch (dbErr) {
            console.error("Database Save Error:", dbErr);
            // We continue anyway to show the user their result screen
        }

        // 4. Render Result Screen
        res.render('quiz-result', {
            user: req.session.user,
            score,
            total: totalQuestions,
            percentage,
            subjectStats,
            results,
            timeUsed 
        });

        // 5. CRITICAL: Clean up session AFTER successful render
        delete req.session.activeQuiz;

    } catch (err) {
        console.error("Full Submission Error:", err);
        res.redirect('/dashboard');
    }
});

app.get('/history', isAuth, requirePaid, async (req, res) => {
    const uid = req.session.user.id;
    let quizRows = [], oldRows = [], studyRows = [];

    try {
        const quizRes = await pool.query(`
            SELECT qr.*, s.name as subject_name 
            FROM quiz_results qr
            LEFT JOIN subjects s ON qr.subject_id = s.id
            WHERE qr.user_id = $1
            ORDER BY qr.created_at DESC
        `, [uid]);
        quizRows = quizRes.rows;
    } catch (e) { console.error("History quiz_results:", e.message); }

    try {
        const oldRes = await pool.query(`
            SELECT id, NULL as subject_id, score, total_questions, 
                   CASE WHEN total_questions > 0 THEN ROUND((score::numeric / total_questions) * 100) ELSE 0 END as percentage,
                   NULL as title, NULL as time_taken,
                   created_at,
                   'General Quiz' as subject_name
            FROM results
            WHERE user_id = $1
            ORDER BY created_at DESC
        `, [uid]);
        oldRows = oldRes.rows;
    } catch (e) { console.error("History results table:", e.message); }

    try {
        const studyRes = await pool.query(`
            SELECT sqa.id, sqa.score, sqa.total_questions as total, sqa.question_type,
                   sqa.status, sqa.created_at, sc.course_name as subject_name,
                   'study_quiz' as source
            FROM study_quiz_attempts sqa
            LEFT JOIN study_courses sc ON sqa.course_id = sc.id
            WHERE sqa.user_id = $1 AND sqa.status = 'completed'
            ORDER BY sqa.created_at DESC
        `, [uid]);
        studyRows = studyRes.rows;
    } catch (e) { console.error("History study_quiz_attempts:", e.message); }

    const historyData = [...oldRows, ...quizRows].sort((a, b) => {
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    res.render('history', {
        user: req.session.user,
        history: historyData,
        studyHistory: studyRows
    });
});

// GET: Show Ambassador Login Page
app.get('/ambassador/login', (req, res) => {
    res.render('ambassador-login');
});

// POST: Process Ambassador Login (Their unique code is both user & password)
app.post('/ambassador/login', async (req, res) => {
    const { unique_code } = req.body;
    try {
        const result = await pool.query('SELECT * FROM ambassadors WHERE unique_code = $1', [unique_code]);
        
        if (result.rows.length > 0) {
            // Save the ambassador to session
            req.session.ambassador = result.rows[0];
            res.redirect('/ambassador/dashboard');
        } else {
            res.send("Invalid Ambassador ID. <a href='/ambassador/login'>Try again</a>");
        }
    } catch (err) {
        res.status(500).send("Login error.");
    }
});

app.get('/ambassador/dashboard', async (req, res) => {
    if (!req.session.ambassador) return res.redirect('/ambassador/login');

    try {
        const code = req.session.ambassador.unique_code;
        
        // 1. Fetch latest stats with a fallback of 0 for any missing/null columns
        const ambData = await pool.query(
            `SELECT 
                id, 
                name, 
                unique_code, 
                bank_details, 
                COALESCE(total_referrals, 0) AS total_referrals, 
                COALESCE(total_earned, 0) AS total_earned, 
                COALESCE(total_withdrawn, 0) AS total_withdrawn 
             FROM ambassadors 
             WHERE unique_code = $1`, 
            [code]
        );

        if (ambData.rows.length === 0) {
            return res.redirect('/ambassador/login?error=Invalid session');
        }

        const ambassador = ambData.rows[0];

        // Ensure these are treated as numbers and calculate available balance
        const earned = Number(ambassador.total_earned) || 0;
        const withdrawn = Number(ambassador.total_withdrawn) || 0;
        
        ambassador.current_balance = earned - withdrawn;
        ambassador.total_earned = earned;
        ambassador.total_withdrawn = withdrawn;

        // 2. Fetch all referred users matching the unique_code exactly
        const referrals = await pool.query(
            `SELECT fullname, email, has_paid 
             FROM users 
             WHERE LOWER(TRIM(unique_code)) = LOWER(TRIM($1)) 
             ORDER BY created_at DESC`, 
            [code]
        );

        res.render('ambassador-dashboard', {
            ambassador: ambassador,
            referrals: referrals.rows
        });
    } catch (err) {
        console.error("Dashboard route error:", err);
        res.status(500).send("Error loading ambassador dashboard.");
    }
});

// POST: Update Ambassador Payout details
app.post('/ambassador/update-bank', async (req, res) => {
    if (!req.session.ambassador) return res.status(403).send("Unauthorized");
    const { bank_details } = req.body;
    try {
        await pool.query(
            'UPDATE ambassadors SET bank_details = $1 WHERE unique_code = $2', 
            [bank_details, req.session.ambassador.unique_code]
        );
        res.redirect('/ambassador/dashboard?msg=Account details updated');
    } catch (err) {
        res.status(500).send("Update failed.");
    }
});

// GET: Admin View - Manage Ambassadors
app.get('/admin/ambassadors', async (req, res) => {
    if (!req.session.user || !req.session.user.is_admin) return res.redirect('/admin/login');

    try {
        const result = await pool.query(`
            SELECT 
                id, 
                name, 
                unique_code, 
                bank_details, 
                COALESCE(total_referrals, 0) AS total_referrals, 
                COALESCE(total_earned, 0) AS total_earned, 
                COALESCE(total_withdrawn, 0) AS total_withdrawn,
                created_at 
            FROM ambassadors 
            ORDER BY created_at DESC
        `);

        // Calculate outstanding balance for each ambassador
        const ambassadors = result.rows.map(amb => {
            const earned = Number(amb.total_earned) || 0;
            const withdrawn = Number(amb.total_withdrawn) || 0;
            
            return {
                ...amb,
                total_earned: earned,
                total_withdrawn: withdrawn,
                outstanding: earned - withdrawn
            };
        });

        res.render('admin-ambassadors', { ambassadors });
    } catch (err) {
        console.error("Admin ambassadors view error:", err);
        res.status(500).send("Admin Error loading ambassadors.");
    }
});

// POST: Add a new ambassador manually
app.post('/admin/add-ambassador', isAdmin, async (req, res) => {
    const { name, unique_code } = req.body;
    try {
        // Force clean, lowercase codes before adding to database
        const cleanCode = unique_code.trim().toLowerCase();

        await pool.query(
            'INSERT INTO ambassadors (name, unique_code, total_referrals, total_earned, total_withdrawn) VALUES ($1, $2, 0, 0, 0)', 
            [name, cleanCode]
        );
        res.redirect('/admin/ambassadors?msg=Ambassador added successfully');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/ambassadors?error=Code already in use');
    }
});

// POST: Admin marks payout as complete
app.post('/admin/payout-complete/:id', isAdmin, async (req, res) => {
    try {
        const ambCheck = await pool.query('SELECT total_earned FROM ambassadors WHERE id = $1', [req.params.id]);
        if (ambCheck.rows.length > 0) {
            const earned = ambCheck.rows[0].total_earned;
            await pool.query(
                'UPDATE ambassadors SET total_withdrawn = $1 WHERE id = $2', 
                [earned, req.params.id]
            );
        }
        res.redirect('/admin/ambassadors?msg=Payout recorded successfully');
    } catch (err) {
        console.error("Payout error:", err);
        res.status(500).send("Payout reset failed.");
    }
});

// GET: Admin withdrawal requests
app.get('/admin/withdrawals', isAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pr.*, a.name as ambassador_name, a.unique_code
            FROM payout_requests pr
            LEFT JOIN ambassadors a ON pr.ambassador_id = a.id
            ORDER BY pr.created_at DESC
        `);
        res.render('admin-withdrawals', { withdrawals: result.rows, user: req.session.user });
    } catch (err) {
        console.error('Admin withdrawals error:', err);
        res.status(500).send('Error');
    }
});

// POST: Admin update withdrawal status
app.post('/admin/withdrawals/update/:id', isAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        if (!['pending', 'approved', 'completed', 'rejected'].includes(status)) {
            return res.redirect('/admin/withdrawals?error=Invalid status');
        }
        await pool.query(
            'UPDATE payout_requests SET status = $1, processed_at = NOW(), processed_by = $2 WHERE id = $3',
            [status, req.session.user.email, req.params.id]
        );
        res.redirect('/admin/withdrawals?msg=Status updated');
    } catch (err) {
        console.error('Withdrawal update error:', err);
        res.redirect('/admin/withdrawals?error=Update failed');
    }
});

// GET: Admin email page
app.get('/admin/email', isAdmin, async (req, res) => {
    try {
        const [universities, groups] = await Promise.all([
            pool.query('SELECT * FROM universities ORDER BY name ASC'),
            pool.query('SELECT * FROM user_groups ORDER BY name ASC')
        ]);
        res.render('admin-email', { user: req.session.user, universities: universities.rows, groups: groups.rows });
    } catch (err) {
        console.error('Admin email page error:', err);
        res.status(500).send('Error');
    }
});

// POST: Admin send bulk email
app.post('/admin/email/send', isAdmin, async (req, res) => {
    try {
        const { subject, message, filter_type, filter_value } = req.body;
        if (!subject || !message) return res.redirect('/admin/email?error=Subject and message required');

        let query = 'SELECT id, fullname, email FROM users WHERE 1=1';
        const params = [];

        if (filter_type === 'university' && filter_value) {
            params.push(parseInt(filter_value));
            query += ' AND university_id = $' + params.length;
        } else if (filter_type === 'tier' && filter_value) {
            if (filter_value === 'premium') query += ' AND has_paid = true';
            else if (filter_value === 'free') query += ' AND has_paid = false';
        } else if (filter_type === 'group' && filter_value) {
            params.push(parseInt(filter_value));
            query = 'SELECT u.id, u.fullname, u.email FROM users u JOIN user_group_members ugm ON u.id = ugm.user_id WHERE ugm.group_id = $' + params.length;
        }

        const users = await pool.query(query, params);
        if (users.rows.length === 0) return res.redirect('/admin/email?error=No users match filter');

        let sent = 0;
        const transporterLocal = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
            ? nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
              })
            : null;

        if (!transporterLocal) return res.redirect('/admin/email?error=Email not configured (set EMAIL_USER/PASS)');

        for (const u of users.rows) {
            try {
                await transporterLocal.sendMail({
                    from: `"Prepium" <${process.env.EMAIL_USER}>`,
                    to: u.email,
                    subject: subject,
                    html: message
                });
                sent++;
            } catch (mailErr) {
                console.error('Email send error for', u.email, mailErr.message);
            }
        }

        res.redirect('/admin/email?msg=' + encodeURIComponent(`Email sent to ${sent}/${users.rows.length} users`));
    } catch (err) {
        console.error('Admin send email error:', err);
        res.redirect('/admin/email?error=' + encodeURIComponent(err.message));
    }
});

// Admin group management
app.get('/admin/groups', isAdmin, async (req, res) => {
    try {
        const groups = await pool.query('SELECT g.*, (SELECT COUNT(*) FROM user_group_members WHERE group_id = g.id) as member_count FROM user_groups g ORDER BY g.name ASC');
        const students = await pool.query('SELECT id, fullname, email FROM users ORDER BY fullname ASC');
        res.render('admin-groups', { user: req.session.user, groups: groups.rows, students: students.rows });
    } catch (err) {
        console.error('Admin groups error:', err);
        res.status(500).send('Error');
    }
});

app.post('/admin/groups/create', isAdmin, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.redirect('/admin/groups?error=Group name required');
        await pool.query('INSERT INTO user_groups (name, description) VALUES ($1, $2)', [name.trim(), description || '']);
        res.redirect('/admin/groups?msg=Group created');
    } catch (err) {
        res.redirect('/admin/groups?error=' + encodeURIComponent(err.message));
    }
});

app.post('/admin/groups/delete/:id', isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM user_groups WHERE id = $1', [req.params.id]);
        res.redirect('/admin/groups?msg=Group deleted');
    } catch (err) {
        res.redirect('/admin/groups?error=' + encodeURIComponent(err.message));
    }
});

app.post('/admin/groups/add-user', isAdmin, async (req, res) => {
    try {
        const { group_id, user_id } = req.body;
        if (!group_id || !user_id) return res.redirect('/admin/groups?error=Select group and user');
        await pool.query('INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [parseInt(group_id), parseInt(user_id)]);
        res.redirect('/admin/groups?msg=User added to group');
    } catch (err) {
        res.redirect('/admin/groups?error=' + encodeURIComponent(err.message));
    }
});

app.post('/admin/groups/remove-user/:groupId/:userId', isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2', [req.params.groupId, req.params.userId]);
        res.redirect('/admin/groups?msg=User removed');
    } catch (err) {
        res.redirect('/admin/groups?error=' + encodeURIComponent(err.message));
    }
});

// GET: Render the Admin Login Page
app.get('/admin/login', (req, res) => {
    res.render('admin-login', { error: null });
});

// POST: Process Admin Login Credentials
app.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminEmail || !adminPassword) {
            console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
            return res.render('admin-login', { error: "Admin login not configured." });
        }

        if (email === adminEmail && password === adminPassword) {
            req.session.user = { 
                id: 0, 
                fullname: 'Admin', 
                email: adminEmail, 
                is_admin: true,
                has_paid: true
            };
            
            req.session.save((err) => {
                if (err) {
                    console.error("Session Save Error:", err);
                    return res.render('admin-login', { error: "Session failed. Try again." });
                }
                res.redirect('/admin/dashboard');
            });
        } else {
            res.render('admin-login', { error: "Invalid admin credentials." });
        }
    } catch (err) {
        console.error("Admin Login Error:", err);
        res.render('admin-login', { error: "An error occurred during login." });
    }
});

// GET: Admin Sign Out
app.get('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.clearCookie('connect.sid');
        res.redirect('/admin/login?msg=Logged out successfully');
    });
});

app.get('/competition', (req, res) => {
    // If you want to check if the user is logged in first:
    const user = req.session.user || null;
    res.render('competition', { user });
});

// GET: View student deadlines
app.get('/deadlines', isAuth, async (req, res) => {
    try {
        const query = `
            SELECT id, title,
                   TO_CHAR(due_date, 'YYYY-MM-DD') as date_str,
                   TO_CHAR(due_time, 'HH24:MI') as time_str
            FROM deadlines
            WHERE user_id = $1
            ORDER BY due_date ASC, due_time ASC
        `;
        const result = await pool.query(query, [req.session.user.id]);

        res.render('deadlines', {
            user: req.session.user,
            deadlines: result.rows,
            query: req.query
        });
    } catch (err) {
        console.error("Error fetching deadlines:", err);
        res.status(500).send("Database failure loading deadlines.");
    }
});

// POST: Save a new deadline
app.post('/deadlines/add', isAuth, async (req, res) => {
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard');
    }

    const { title, due_date, due_time } = req.body;
    if (!title || !due_date || !due_time) {
        return res.redirect('/deadlines?error=All fields are required');
    }

    try {
        await pool.query(
            'INSERT INTO deadlines (user_id, title, due_date, due_time) VALUES ($1, $2, $3, $4)',
            [req.session.user.id, title.trim(), due_date, due_time]
        );
        res.redirect('/deadlines');
    } catch (err) {
        console.error("Error creating deadline:", err);
        res.redirect('/deadlines?error=Failed to add deadline');
    }
});

// POST: Delete an individual deadline
app.post('/deadlines/delete/:id', isAuth, async (req, res) => {

    try {
        await pool.query(
            'DELETE FROM deadlines WHERE id = $1 AND user_id = $2', 
            [req.params.id, req.session.user.id]
        );
        res.redirect('/deadlines');
    } catch (err) {
        console.error("Error deleting deadline:", err);
        if (req.xhr) return res.status(500).json({ error: 'Failed to delete' });
        res.redirect('/deadlines?error=Failed to delete deadline');
    }
});

// JSON API: Get deadlines for overlay
app.get('/api/deadlines', isAuth, async (req, res) => {
    try {
        const query = `
            SELECT id, title, 
                   TO_CHAR(due_date, 'YYYY-MM-DD') as date_str, 
                   TO_CHAR(due_time, 'HH24:MI') as time_str 
            FROM deadlines 
            WHERE user_id = $1 
            ORDER BY due_date ASC, due_time ASC
        `;
        const result = await pool.query(query, [req.session.user.id]);
        res.json({ deadlines: result.rows });
    } catch (err) {
        console.error("API Deadlines Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ─── User Courses API (for AI Extract Wizard) ───

// GET: Fetch user's courses
app.get('/api/user-courses', isAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_courses WHERE user_id = $1 ORDER BY course_name',
            [req.session.user.id]
        );
        res.json({ courses: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// POST: Add a course
app.post('/api/user-courses/add', isAuth, async (req, res) => {
    const { course_name, course_code, unit } = req.body;
    if (!course_name) return res.status(400).json({ error: 'Course name required' });
    try {
        const result = await pool.query(
            'INSERT INTO user_courses (user_id, course_name, course_code, unit) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.session.user.id, course_name, course_code || '', parseInt(unit) || 3]
        );
        res.json({ success: true, course: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add course' });
    }
});

// POST: Delete a course
app.post('/api/user-courses/delete/:id', isAuth, async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM user_courses WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// POST: Add multiple courses at once (bulk from wizard)
app.post('/api/user-courses/bulk', isAuth, async (req, res) => {
    const { courses } = req.body;
    if (!courses || !Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({ error: 'No courses provided' });
    }
    try {
        for (const c of courses) {
            await pool.query(
                'INSERT INTO user_courses (user_id, course_name, course_code, unit) VALUES ($1, $2, $3, $4)',
                [req.session.user.id, c.course_name, c.course_code || '', parseInt(c.unit) || 3]
            );
        }
        res.json({ success: true, count: courses.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save courses' });
    }
});

// GET: Render the Timetable page with stored data
app.get('/timetable', isAuth, requirePaid, async (req, res) => {
    try {
        // Fetch saved timetable slots for this specific user from your PostgreSQL database
        const result = await pool.query(
            'SELECT * FROM timetables WHERE user_id = $1 ORDER BY day, start_time ASC',
            [req.session.user.id]
        );
        
        res.render('timetable', { 
            user: req.session.user,
            slots: result.rows || [],
            hasNewNotifs: req.session.hasNewNotifs || false 
        });
    } catch (err) {
        console.error(err);
        res.render('timetable', { user: req.session.user, slots: [], hasNewNotifs: false });
    }
});

// POST: Save a new course slot to the user's timetable
app.post('/timetable/add', isAuth, requirePaid, async (req, res) => {
    const { course, course_code, unit, day, start_time, end_time, venue } = req.body;
    
    try {
        await pool.query(
            'INSERT INTO timetables (user_id, course, course_code, unit, day, start_time, end_time, venue) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [req.session.user.id, course, course_code || '', parseInt(unit) || 3, day, start_time, end_time, venue]
        );
        res.redirect('/timetable');
    } catch (err) {
        console.error(err);
        res.redirect('/timetable?error=Failed to add slot');
    }
});

// ==========================================
// TIMETABLE EXTRACTION ROUTES (AI-powered)
// ==========================================

// POST: Upload and extract timetable from image/PDF/document
app.post('/timetable/extract', isAuth, requirePaid, uploadMemory.single('timetable_file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        const fileExt = path.extname(req.file.originalname).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
        const pdfExts = ['.pdf'];
        const docExts = ['.doc', '.docx', '.txt', '.rtf'];

        // Parse known courses from request body
        let knownCoursesContext = '';
        try {
            const known = typeof req.body.knownCourses === 'string' 
                ? JSON.parse(req.body.knownCourses) 
                : req.body.knownCourses || [];
            if (Array.isArray(known) && known.length > 0) {
                knownCoursesContext = '\n\nThe student is enrolled in these courses: ' + 
                    known.map(c => `${c.course_code || ''} ${c.course_name}`.trim()).join(', ') + 
                    '. Match extracted courses to these where possible and use the correct course_code and unit from this list.\n';
            }
        } catch (e) {}

        const fileBase64 = req.file.buffer.toString('base64');
        const mimeType = req.file.mimetype;
        let rawText = '';
        let usedProvider = '';

        const basePrompt = `Extract the school timetable from this document. Return a JSON array of courses with: course_code (e.g. PHY 302), course_name, day (Monday-Sunday), start_time (HH:MM), end_time (HH:MM), venue, unit (credit units, default 3). Only return valid JSON, no markdown.${knownCoursesContext}`;
        const structBasePrompt = `Extract the school timetable from this text. Return ONLY a JSON array of courses with: course_code, course_name, day (Monday-Sunday), start_time (HH:MM), end_time (HH:MM), venue, unit. If start_time/end_time not clear, use "09:00"/"10:00". If venue not found, use "". Only return valid JSON array, no markdown.${knownCoursesContext}`;

        // File-type-based routing with fallback chain
        if (imageExts.includes(fileExt)) {
            const result = await callGeminiWithImage(basePrompt, fileBase64, mimeType);
            if (result.success) {
                rawText = result.text;
                usedProvider = 'Gemini Vision';
            }
        } else if (pdfExts.includes(fileExt)) {
            if (process.env.LLAMAPARSE_API_KEY) {
                try {
                    const lpResult = await callLlamaParse(req.file.buffer, req.file.originalname);
                    if (lpResult.success) {
                        const structResult = await callGeminiWithText(structBasePrompt, lpResult.text);
                        if (structResult.success) {
                            rawText = structResult.text;
                            usedProvider = 'LlamaParse → Gemini';
                        }
                    }
                } catch (e) { console.error('LlamaParse failed:', e.message); }
            }
            
            if (!rawText) {
                const result = await callGeminiWithImage(basePrompt, fileBase64, mimeType);
                if (result.success) { rawText = result.text; usedProvider = 'Gemini PDF'; }
            }
        } else if (docExts.includes(fileExt)) {
            if (process.env.UNSTRUCTURED_API_KEY) {
                try {
                    const usResult = await callUnstructured(req.file.buffer, req.file.originalname);
                    if (usResult.success) {
                        const structResult = await callGeminiWithText(structBasePrompt, usResult.text);
                        if (structResult.success) {
                            rawText = structResult.text;
                            usedProvider = 'Unstructured → Gemini';
                        }
                    }
                } catch (e) { console.error('Unstructured failed:', e.message); }
            }

            if (!rawText) {
                const result = await callGeminiWithImage(basePrompt, fileBase64, mimeType);
                if (result.success) { rawText = result.text; usedProvider = 'Gemini Doc'; }
            }
        } else {
            return res.status(400).json({ success: false, message: 'Unsupported file type. Upload an image, PDF, or document.' });
        }

        if (!rawText) {
            return res.status(500).json({ success: false, message: 'All AI models failed to extract timetable. Try a clearer file.' });
        }

        // Clean response: remove markdown fences
        let cleanJson = rawText;
        if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        if (cleanJson.startsWith('```')) cleanJson = cleanJson.replace(/^```\n?/, '').replace(/\n?```$/, '');
        cleanJson = cleanJson.trim();

        let courses;
        try {
            courses = JSON.parse(cleanJson);
            if (!Array.isArray(courses)) courses = [courses];
        } catch (e) {
            console.error('JSON parse failed, raw:', cleanJson);
            return res.status(500).json({ success: false, message: 'Failed to parse extracted timetable. Try again.' });
        }

        res.json({
            success: true,
            provider: usedProvider,
            courses: courses
        });

    } catch (err) {
        console.error('Extraction error:', err);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// POST: Delete a timetable slot
app.post('/timetable/delete/:id', isAuth, requirePaid, async (req, res) => {
    try {
        await pool.query('DELETE FROM timetables WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
        res.redirect('/timetable');
    } catch (err) {
        console.error(err);
        res.redirect('/timetable?error=Failed to delete');
    }
});

// POST: Update timetable slot (add course_code, unit)
app.post('/timetable/update/:id', isAuth, requirePaid, async (req, res) => {
    const { course_code, unit } = req.body;
    try {
        await pool.query(
            'UPDATE timetables SET course_code = $1, unit = $2 WHERE id = $3 AND user_id = $4',
            [course_code || '', parseInt(unit) || 3, req.params.id, req.session.user.id]
        );
        res.redirect('/timetable');
    } catch (err) {
        console.error(err);
        res.redirect('/timetable?error=Failed to update');
    }
});

// POST: Save extracted courses as timetable slots
app.post('/timetable/save-extracted', isAuth, requirePaid, async (req, res) => {
    const { courses } = req.body;
    if (!Array.isArray(courses) || courses.length === 0) {
        return res.status(400).json({ success: false, message: 'No courses to save.' });
    }

    try {
        for (const c of courses) {
            await pool.query(
                `INSERT INTO timetables (user_id, course, course_code, day, start_time, end_time, venue, unit)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT DO NOTHING`,
                [req.session.user.id, c.course_name || c.course || '', c.course_code || '',
                 c.day || 'Monday', c.start_time || '09:00', c.end_time || '10:00',
                 c.venue || '', parseInt(c.unit) || 3]
            );
        }
        res.json({ success: true, message: `${courses.length} courses saved to your timetable.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to save courses.' });
    }
});

// ==========================================
// READING TIMETABLE ROUTES
// ==========================================

// GET: Show reading timetable page with settings
app.get('/reading-timetable', isAuth, requirePaid, async (req, res) => {
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard?msg=Upgrade to access Reading Timetable');
    }

    try {
        // Get reading settings
        const settingsResult = await pool.query(
            'SELECT * FROM reading_settings WHERE user_id = $1', [req.session.user.id]
        );
        let settings = settingsResult.rows[0] || null;

        // Get school timetable slots
        const slotsResult = await pool.query(
            'SELECT * FROM timetables WHERE user_id = $1 ORDER BY day, start_time',
            [req.session.user.id]
        );

        // Get reading timetable
        const readingResult = await pool.query(
            'SELECT * FROM reading_timetables WHERE user_id = $1 ORDER BY day, start_time',
            [req.session.user.id]
        );

        // Get distinct courses from school timetable
        const coursesResult = await pool.query(
            'SELECT DISTINCT course, course_code, unit FROM timetables WHERE user_id = $1 ORDER BY course',
            [req.session.user.id]
        );

        res.render('reading-timetable', {
            user: req.session.user,
            settings: settings,
            slots: slotsResult.rows || [],
            readingSlots: readingResult.rows || [],
            courses: coursesResult.rows || [],
            hasNewNotifs: req.session.hasNewNotifs || false
        });

    } catch (err) {
        console.error(err);
        res.render('reading-timetable', {
            user: req.session.user, settings: null, slots: [],
            readingSlots: [], courses: [], hasNewNotifs: false
        });
    }
});

// POST: Save reading settings
app.post('/reading-timetable/settings', isAuth, requirePaid, async (req, res) => {
    const {
        use_school_timetable, daily_hours, session_minutes,
        sessions_per_course, preferred_time_start, preferred_time_end, excluded_courses
    } = req.body;

    try {
        await pool.query(`
            INSERT INTO reading_settings (user_id, use_school_timetable, daily_hours, session_minutes,
                sessions_per_course, preferred_time_start, preferred_time_end, excluded_courses, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET
                use_school_timetable = EXCLUDED.use_school_timetable,
                daily_hours = EXCLUDED.daily_hours,
                session_minutes = EXCLUDED.session_minutes,
                sessions_per_course = EXCLUDED.sessions_per_course,
                preferred_time_start = EXCLUDED.preferred_time_start,
                preferred_time_end = EXCLUDED.preferred_time_end,
                excluded_courses = EXCLUDED.excluded_courses,
                updated_at = NOW()
        `, [
            req.session.user.id,
            use_school_timetable === 'true' || use_school_timetable === true,
            parseFloat(daily_hours) || 3,
            parseInt(session_minutes) || 45,
            parseInt(sessions_per_course) || 2,
            preferred_time_start || '09:00',
            preferred_time_end || '21:00',
            Array.isArray(excluded_courses) ? excluded_courses : []
        ]);

        res.json({ success: true, message: 'Settings saved!' });
    } catch (err) {
        console.error('Save settings error:', err);
        res.status(500).json({ success: false, message: 'Failed to save settings.' });
    }
});

// POST: Generate reading timetable
app.post('/reading-timetable/generate', isAuth, requirePaid, async (req, res) => {
    try {
        // Get user settings
        const settingsResult = await pool.query(
            'SELECT * FROM reading_settings WHERE user_id = $1', [req.session.user.id]
        );
        let settings = settingsResult.rows[0];

        // If no settings saved, use defaults from request body
        const useSchool = settings ? settings.use_school_timetable : (req.body.use_school_timetable === 'true');
        const dailyHours = settings ? parseFloat(settings.daily_hours) : (parseFloat(req.body.daily_hours) || 3);
        const sessionMin = settings ? parseInt(settings.session_minutes) : (parseInt(req.body.session_minutes) || 45);
        const sessionsPerCourse = settings ? parseInt(settings.sessions_per_course) : (parseInt(req.body.sessions_per_course) || 2);
        const prefStart = settings ? settings.preferred_time_start : (req.body.preferred_time_start || '09:00');
        const prefEnd = settings ? settings.preferred_time_end : (req.body.preferred_time_end || '21:00');
        const excluded = settings ? (settings.excluded_courses || []) : (req.body.excluded_courses ? (Array.isArray(req.body.excluded_courses) ? req.body.excluded_courses : [req.body.excluded_courses]) : []);

        // Get courses
        let courses = [];
        if (useSchool) {
            const schoolResult = await pool.query(
                'SELECT DISTINCT course, course_code, unit FROM timetables WHERE user_id = $1',
                [req.session.user.id]
            );
            courses = schoolResult.rows.filter(c => !excluded.includes(c.course) && !excluded.includes(c.course_code));
        } else {
            // Manual courses from request
            courses = req.body.manual_courses || [];
            if (typeof courses === 'string') {
                try { courses = JSON.parse(courses); } catch(e) { courses = []; }
            }
        }

        if (courses.length === 0) {
            return res.status(400).json({
                success: false,
                message: useSchool
                    ? 'No courses found in your school timetable. Add courses first or choose manual entry.'
                    : 'No courses provided. Add at least one course.'
            });
        }

        // Clear existing reading timetable
        await pool.query('DELETE FROM reading_timetables WHERE user_id = $1', [req.session.user.id]);

        // Generate reading timetable
        const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const sessionsPerDay = Math.floor((dailyHours * 60) / sessionMin);
        const totalSessionsNeeded = courses.length * sessionsPerCourse;
        const totalDaysNeeded = Math.ceil(totalSessionsNeeded / sessionsPerDay);
        const activeDays = weekDays.slice(0, Math.min(totalDaysNeeded, 7));

        // Distribute sessions across days
        let allSessions = [];
        courses.forEach(course => {
            for (let i = 0; i < sessionsPerCourse; i++) {
                allSessions.push(course);
            }
        });

        // Shuffle for fair distribution
        for (let i = allSessions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allSessions[i], allSessions[j]] = [allSessions[j], allSessions[i]];
        }

        // Assign to time slots
        let dayIndex = 0;
        let sessionIndex = 0;

        for (let d = 0; d < activeDays.length && sessionIndex < allSessions.length; d++) {
            const day = activeDays[d];
            // Calculate time slots for this day
            const prefStartMinutes = timeToMinutes(prefStart);
            const prefEndMinutes = timeToMinutes(prefEnd);
            const availableMinutes = prefEndMinutes - prefStartMinutes;
            const slotsForDay = Math.min(sessionsPerDay, Math.ceil(availableMinutes / sessionMin));

            for (let s = 0; s < slotsForDay && sessionIndex < allSessions.length; s++) {
                const course = allSessions[sessionIndex];
                const slotStartMinutes = prefStartMinutes + (s * sessionMin);
                const slotEndMinutes = slotStartMinutes + sessionMin;

                if (slotEndMinutes > prefEndMinutes) break;

                const startTime = minutesToTime(slotStartMinutes);
                const endTime = minutesToTime(slotEndMinutes);

                await pool.query(
                    `INSERT INTO reading_timetables (user_id, course, course_code, unit, day, start_time, end_time, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [req.session.user.id, course.course || course.course_name || course.course_code || 'Course',
                     course.course_code || '', parseInt(course.unit) || 3,
                     day, startTime, endTime, 'generated']
                );

                sessionIndex++;
            }
            dayIndex++;
        }

        // Fetch and return the generated timetable
        const result = await pool.query(
            'SELECT * FROM reading_timetables WHERE user_id = $1 ORDER BY day, start_time',
            [req.session.user.id]
        );

        res.json({
            success: true,
            message: `Reading timetable generated with ${result.rows.length} sessions across ${activeDays.length} days!`,
            readingSlots: result.rows
        });

    } catch (err) {
        console.error('Generate error:', err);
        res.status(500).json({ success: false, message: 'Failed to generate reading timetable.' });
    }
});

// POST: Delete a reading slot
app.post('/reading-timetable/delete/:id', isAuth, requirePaid, async (req, res) => {
    try {
        await pool.query('DELETE FROM reading_timetables WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// POST: Reset reading timetable
app.post('/reading-timetable/reset', isAuth, requirePaid, async (req, res) => {
    try {
        await pool.query('DELETE FROM reading_timetables WHERE user_id = $1', [req.session.user.id]);
        res.json({ success: true, message: 'Reading timetable cleared.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// HELPER FUNCTIONS FOR AI EXTRACTION
// ==========================================

// Call Gemini with image/file data
async function callGeminiWithImage(prompt, base64Data, mimeType) {
    const endpoints = [
        { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', key: process.env.GEMINI_API_KEY_PRIMARY },
        { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', key: process.env.GEMINI_API_KEY_SECONDARY }
    ].filter(e => e.key);

    for (const ep of endpoints) {
        try {
            const body = {
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: mimeType || 'application/octet-stream', data: base64Data } }
                    ]
                }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
            };

            const resp = await fetch(`${ep.url}?key=${ep.key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30000)
            });

            if (resp.ok) {
                const data = await resp.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text) return { success: true, text };
            }
        } catch (e) {
            console.error('Gemini image call failed:', e.message);
        }
    }
    return { success: false, text: '' };
}

// Call Gemini with text prompt + text content
async function callGeminiWithText(prompt, textContent) {
    const models = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'];
    const keys = [process.env.GEMINI_API_KEY_PRIMARY, process.env.GEMINI_API_KEY_SECONDARY].filter(Boolean);

    for (const key of keys) {
        for (const model of models) {
            try {
                const parts = [{ text: prompt }];
                if (textContent) parts.push({ text: textContent });
                const body = {
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 16384 }
                };

                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(90000)
                });

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => '');
                    console.error(`Gemini ${model} returned ${resp.status}: ${errText.slice(0, 200)}`);
                    continue;
                }

                const data = await resp.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (text) return { success: true, text };
            } catch (e) {
                console.error(`Gemini ${model} failed:`, e.message);
            }
        }
    }
    return { success: false, text: '' };
}

// Call LlamaParse API for PDFs
async function callLlamaParse(fileBuffer, fileName) {
    const apiKey = process.env.LLAMAPARSE_API_KEY;
    if (!apiKey) return { success: false, text: '' };

    try {
        // Upload file to LlamaParse
        const formData = new FormData();
        const blob = new Blob([fileBuffer]);
        formData.append('file', blob, fileName);
        formData.append('premium_mode', 'false');

        const uploadResp = await fetch('https://api.cloud.llamaindex.ai/api/v1/parsing/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData
        });

        if (!uploadResp.ok) {
            const errText = await uploadResp.text();
            console.error('LlamaParse upload failed:', errText);
            return { success: false, text: '' };
        }

        const uploadData = await uploadResp.json();
        const jobId = uploadData.id;
        if (!jobId) return { success: false, text: '' };

        // Poll for result
        for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(r => setTimeout(r, 2000));

            const pollResp = await fetch(`https://api.cloud.llamaindex.ai/api/v1/parsing/job/${jobId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (!pollResp.ok) continue;

            const pollData = await pollResp.json();
            if (pollData.status === 'completed') {
                const markdown = pollData.result?.markdown || pollData.result?.text || '';
                if (markdown) return { success: true, text: markdown };
            }
        }

        return { success: false, text: '' };
    } catch (e) {
        console.error('LlamaParse error:', e.message);
        return { success: false, text: '' };
    }
}

// Call Unstructured.io API for documents
async function callUnstructured(fileBuffer, fileName) {
    const apiKey = process.env.UNSTRUCTURED_API_KEY;
    if (!apiKey) return { success: false, text: '' };

    try {
        const formData = new FormData();
        const blob = new Blob([fileBuffer]);
        formData.append('files', blob, fileName);
        formData.append('strategy', 'hi_res');

        const resp = await fetch('https://api.unstructured.io/general/v0/general', {
            method: 'POST',
            headers: { 'api-key': apiKey },
            body: formData,
            signal: AbortSignal.timeout(60000)
        });

        if (!resp.ok) {
            const errText = await resp.text();
            console.error('Unstructured failed:', errText);
            return { success: false, text: '' };
        }

        const elements = await resp.json();
        const fullText = elements.map(el => el.text || '').filter(Boolean).join('\n');
        return fullText ? { success: true, text: fullText } : { success: false, text: '' };
    } catch (e) {
        console.error('Unstructured error:', e.message);
        return { success: false, text: '' };
    }
}

// Convert time string (HH:MM) to minutes
function timeToMinutes(timeStr) {
    const [h, m] = (timeStr || '09:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

// Convert minutes to time string (HH:MM)
function minutesToTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// GET: Render the How It Works Guide
app.get('/how-it-works', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | How It Works';
    res.locals.seo.description = 'Discover how Prepium works — AI-powered CBT practice, smart study tools, flashcards, quizzes, and personalized exam preparation.';
    res.render('how-it-works', { 
        user: req.session.user,
        hasNewNotifs: req.session.hasNewNotifs || false 
    });
});

// ==========================================
// USER CHAT ROUTES
// ==========================================

// GET: View all threads & chat interface
app.get('/suggestions', isAuth, async (req, res) => {
    const activeThreadId = req.query.threadId;

    try {
        // Fetch threads along with an unread indicator for admin replies
        const threadsQuery = `
            SELECT t.*, 
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM suggestion_messages m 
                        WHERE m.thread_id = t.id 
                        AND m.sender_role = 'Admin' 
                        AND m.is_read = FALSE
                    ) THEN TRUE 
                    ELSE FALSE 
                END as has_unread
            FROM suggestion_threads t
            WHERE t.user_id = $1
            ORDER BY t.created_at DESC
        `;
        const threadsResult = await pool.query(threadsQuery, [req.session.user.id]);

        let activeMessages = [];
        let currentThread = null;

        // If user selects a thread, load messages and mark admin replies as read
        if (activeThreadId) {
            const threadCheck = await pool.query(
                'SELECT * FROM suggestion_threads WHERE id = $1 AND user_id = $2',
                [activeThreadId, req.session.user.id]
            );

            if (threadCheck.rows.length > 0) {
                currentThread = threadCheck.rows[0];

                // Mark admin messages in this thread as read
                await pool.query(
                    "UPDATE suggestion_messages SET is_read = TRUE WHERE thread_id = $1 AND sender_role = 'Admin'",
                    [activeThreadId]
                );

                // Fetch updated chat history
                const msgResult = await pool.query(
                    'SELECT * FROM suggestion_messages WHERE thread_id = $1 ORDER BY created_at ASC',
                    [activeThreadId]
                );
                activeMessages = msgResult.rows;
            }
        }

        res.render('suggestions', {
            user: req.session.user,
            threads: threadsResult.rows,
            activeMessages,
            currentThread
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading message center.");
    }
});

// POST: Create a new thread (Starting the conversation)
app.post('/suggestions/new', isAuth, async (req, res) => {
    const { title, message } = req.body;
    try {
        const newThread = await pool.query(
            'INSERT INTO suggestion_threads (user_id, title, status) VALUES ($1, $2, \'Open\') RETURNING id',
            [req.session.user.id, title]
        );
        
        await pool.query(
            'INSERT INTO suggestion_messages (thread_id, sender_id, sender_role, message) VALUES ($1, $2, \'User\', $3)',
            [newThread.rows[0].id, req.session.user.id, message]
        );

        res.redirect(`/suggestions?threadId=${newThread.rows[0].id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error starting conversation");
    }
});

// POST: Send message inside an existing thread
app.post('/suggestions/reply', isAuth, async (req, res) => {
    const { thread_id, message } = req.body;
    try {
        // Verify thread is Open and owned by the user
        const threadCheck = await pool.query(
            'SELECT * FROM suggestion_threads WHERE id = $1 AND user_id = $2 AND status = \'Open\'',
            [thread_id, req.session.user.id]
        );

        if (threadCheck.rows.length === 0) return res.status(403).send("Chat is closed or unauthorized.");

        await pool.query(
            'INSERT INTO suggestion_messages (thread_id, sender_id, sender_role, message) VALUES ($1, $2, \'User\', $3)',
            [thread_id, req.session.user.id, message]
        );

        res.redirect(`/suggestions?threadId=${thread_id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error sending message");
    }
});


// ==========================================
// ADMIN CHAT ROUTES
// ==========================================

// GET: View all active student threads
app.get('/admin/suggestions', isAdmin, async (req, res) => {
    const activeThreadId = req.query.threadId;

    try {
        const threadsQuery = `
            SELECT t.*, u.fullname, u.email 
            FROM suggestion_threads t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC
        `;
        const threadsResult = await pool.query(threadsQuery);

        let activeMessages = [];
        let currentThread = null;

        if (activeThreadId) {
            const threadCheck = await pool.query(
                `SELECT t.*, u.fullname, u.email 
                 FROM suggestion_threads t 
                 JOIN users u ON t.user_id = u.id 
                 WHERE t.id = $1`, [activeThreadId]
            );
            if (threadCheck.rows.length > 0) {
                currentThread = threadCheck.rows[0];
                const msgResult = await pool.query(
                    'SELECT * FROM suggestion_messages WHERE thread_id = $1 ORDER BY created_at ASC',
                    [activeThreadId]
                );
                activeMessages = msgResult.rows;
            }
        }

        res.render('admin/suggestions', {
            user: req.session.user,
            threads: threadsResult.rows,
            activeMessages,
            currentThread
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading admin messages");
    }
});

// POST: Admin sends a reply
app.post('/admin/suggestions/reply', isAdmin, async (req, res) => {
    const { thread_id, message } = req.body;
    try {
        await pool.query(
            'INSERT INTO suggestion_messages (thread_id, sender_id, sender_role, message) VALUES ($1, $2, \'Admin\', $3)',
            [thread_id, req.session.user.id, message]
        );
        res.redirect(`/admin/suggestions?threadId=${thread_id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding admin message");
    }
});

// POST: Admin updates the status (Close/Reopen Chat)
app.post('/admin/suggestions/status', isAdmin, async (req, res) => {
    const { thread_id, status } = req.body;
    try {
        await pool.query(
            'UPDATE suggestion_threads SET status = $1 WHERE id = $2',
            [status, thread_id]
        );
        res.redirect(`/admin/suggestions?threadId=${thread_id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error changing chat status");
    }
});

// =========================================================
// REFERRAL SYSTEM (replaces ambassador)
// =========================================================

app.get('/refer', (req, res) => {
    const user = req.session.user || null;
    res.render('refer', { user });
});

app.get('/refer/dashboard', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const userData = await pool.query('SELECT id, fullname, email, unique_code, has_paid FROM users WHERE id = $1', [uid]);
        if (!userData.rows[0]) return res.redirect('/login');

        let refCode = userData.rows[0].unique_code;
        let referral = null;

        if (refCode) {
            const refData = await pool.query('SELECT * FROM ambassadors WHERE unique_code = $1', [refCode]);
            if (refData.rows[0]) {
                const a = refData.rows[0];
                const earned = Number(a.total_earned) || 0;
                const withdrawn = Number(a.total_withdrawn) || 0;
                referral = { ...a, current_balance: earned - withdrawn, total_earned: earned, total_withdrawn: withdrawn };
            }
        } else {
            // Auto-generate a referral code for the user
            refCode = 'REF' + uid + Math.floor(1000 + Math.random() * 9000);
            await pool.query('UPDATE users SET unique_code = $1 WHERE id = $2', [refCode, uid]);
            try {
                await pool.query(
                    'INSERT INTO ambassadors (name, unique_code, bank_details, total_referrals, total_earned, total_withdrawn) VALUES ($1, $2, $3, 0, 0, 0)',
                    [req.session.user.fullname, refCode, '']
                );
            } catch (e) { /* already exists */ }
            referral = { name: req.session.user.fullname, unique_code: refCode, bank_details: '', total_referrals: 0, total_earned: 0, total_withdrawn: 0, current_balance: 0 };
        }

        const referralsList = await pool.query(
            `SELECT fullname, email, has_paid, created_at FROM users WHERE LOWER(TRIM(unique_code)) = LOWER(TRIM($1)) ORDER BY created_at DESC`,
            [refCode]
        );

        const totalRef = referralsList.rows.length;
        const activeRef = referralsList.rows.filter(r => r.has_paid).length;
        const availableBal = referral ? referral.current_balance : 0;

        // Get withdrawal history
        const withdrawals = await pool.query(
            `SELECT id, amount_requested, fee_amount, net_payout, bank_details, status, created_at, processed_at 
             FROM payout_requests WHERE ambassador_id = $1 ORDER BY created_at DESC`,
            [referral ? referral.id : 0]
        );

        res.render('refer-dashboard', {
            user: req.session.user,
            referral,
            referrals: referralsList.rows,
            totalRef,
            activeRef,
            availableBal,
            withdrawals: withdrawals.rows
        });
    } catch (err) {
        console.error('Referral dashboard error:', err);
        res.status(500).send('Error loading dashboard');
    }
});

app.post('/refer/withdraw', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const userData = await pool.query('SELECT unique_code FROM users WHERE id = $1', [uid]);
        const code = userData.rows[0]?.unique_code;
        if (!code) return res.status(400).json({ success: false, error: 'No referral code' });

        const amb = await pool.query('SELECT * FROM ambassadors WHERE unique_code = $1', [code]);
        if (!amb.rows[0]) return res.status(400).json({ success: false, error: 'No referral account' });

        const a = amb.rows[0];
        const earned = Number(a.total_earned) || 0;
        const withdrawn = Number(a.total_withdrawn) || 0;
        const balance = earned - withdrawn;

        const { amount, bank_details } = req.body;
        const amt = parseFloat(amount);
        if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });
        if (amt > balance) return res.status(400).json({ success: false, error: 'Insufficient balance' });
        if (amt < 100) return res.status(400).json({ success: false, error: 'Minimum withdrawal is ₦100' });

        const fee = Math.round(amt * 0.1 * 100) / 100;
        const net = amt - fee;

        await pool.query(
            `INSERT INTO payout_requests (ambassador_id, amount_requested, fee_amount, net_payout, bank_details, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [a.id, amt, fee, net, bank_details || a.bank_details || '']
        );

        // Deduct from balance immediately
        await pool.query('UPDATE ambassadors SET total_withdrawn = COALESCE(total_withdrawn, 0) + $1 WHERE id = $2', [amt, a.id]);

        res.json({ success: true, message: `Withdrawal of ₦${amt} submitted (fee: ₦${fee}, net: ₦${net}). Awaiting admin approval.` });
    } catch (err) {
        console.error('Withdraw error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/ambassador/register', async (req, res) => {
    try {
        // Log to see exactly what Express is receiving
        console.log("Incoming request body:", req.body);

        if (!req.body) {
            return res.status(400).json({ error: "No data received by the server." });
        }

        const { name, bank_details } = req.body;

        if (!name || !bank_details) {
            return res.status(400).json({ error: 'Please enter your name and bank details.' });
        }

        let unique_code = Math.floor(100000 + Math.random() * 900000).toString();

        // 1. Check if the code exists using your existing 'pool'
        let existing = await pool.query('SELECT id FROM ambassadors WHERE unique_code = $1', [unique_code]);
        while (existing.rows && existing.rows.length > 0) {
            unique_code = Math.floor(100000 + Math.random() * 900000).toString();
            existing = await pool.query('SELECT id FROM ambassadors WHERE unique_code = $1', [unique_code]);
        }

        // 2. Insert user data directly using your existing 'pool'
        await pool.query(
            `INSERT INTO ambassadors (name, unique_code, bank_details, total_referrals, total_earned, total_withdrawn) 
             VALUES ($1, $2, $3, 0, 0, 0)`,
            [name, unique_code, bank_details]
        );

        res.json({ success: true, referral_code: unique_code, name });

    } catch (err) {
        console.error('Database Registration Error:', err);
        res.status(500).json({ error: 'Failed to complete registration.' });
    }
});

app.get('/admin/students', isAdmin, async (req, res) => {
    try {
        const { search, school } = req.query;
        
        // 1. Fetch Stats
        const statsQuery = `
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE has_paid = true) as premium,
                COUNT(*) FILTER (WHERE has_paid = false) as basic
            FROM users`;
        const stats = await pool.query(statsQuery);

        // 2. Fetch Universities for dropdown
        const universities = await pool.query('SELECT * FROM universities ORDER BY name ASC');

        // 3. Build Main Student Query
        let studentQuery = `
            SELECT users.*, universities.name as school_name 
            FROM users 
            LEFT JOIN universities ON users.university_id = universities.id 
            WHERE 1=1`;
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            studentQuery += ` AND (users.name ILIKE $${params.length} OR users.email ILIKE $${params.length})`;
        }
        if (school) {
            params.push(school);
            studentQuery += ` AND users.university_id = $${params.length}`;
        }
        studentQuery += ` ORDER BY users.created_at DESC`;
        
        const students = await pool.query(studentQuery, params);

        res.render('admin/students', { 
            students: students.rows, 
            universities: universities.rows,
            stats: stats.rows[0], // { total: X, premium: Y, basic: Z }
            filters: { search, school }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

app.post('/admin/students/toggle-status/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { has_paid } = req.body; 
        
        // has_paid comes as a string "true" or "false" from the form, 
        // Postgres handles this conversion or use: has_paid === 'true'
        await pool.query('UPDATE users SET has_paid = $1 WHERE id = $2', [has_paid === 'true', id]);
        
        res.redirect('/admin/students');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating payment status");
    }
});
// --- ADMIN DAILY CHALLENGE ROUTES ---

app.get('/admin/daily', isAdmin, async (req, res) => {
    try {
        const [leaderboard, todayCount] = await Promise.all([
            pool.query('SELECT * FROM daily_leaderboard ORDER BY monthly_score DESC LIMIT 30'),
            pool.query("SELECT COUNT(*) as total FROM daily_challenge_attempts WHERE date = CURRENT_DATE")
        ]);

        res.render('admin/daily-manage', { 
            leaderboard: leaderboard.rows, 
            daysLeft: 0,
            todayQuestions: [],
            todayChallenges: parseInt(todayCount.rows[0]?.total || 0)
        });
    } catch (err) {
        console.error("ARENA_ERROR:", err);
        res.status(500).send("Error loading admin daily: " + err.message);
    }
});

app.get('/daily-challenge', isAuth, async (req, res) => {
    const sessionUser = req.session.user;
    const userId = sessionUser.id;
    try {
        const [attemptRes, leaderboardRes] = await Promise.all([
            pool.query(
                'SELECT * FROM daily_challenge_attempts WHERE user_id = $1 AND date = CURRENT_DATE ORDER BY id DESC LIMIT 1',
                [userId]
            ),
            pool.query(`
                SELECT dl.username, dl.monthly_score, univ.slug AS university_slug
                FROM daily_leaderboard dl
                INNER JOIN users u ON dl.user_id = u.id
                INNER JOIN universities univ ON u.university_id = univ.id
                ORDER BY dl.monthly_score DESC LIMIT 20
            `)
        ]);

        const attempt = attemptRes.rows[0] || null;
        const hasPlayed = attempt ? attempt.completed : false;
        const questions = attempt && !attempt.completed ? attempt.questions : [];
        const attemptId = attempt ? attempt.id : null;
        const lastScore = attempt ? attempt.score : null;

        const currentUserEntry = leaderboardRes.rows.find(r => r.username === sessionUser.fullname);
        const userRank = currentUserEntry ? leaderboardRes.rows.indexOf(currentUserEntry) + 1 : null;

        res.render('daily-challenge', {
            user: sessionUser,
            hasPlayed,
            attemptId,
            questions,
            subject: attempt ? attempt.subject : null,
            lastScore,
            leaderboard: leaderboardRes.rows,
            userRank,
            currentUsername: sessionUser.fullname
        });
    } catch (err) {
        console.error("DAILY_CHALLENGE_ERROR:", err);
        res.status(500).send("Maintenance.");
    }
});

app.post('/api/daily-challenge/start', isAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { subjects } = req.body;
    if (!subjects || !Array.isArray(subjects) || subjects.length === 0) return res.json({ error: 'Select at least one subject.' });
    if (subjects.length > 3) return res.json({ error: 'Max 3 subjects.' });

    try {
        const existing = await pool.query(
            'SELECT id FROM daily_challenge_attempts WHERE user_id = $1 AND date = CURRENT_DATE AND completed = true',
            [userId]
        );
        if (existing.rows.length > 0) return res.json({ error: 'Already completed today.' });

        const subjectList = subjects.join(', ');
        const prompt = `Generate 15 multiple-choice questions covering: ${subjectList}. University level, mixed across subjects.
Each: 4 options (A-D), one correct, brief explanation. Vary difficulty.
Return ONLY valid JSON array:
[{"question_text":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","correct_option":"A","explanation":"..."}]`;

        let questions;
        const endpoints = [
            { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', key: process.env.GEMINI_API_KEY_PRIMARY },
            { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', key: process.env.GEMINI_API_KEY_SECONDARY }
        ].filter(e => e.key);

        let generated = false;
        for (const ep of endpoints) {
            try {
                const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.5, maxOutputTokens: 4096 } };
                const resp = await fetch(`${ep.url}?key=${ep.key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
                if (resp.ok) {
                    const data = await resp.json();
                    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (text) { questions = JSON.parse(text); generated = true; break; }
                }
            } catch (_) {}
        }

        if (!generated) {
            const key = process.env.MISTRAL_API_KEY;
            if (key) {
                try {
                    const orResp = await fetch('https://api.mistral.ai/v1/chat/completions', {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                        body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.5 }),
                        signal: AbortSignal.timeout(25000)
                    });
                    if (orResp.ok) {
                        const orData = await orResp.json();
                        const orText = orData.choices?.[0]?.message?.content?.trim();
                        if (orText) { questions = JSON.parse(orText.replace(/```json|```/g, '').trim()); generated = true; }
                    }
                } catch (_) {}
            }
        }

        if (!generated || !Array.isArray(questions) || questions.length < 5) {
            return res.json({ error: 'Could not generate questions. Try again.' });
        }
        questions = questions.slice(0, 15);

        const insert = await pool.query(
            `INSERT INTO daily_challenge_attempts (user_id, subject, questions, total) VALUES ($1, $2, $3, $4) RETURNING id`,
            [userId, subjectList, JSON.stringify(questions), questions.length]
        );

        res.json({ success: true, attemptId: insert.rows[0].id, questions });
    } catch (e) {
        console.error('DAILY_START_ERROR:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/submit-arena', isAuth, async (req, res) => {
    const sessionUser = req.session.user;
    const { attemptId, score } = req.body;
    const userId = sessionUser.id;
    const username = sessionUser.fullname;

    try {
        const attempt = await pool.query(
            'SELECT id FROM daily_challenge_attempts WHERE id = $1 AND user_id = $2 AND completed = false',
            [attemptId, userId]
        );
        if (!attempt.rows[0]) return res.status(403).json({ error: 'No active challenge.' });

        await pool.query(
            'UPDATE daily_challenge_attempts SET score = $1, completed = true WHERE id = $2',
            [score, attemptId]
        );

        await pool.query(
            `INSERT INTO daily_leaderboard (user_id, username, monthly_score, last_played)
             VALUES ($1, $2, $3, CURRENT_DATE)
             ON CONFLICT (user_id)
             DO UPDATE SET
                monthly_score = daily_leaderboard.monthly_score + EXCLUDED.monthly_score,
                last_played = CURRENT_DATE,
                username = EXCLUDED.username`,
            [userId, username, score]
        );

        res.json({ success: true, score });
    } catch (err) {
        console.error("ARENA_SUBMIT_ERROR:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/admin/analytics', isAdmin, async (req, res) => {
    try {
        const [totals, signupTrend, popularPages, couponStats] = await Promise.all([
            pool.query(`SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as daily_signups,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as weekly_signups,
                (SELECT COUNT(*) FROM users WHERE has_paid = true) as premium_users,
                (SELECT COUNT(*) FROM users WHERE has_paid = true AND created_at > NOW() - INTERVAL '7 days') as weekly_premium,
                (SELECT COUNT(*) FROM results) as total_quizzes,
                (SELECT COUNT(*) FROM study_quiz_attempts) as study_quiz_count,
                (SELECT COUNT(*) FROM daily_leaderboard) as active_battlers,
                (SELECT COUNT(*) FROM users WHERE used_coupon IS NOT NULL) as coupon_redemptions`),

            pool.query(`SELECT TO_CHAR(created_at, 'DD Mon') as date, COUNT(*) as count 
                        FROM users 
                        WHERE created_at > NOW() - INTERVAL '14 days'
                        GROUP BY date ORDER BY MIN(created_at) ASC`),

            pool.query(`SELECT page_path, COUNT(*) as views 
                        FROM page_views 
                        GROUP BY page_path ORDER BY views DESC LIMIT 6`).catch(() => ({ rows: [] })),

            pool.query(`SELECT code, discount_type, discount_value, times_used, max_uses, is_active 
                        FROM coupons ORDER BY times_used DESC LIMIT 10`)
        ]);

        const s = totals.rows[0];
        const estimatedRevenue = (s.premium_users || 0) * 2000;

        res.render('admin/analytics', {
            signups: { daily: s.daily_signups || 0, weekly: s.weekly_signups || 0 },
            stats: {
                total_users: s.total_users || 0,
                premium_users: s.premium_users || 0,
                weekly_premium: s.weekly_premium || 0,
                total_quizzes: (s.total_quizzes || 0) + (s.study_quiz_count || 0),
                active_battlers: s.active_battlers || 0
            },
            revenue: { estimated: estimatedRevenue, coupon_redemptions: s.coupon_redemptions || 0 },
            coupons: couponStats.rows,
            chartData: {
                labels: signupTrend.rows.map(r => r.date),
                values: signupTrend.rows.map(r => r.count)
            },
            pages: popularPages.rows,
            user: req.session.user
        });
    } catch (err) {
        console.error("Analytics Route Error:", err);
        res.status(500).send("Error loading full analytics suite.");
    }
});

app.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    try {
        // 1. Generate a secure token
        const token = crypto.randomBytes(20).toString('hex');
        const expires = new Date(Date.now() + 3600000);

        // 2. Save token to DB
        const result = await pool.query(
            'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE email = $3 RETURNING *',
            [token, expires, email]
        );

        if (result.rowCount === 0) {
            return res.send("If an account exists with that email, a link has been sent.");
        }

        if (!transporter) {
            return res.status(500).send('Email service not configured.');
        }

        // 3. Send email
        const resetLink = `${req.protocol}://${req.get('host')}/reset/${token}`;
        const mailOptions = {
            from: '"Prepium Support" <no-reply@prepium.com>',
            to: email,
            subject: 'Password Reset Request',
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #0062ff;">Prepium</h2>
                    <p>You requested a password reset. Click the button below to continue:</p>
                    <a href="${resetLink}"
                       style="background: #0062ff; color: white; padding: 12px 20px; text-decoration: none; border-radius: 8px; display: inline-block;">
                       Reset My Password
                    </a>
                    <p style="margin-top: 20px; font-size: 12px; color: #777;">This link expires in 1 hour.</p>
                </div>`
        };

        await transporter.sendMail(mailOptions);
        res.send("Check your email for the recovery link.");

    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});
// This route Renders the page when the user clicks the email link
app.get('/reset/:token', async (req, res) => {
    const { token } = req.params;

    try {
        // 1. Verify if the token is valid and not expired in Neon
        const userCheck = await pool.query(
            'SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()',
            [token]
        );

        if (userCheck.rowCount === 0) {
            return res.send(`
                <div style="text-align:center; padding:50px; font-family:sans-serif;">
                    <h2>Link Expired or Invalid</h2>
                    <p>This password reset link is no longer valid. Please request a new one.</p>
                    <a href="/forgot-password" style="color:#0062ff;">Try again</a>
                </div>
            `);
        }

        // 2. If valid, show the reset password EJS and pass the token to it
        res.render('reset-password', { token });

    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error");
    }
});

app.post('/reset/:token', async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    try {
        // 1. Check if token is still valid
        const userCheck = await pool.query(
            'SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()',
            [token]
        );

        if (userCheck.rowCount === 0) {
            return res.status(400).send("Link expired or invalid.");
        }

        // 2. CRYPT the new password (Salting & Hashing)
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // 3. Update the database with the HASHED password
        await pool.query(
            'UPDATE users SET password = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE reset_password_token = $2',
            [hashedPassword, token] 
        );

        // Success! Redirect to login with a success message
        res.send(`
            <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
            <script>
                window.onload = function() {
                    Swal.fire({
                        icon: 'success',
                        title: 'Password Updated',
                        text: 'Your account is now secure. Please login.',
                        confirmButtonColor: '#0062ff'
                    }).then(() => {
                        window.location.href = '/login';
                    });
                };
            </script>
        `);

    } catch (err) {
        console.error("Reset Error:", err);
        res.status(500).send("Could not update password.");
    }
});

// This tells the server: "When someone visits /forgot-password, show the page"
app.get('/forgot-password', (req, res) => {
    res.render('forgot-password'); 
});

// This handles the form submission when the user clicks the button
app.post('/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    // ... your logic to check DB and send email goes here
    res.json({ success: true, message: "Check your inbox" });
});


app.get('/download-vcard', (req, res) => {
    const vcardContent = `BEGIN:VCARD
VERSION:3.0
FN:Alite
TEL;TYPE=CELL:+2349154681851
END:VCARD`;

    res.set({
        'Content-Type': 'text/vcard',
        'Content-Disposition': 'attachment; filename="Alite.vcf"',
    });

    res.send(vcardContent);
});
app.get('/ai-quiz', isAuth, (req, res) => {
    res.render('ai-quiz', { 
        user: req.session.user, 
        paystack_key: process.env.PAYSTACK_PUBLIC_KEY 
    });
});

// ─── ADMIN QUIZ GENERATOR ─────────────────────────────────────────────────
const isAdminQuiz = (r, res, n) => {
    if (r.session.user && r.session.user.is_admin) return n();
    res.redirect('/admin/login');
};

app.get('/admin/quiz-generator', isAdminQuiz, async (req, res) => {
    try {
        const unis = await pool.query('SELECT id, name FROM universities ORDER BY name');
        const sessions = await pool.query(
            `SELECT s.*, u.name as uni_name FROM admin_quiz_sessions s JOIN universities u ON s.university_id = u.id ORDER BY s.created_at DESC`
        );
        res.render('admin/quiz-generator', { user: req.session.user, universities: unis.rows, sessions: sessions.rows });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/admin/quiz/create-session', isAdminQuiz, async (req, res) => {
    try {
        const { university_id, level } = req.body;
        const r = await pool.query(
            'INSERT INTO admin_quiz_sessions (admin_id, university_id, level) VALUES ($1,$2,$3) RETURNING id',
            [req.session.user.id, university_id, level]
        );
        res.json({ success: true, id: r.rows[0].id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quiz/generate-courses', isAdminQuiz, async (req, res) => {
    try {
        const { sessionId } = req.body;
        const sess = await pool.query('SELECT * FROM admin_quiz_sessions WHERE id = $1', [sessionId]);
        if (!sess.rows[0]) return res.json({ error: 'Session not found' });
        const s = sess.rows[0];
        const uni = await pool.query('SELECT name FROM universities WHERE id = $1', [s.university_id]);
        const uniName = uni.rows[0]?.name || 'University';
        const prompt = `You are a Nigerian university curriculum expert. List the standard courses offered by ${uniName} at ${s.level} Level across all departments following CCMAS and BMAS standards.
Return ONLY a raw JSON array (no markdown, no code fences) with objects:
[{"code":"CourseCode","title":"Full Course Title","department":"Department Name"}]
Include at least 15-20 courses covering different departments.`;
        const aiRes = await studyPromptSmart(prompt);
        if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ error: 'AI could not generate courses. ' + (aiRes.text || '') });
        let courses;
        try { courses = JSON.parse(aiRes.text); } catch(_) {
            const m = aiRes.text.match(/\[[\s\S]*\]/);
            if (m) try { courses = JSON.parse(m[0]); } catch(_2) { return res.json({ error: 'AI returned invalid data.' }); }
            else return res.json({ error: 'AI returned invalid data.' });
        }
        for (const c of courses) {
            await pool.query(
                'INSERT INTO admin_quiz_courses (session_id, course_code, course_title, department) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
                [sessionId, c.code, c.title, c.department || '']
            );
        }
        await pool.query('UPDATE admin_quiz_sessions SET status = $1 WHERE id = $2', ['courses_ready', sessionId]);
        res.json({ success: true, count: courses.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quiz/update-course', isAdminQuiz, async (req, res) => {
    try {
        const { id, status, course_code, course_title } = req.body;
        await pool.query(
            'UPDATE admin_quiz_courses SET status = $1, course_code = COALESCE($2, course_code), course_title = COALESCE($3, course_title) WHERE id = $4',
            [status || 'pending', course_code || null, course_title || null, id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/quiz/courses/:sessionId', isAdminQuiz, async (req, res) => {
    try {
        const courses = await pool.query(
            'SELECT * FROM admin_quiz_courses WHERE session_id = $1 ORDER BY status, course_code',
            [req.params.sessionId]
        );
        res.json({ courses: courses.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quiz/generate-questions', isAdminQuiz, async (req, res) => {
    try {
        const { sessionId, questionCount } = req.body;
        const courses = await pool.query(
            "SELECT * FROM admin_quiz_courses WHERE session_id = $1 AND status = 'approved'", [sessionId]
        );
        if (courses.rows.length === 0) return res.json({ error: 'No approved courses.' });
        const count = parseInt(questionCount) || 10;
        let total = 0;
        for (const course of courses.rows) {
            const prompt = `You are a Nigerian university examiner. Generate exactly ${count} multiple-choice questions for the course "${course.course_code} - ${course.course_title}" at the university level. Each question must have 4 options (A-D), one correct answer, a clear explanation, and optionally a diagram description.
Return ONLY a raw JSON array (no markdown):
[{"question":"Question text here","options":["Option A","Option B","Option C","Option D"],"correct":"A","explanation":"Why this is correct","diagram":"description if needed or empty string"}]
Make questions exam-standard, some with diagrams where applicable (circuits, graphs, structures).`;
            const aiRes = await studyPromptSmart(prompt);
            if (aiRes.text && !aiRes.text.startsWith('AI error')) {
                let qs;
                try { qs = JSON.parse(aiRes.text); } catch(_) {
                    const m = aiRes.text.match(/\[[\s\S]*\]/);
                    if (m) try { qs = JSON.parse(m[0]); } catch(_2) { continue; }
                    else continue;
                }
                for (const q of qs) {
                    await pool.query(
                        'INSERT INTO admin_quiz_questions (course_id, question_text, options, correct_answer, explanation, diagram_url) VALUES ($1,$2,$3,$4,$5,$6)',
                        [course.id, q.question, JSON.stringify(q.options || []), q.correct, q.explanation || '', q.diagram || '']
                    );
                }
                total += qs.length;
            }
        }
        await pool.query('UPDATE admin_quiz_sessions SET status = $1 WHERE id = $2', ['questions_ready', sessionId]);
        res.json({ success: true, total });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/quiz/publish', isAdminQuiz, async (req, res) => {
    try {
        await pool.query('UPDATE admin_quiz_sessions SET status = $1 WHERE id = $2', ['published', req.body.sessionId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DAILY TASK DASHBOARD ──────────────────────────────────────────────────

app.get('/daily-task', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const today = new Date().toISOString().split('T')[0];
        const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

        // 1. Today's school timetable slots
        const slotsRes = await pool.query(
            `SELECT id, course, course_code, start_time, end_time, venue
             FROM timetables WHERE user_id = $1 AND day = $2
             ORDER BY start_time`, [userId, dayName]
        );

        // 2. Today's reading timetable slots
        const readingRes = await pool.query(
            `SELECT id, course, course_code, start_time, end_time
             FROM reading_timetables WHERE user_id = $1 AND day = $2
             ORDER BY start_time`, [userId, dayName]
        );

        // 3. Upcoming deadlines
        const deadlineRes = await pool.query(
            `SELECT id, title, TO_CHAR(due_date, 'Mon DD') as date_str, TO_CHAR(due_time, 'HH24:MI') as time_str
             FROM deadlines WHERE user_id = $1 AND due_date >= CURRENT_DATE
             ORDER BY due_date, due_time LIMIT 10`, [userId]
        );

        // 4. Personal goals
        const goalsRes = await pool.query(
            `SELECT id, goal, target_date, is_completed
             FROM personal_goals WHERE user_id = $1
             ORDER BY is_completed, created_at DESC`, [userId]
        );

        // 5. Today's task items (tick-box)
        const tasksRes = await pool.query(
            `SELECT id, task_type, task_label, is_done
             FROM daily_task_items WHERE user_id = $1 AND task_date = $2
             ORDER BY created_at`, [userId, today]
        );

        // 6. Weekly analysis
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const weekStartStr = weekStart.toISOString().split('T')[0];

        const weekRes = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN is_done THEN 1 ELSE 0 END), 0) as done,
                    COUNT(*) as total
             FROM daily_task_items
             WHERE user_id = $1 AND task_date >= $2 AND task_date <= $3`,
            [userId, weekStartStr, today]
        );

        const studyWeekRes = await pool.query(
            `SELECT COALESCE(SUM(elapsed_seconds), 0) as secs
             FROM study_sessions WHERE user_id = $1
             AND status = 'completed'
             AND DATE(created_at) >= $2 AND DATE(created_at) <= $3`,
            [userId, weekStartStr, today]
        );

        const quizWeekRes = await pool.query(
            `SELECT COUNT(*) as count, COALESCE(AVG(percentage), 0) as avg
             FROM quiz_results WHERE user_id = $1
             AND DATE(created_at) >= $2 AND DATE(created_at) <= $3`,
            [userId, weekStartStr, today]
        );

        res.render('daily-task', {
            user: req.session.user,
            today,
            dayName,
            slots: slotsRes.rows,
            readingSlots: readingRes.rows,
            deadlines: deadlineRes.rows,
            goals: goalsRes.rows,
            tasks: tasksRes.rows,
            weekStats: {
                done: parseInt(weekRes.rows[0].done),
                total: parseInt(weekRes.rows[0].total),
                studyMins: Math.round(parseInt(studyWeekRes.rows[0].secs) / 60),
                quizCount: parseInt(quizWeekRes.rows[0].count),
                avgScore: Math.round(parseFloat(quizWeekRes.rows[0].avg))
            }
        });
    } catch (err) {
        console.error('Daily Task Error:', err);
        res.redirect('/dashboard');
    }
});

// POST: Add personal goal
app.post('/api/daily-task/goal', isAuth, async (req, res) => {
    const { goal, target_date } = req.body;
    if (!goal) return res.status(400).json({ success: false, error: 'Goal text required' });
    try {
        await pool.query(
            'INSERT INTO personal_goals (user_id, goal, target_date) VALUES ($1, $2, $3)',
            [req.session.user.id, goal, target_date || null]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: Toggle goal completion
app.post('/api/daily-task/goal/toggle/:id', isAuth, async (req, res) => {
    try {
        await pool.query(
            'UPDATE personal_goals SET is_completed = NOT is_completed WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: Delete goal
app.post('/api/daily-task/goal/delete/:id', isAuth, async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM personal_goals WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: Toggle daily task
app.post('/api/daily-task/task/toggle', isAuth, async (req, res) => {
    const { taskId } = req.body;
    try {
        await pool.query(
            'UPDATE daily_task_items SET is_done = NOT is_done WHERE id = $1 AND user_id = $2',
            [taskId, req.session.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: Auto-generate daily tasks from timetable + deadlines + goals
app.post('/api/daily-task/generate-tasks', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const today = new Date().toISOString().split('T')[0];
        const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });

        var count = 0;

        // Generate from school timetable
        const slots = await pool.query(
            'SELECT id, course, start_time, end_time FROM timetables WHERE user_id = $1 AND day = $2',
            [userId, dayName]
        );
        for (const s of slots.rows) {
            await pool.query(
                `INSERT INTO daily_task_items (user_id, task_date, task_type, task_label)
                 VALUES ($1, $2, 'class', $3) ON CONFLICT DO NOTHING`,
                [userId, today, 'Attend ' + s.course + ' (' + (s.start_time||'').substring(0,5) + '-' + (s.end_time||'').substring(0,5) + ')']
            );
            count++;
        }

        // Generate from reading timetable
        const readingSlots = await pool.query(
            'SELECT id, course, start_time, end_time FROM reading_timetables WHERE user_id = $1 AND day = $2',
            [userId, dayName]
        );
        for (const r of readingSlots.rows) {
            await pool.query(
                `INSERT INTO daily_task_items (user_id, task_date, task_type, task_label)
                 VALUES ($1, $2, 'study', $3) ON CONFLICT DO NOTHING`,
                [userId, today, 'Study ' + r.course + ' (' + (r.start_time||'').substring(0,5) + '-' + (r.end_time||'').substring(0,5) + ')']
            );
            count++;
        }

        // Generate from deadlines
        const deadlines = await pool.query(
            `SELECT id, title FROM deadlines WHERE user_id = $1 AND due_date = $2`,
            [userId, today]
        );
        for (const d of deadlines.rows) {
            await pool.query(
                `INSERT INTO daily_task_items (user_id, task_date, task_type, task_label)
                 VALUES ($1, $2, 'deadline', $3) ON CONFLICT DO NOTHING`,
                [userId, today, 'Submit: ' + d.title]
            );
            count++;
        }

        // If nothing generated, create default tasks
        if (count === 0) {
            const defaults = ['Review lecture notes', 'Read a chapter'];
            for (const label of defaults) {
                await pool.query(
                    `INSERT INTO daily_task_items (user_id, task_date, task_type, task_label)
                     VALUES ($1, $2, 'general', $3) ON CONFLICT DO NOTHING`,
                    [userId, today, label]
                );
                count++;
            }
        }

        res.json({ success: true, count: count });
    } catch (err) {
        console.error('Generate tasks error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: Weekly report data (JSON)
app.get('/api/daily-task/weekly-report', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const today = new Date().toISOString().split('T')[0];
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const ws = weekStart.toISOString().split('T')[0];

        const [dayData, studyData, quizData] = await Promise.all([
            pool.query(
                `SELECT task_date, COUNT(*) as total,
                        SUM(CASE WHEN is_done THEN 1 ELSE 0 END) as done
                 FROM daily_task_items WHERE user_id = $1
                 AND task_date >= $2 AND task_date <= $3
                 GROUP BY task_date ORDER BY task_date`,
                [userId, ws, today]
            ),
            pool.query(
                `SELECT DATE(created_at) as d, SUM(elapsed_seconds) as secs
                 FROM study_sessions WHERE user_id = $1
                 AND status = 'completed' AND DATE(created_at) >= $2
                 GROUP BY DATE(created_at) ORDER BY d`,
                [userId, ws]
            ),
            pool.query(
                `SELECT DATE(created_at) as d, COUNT(*) as cnt,
                        ROUND(AVG(percentage)) as avg
                 FROM quiz_results WHERE user_id = $1
                 AND DATE(created_at) >= $2
                 GROUP BY DATE(created_at) ORDER BY d`,
                [userId, ws]
            )
        ]);

        res.json({
            days: dayData.rows,
            study: studyData.rows,
            quizzes: quizData.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/upload-pdf', uploadMemory.single('lecture_note'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded." });
        }

        // memoryStorage gives us req.file.buffer, not a file path
        const pdfBuffer = req.file.buffer;

        pdfToText.pdfToText(pdfBuffer, (err, text) => {
            if (err) {
                console.error("PDF Parsing Error:", err);
                return res.status(500).json({ success: false, message: "Failed to parse PDF." });
            }

            console.log("Extracted text successfully.");
            res.json({ success: true, text: text });
        });

    } catch (err) {
        console.error("Route Error:", err);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

// POST: Generate quizzes from client-extracted PDF text
app.post('/generate-ai-quiz', isAuth, requirePaid, async (req, res) => {
    try {
        const { pdfText, fileName, num_questions, quiz_duration, question_type, difficulty } = req.body;

        if (!pdfText || !pdfText.trim()) {
            return res.status(400).json({ success: false, message: "Could not extract text from PDF. Try a different file." });
        }

        const numQuestions = parseInt(num_questions) || 5;
        const quizDuration = parseInt(quiz_duration) || 5;
        const questionType = question_type || 'obj';
        const difficultyLevel = difficulty || 'medium';
        const originalFileName = fileName || 'document';

        console.log(`[AI ENGINE] Generating ${numQuestions} questions from text "${originalFileName}"`);

        let styleInstruction = "";
        if (questionType === 'obj') {
            styleInstruction = "You MUST generate ONLY standard 4-choice Multiple Choice Questions. Every item's 'type' field MUST be exactly 'obj'. Options array must have exactly 4 distinct text items.";
        } else if (questionType === 'german') {
            styleInstruction = "You MUST generate ONLY Fill-in-the-gap questions containing a blank line (____). Every item's 'type' field MUST be exactly 'german'. Keep the options array completely empty [].";
        } else if (questionType === 'theory') {
            styleInstruction = "You MUST generate ONLY open-ended deep conceptual essay questions. Every item's 'type' field MUST be exactly 'theory'. Provide grading keywords. Keep options array completely empty [].";
        } else {
            styleInstruction = "You may mix 'obj', 'german', and 'theory' question types throughout the collection layout.";
        }

        const difficultyMap = { easy: 'basic recall and comprehension level', medium: 'application and analysis level', hard: 'synthesis and evaluation level', expert: 'critical thinking and expert level' };
        const difficultyText = difficultyMap[difficultyLevel] || 'application and analysis level';

        // Truncate if too long
        const maxChars = 12000;
        var cleanText = pdfText;
        if (cleanText.length > maxChars) cleanText = cleanText.substring(0, maxChars) + "\n...[truncated]";

        // Generate questions via AI
        let jsonStructure = '';
        if (questionType === 'obj' || questionType === 'mixed') {
            jsonStructure = `You MUST respond with a raw JSON array matching this structure:
[
  {
    "type": "${questionType === 'mixed' ? 'obj' : questionType}",
    "question": "Question text here...",
    "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
    "correct": "A",
    "keywords": ["key1", "key2"],
    "explanation": "Clear explanation in plain text."
  }
]
For 'obj' type, "correct" MUST be the LETTER of the correct option (A, B, C, or D).`;
        } else if (questionType === 'german') {
            jsonStructure = `You MUST respond with a raw JSON array matching this structure:
[
  {
    "type": "german",
    "question": "Text with a blank like ____ here",
    "options": [],
    "correct": "the exact expected answer text",
    "keywords": ["key1", "key2"],
    "explanation": "Clear explanation in plain text."
  }
]
For 'german' type, "correct" MUST be the exact word or phrase that fills the blank. "options" MUST be an empty array [].`;
        } else if (questionType === 'theory') {
            jsonStructure = `You MUST respond with a raw JSON array matching this structure:
[
  {
    "type": "theory",
    "question": "Essay question text here...",
    "options": [],
    "correct": "key point that should be mentioned",
    "keywords": ["expected keyword 1", "expected keyword 2"],
    "explanation": "Clear explanation in plain text."
  }
]
For 'theory' type, "correct" should be the main expected point, "options" MUST be an empty array [], and "keywords" should contain key terms to look for.`;
        }

        const prompt = `You are an expert academic examiner. Analyze the following document content carefully.
Generate exactly ${numQuestions} unique, highly relevant academic questions based strictly on its contents.

DIFFICULTY LEVEL: ${difficultyText} — adjust question complexity accordingly.

CRITICAL STYLE RULE: ${styleInstruction}

IMPORTANT: Use JSON key "question" for the question text. Each question MUST include an "explanation" key with a clear explanation.

${jsonStructure}

DOCUMENT CONTENT:
${cleanText}`;

        const aiRes = await studyPromptJSON(prompt);
        let responseText = (aiRes.text || '').trim();
        if (!responseText) throw new Error('Failed to compile quiz questions. Try again.');

        if (responseText.startsWith("```json")) responseText = responseText.replace(/^```json/, "").replace(/```$/, "");
        if (responseText.startsWith("```")) responseText = responseText.replace(/^```/, "").replace(/```$/, "");
        responseText = extractJsonItems(responseText);

        let parsedData;
        try {
            parsedData = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse AI response:", responseText.substring(0, 200));
            throw new Error("Failed to parse AI response. Try again.");
        }

        let rawList = Array.isArray(parsedData) ? parsedData : (parsedData.questions || parsedData.quiz || []);

        function cleanOptPrefix(o) { return String(o).replace(/^[A-Da-d1-4][\.\)]\s*/, ''); }
        function answerLetter(val, opts) {
            if (!val) return 'A';
            var s = String(val).trim();
            var m = s.match(/^([A-Da-d])[\.\)]\s*/);
            if (m) return m[1].toUpperCase();
            if (/^[A-Da-d]$/i.test(s)) return s.toUpperCase();
            var n = parseInt(s);
            if (!isNaN(n)) return String.fromCharCode(65 + (n >= 1 && n <= 4 ? n - 1 : n));
            if (Array.isArray(opts)) {
                for (var i = 0; i < opts.length; i++) {
                    if (cleanOptPrefix(opts[i]).toLowerCase() === s.toLowerCase() || opts[i].toLowerCase() === s.toLowerCase()) return String.fromCharCode(65 + i);
                }
            }
            return 'A';
        }
        let structuredQuiz = rawList.map(q => {
            var question = q.question || q.text || q.questionText || q.question_text || '';
            var options = Array.isArray(q.options) && q.options.length ? q.options : (Array.isArray(q.choices) ? q.choices : []);
            var cleanOpts = options.map(function(o) { return cleanOptPrefix(o); });
            var t = questionType;
            if (t === 'mixed') t = q.type || 'obj';
            return {
                type: t,
                question: question,
                options: cleanOpts,
                correct: (t === 'german' || t === 'theory') ? (q.correct || q.correctAnswer || q.answer || '') : answerLetter(q.correct || q.correctAnswer || q.answer || q.correct_option || '', cleanOpts),
                keywords: q.keywords || [],
                explanation: q.explanation || q.exp || ''
            };
        }).filter(q => q.question);

        res.json({ 
            success: true, 
            questions: structuredQuiz,
            quizTitle: `AI-Test (${originalFileName.replace(/\.[^/.]+$/, "")})`,
            durationSeconds: quizDuration * 60
        });

    } catch (error) {
        console.error("Critical AI Quiz Generation Failure:", error);
        res.status(500).json({ success: false, message: error.message || "Error compiling quiz matrix." });
    }
});

// POST: Save and Persist Graded Flexible Score Results
app.post('/save-ai-quiz-results', isAuth, async (req, res) => {
    try {
        const { quizTitle, totalQuestions, correctAnswers, scorePercentage } = req.body;
        
        // Safety validation fallback check handling session tracking formats stably
        const userId = req.session.user ? req.session.user.id : null;
        
        if (!userId) {
            return res.status(401).json({ success: false, message: "Unauthorized account context profile tracking session." });
        }

        // Stores numeric evaluation scores as floating-point metrics (e.g., 3.5 out of 5 for partial theoretical credit)
        const insertQuery = `
            INSERT INTO quiz_results (user_id, subject_id, title, score, total_questions, percentage, created_at)
            VALUES ($1, NULL, $2, $3, $4, $5, NOW())
            RETURNING *
        `;

        await pool.query(insertQuery, [
            userId,
            quizTitle,          
            parseFloat(correctAnswers), 
            parseInt(totalQuestions),    
            parseInt(scorePercentage)   
        ]);

        console.log(`[DATABASE SYNC] AI CBT score logged for Student ID: ${userId} (${correctAnswers}/${totalQuestions})`);
        res.json({ success: true, message: "Performance metrics logged to PostgreSQL core." });

    } catch (err) {
        console.error("Critical Database History Sync Error:", err);
        res.status(500).json({ success: false, message: "Internal server error persisting score profile." });
    }
});

app.get('/api/ai-quiz/history', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            'SELECT id, title, score, total_questions, percentage, created_at FROM quiz_results WHERE user_id = $1 AND subject_id IS NULL ORDER BY created_at DESC LIMIT 30',
            [uid]
        );
        res.json({ success: true, history: r.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});





function buildCGPA(profile, courses) {
    const scale  = parseInt(profile.grading_scale) || 5;
    const gpMap5 = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
    const gpMap4 = { A: 4, B: 3, C: 2, D: 1, E: 0, F: 0 };
    const gpMap  = scale === 5 ? gpMap5 : gpMap4;

    // Carry forward the balance-imported quality points
    let totalUnits  = parseInt(profile.prev_units) || 0;
    let totalPoints = parseFloat(profile.prev_gp)  || 0;

    const gradeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

    courses.forEach(c => {
        const g = (c.grade || 'F').toUpperCase();
        if (gradeCounts.hasOwnProperty(g)) gradeCounts[g]++;
        // Only count visible courses
        if (!c.is_hidden) {
            const u  = parseInt(c.credit_units) || 0;
            const pt = gpMap[g] !== undefined ? gpMap[g] : 0;
            totalUnits  += u;
            totalPoints += pt * u;
        }
    });

    const cgpa = totalUnits > 0
        ? parseFloat((totalPoints / totalUnits).toFixed(2))
        : 0;

    // Degree class
    let degreeClass = 'Pass';
    let divBadge    = 'none';
    if (scale === 5) {
        if      (cgpa >= 4.50) { degreeClass = 'First Class Honours';  divBadge = 'first'; }
        else if (cgpa >= 3.50) { degreeClass = 'Second Class (Upper)'; divBadge = 'upper'; }
        else if (cgpa >= 2.40) { degreeClass = 'Second Class (Lower)'; divBadge = 'lower'; }
        else if (cgpa >= 1.50) { degreeClass = 'Third Class';          divBadge = 'third'; }
        else if (cgpa >= 1.00) { degreeClass = 'Pass';                 divBadge = 'none';  }
        else                   { degreeClass = 'Fail';                 divBadge = 'fail';  }
    } else {
        if      (cgpa >= 3.50) { degreeClass = 'First Class Honours';  divBadge = 'first'; }
        else if (cgpa >= 3.00) { degreeClass = 'Second Class (Upper)'; divBadge = 'upper'; }
        else if (cgpa >= 2.00) { degreeClass = 'Second Class (Lower)'; divBadge = 'lower'; }
        else if (cgpa >= 1.50) { degreeClass = 'Third Class';          divBadge = 'third'; }
        else if (cgpa >= 1.00) { degreeClass = 'Pass';                 divBadge = 'none';  }
        else                   { degreeClass = 'Fail';                 divBadge = 'fail';  }
    }

    const arcPct    = Math.min(cgpa / scale, 1);
    const arcOffset = parseFloat((251.2 * (1 - arcPct)).toFixed(1));

    return { cgpa: cgpa.toFixed(2), totalUnits, totalPoints, degreeClass, divBadge, gradeCounts, arcOffset, scale };
}

// A. GET: DASHBOARD LOADER
app.get('/cgpa', isAuth, requirePaid, async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.redirect('/login');
        }
        
        const userId = req.session.user.id; 

        const profileResult = await pool.query(
            'SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [userId]
        );
        const profile = profileResult.rows[0];

        const coursesResult = await pool.query(
            `SELECT id, id AS _id, course_code AS code, credit_units, grade, 
                    level_scope, semester, is_hidden, deleted 
             FROM public.cgpa_courses 
             WHERE user_id = $1 AND deleted = false 
             ORDER BY level_scope ASC, semester ASC`, [userId]
        );
        
        const courses = coursesResult.rows.map(row => ({
            ...row,
            title: row.title || 'Course Module'
        }));

        // Compute template distribution indicators safely
        const gradeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
        courses.forEach(course => {
            const g = (course.grade || 'F').toUpperCase();
            if (!course.is_hidden && gradeCounts[g] !== undefined) {
                gradeCounts[g]++;
            }
        });

        res.render('cgpa', { 
            profile: profile || null, 
            courses: courses || [], 
            hasProfile: !!profile,
            gradeCounts, 
            user: req.session.user,
            flash: req.query.msg || null
        });
    } catch (err) {
        console.error("Dashboard engine failure:", err);
        res.status(500).send('Error loading dashboard workflow.');
    }
});

// B. POST: CONFIGURATION WIZARD SUBMIT
app.post('/cgpa/setup', isAuth, requirePaid, async (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.id) {
        return res.redirect('/login');
    }

    const userId = req.session.user.id;
    const { department, current_level, grading_scale, start_type, prev_cgpa, prev_units } = req.body;

    const scale = parseInt(grading_scale) === 4 ? 4 : 5;
    const sType = start_type === 'balance' ? 'balance' : 'fresh';
    
    // Process input parameters in isolated scope logic cleanly
    const pCGPA  = sType === 'balance' ? (parseFloat(prev_cgpa) || 0.00) : 0.00;
    const pUnits = sType === 'balance' ? (parseInt(prev_units) || 0) : 0;
    const pGP    = parseFloat((pCGPA * pUnits).toFixed(2));

    try {
        await pool.query(
            `INSERT INTO public.cgpa_profiles
                (user_id, department, current_level, grading_scale, prev_units, prev_gp, prev_cgpa)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id) DO UPDATE SET
                department    = EXCLUDED.department,
                current_level = EXCLUDED.current_level,
                grading_scale = EXCLUDED.grading_scale,
                prev_units    = EXCLUDED.prev_units,
                prev_gp       = EXCLUDED.prev_gp,
                prev_cgpa     = EXCLUDED.prev_cgpa,
                updated_at    = NOW()`,
            [userId, department ? department.trim() : 'General', parseInt(current_level) || 300, scale, pUnits, pGP, pCGPA]
        );
        await pool.query('UPDATE users SET current_level = $1 WHERE id = $2', [parseInt(current_level) || 300, userId]);
        
        res.redirect('/cgpa?msg=Profile configured successfully!');
    } catch (err) {
        console.error('CGPA Profiles Upsert Error:', err);
        res.redirect('/cgpa?msg=Setup wizard failure. Please verify settings.');
    }
});

// 4. APPEND NEW MATRIX COURSE ROUTE
app.post('/cgpa/course/add', isAuth, requirePaid, async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.redirect('/login');
        }
        const userId = req.session.user.id;
        const { code, title, level_scope, semester, credit_units, grade } = req.body;

        // Fixed query target column from 'code' to 'course_code'
        await pool.query(
            `INSERT INTO public.cgpa_courses 
             (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)`,
            [
                userId, 
                code.toUpperCase(), 
                title || 'Course Module',
                parseInt(level_scope), 
                parseInt(semester), 
                parseInt(credit_units), 
                grade.toUpperCase()
            ]
        );

        res.redirect('/cgpa?msg=Course added successfully!');
    } catch (err) {
        console.error('Add Course Error:', err);
        res.status(500).send('Error adding course to registry matrix');
    }
});

// 2B. AJAX ADD COURSE (for polished overlay)
app.post('/api/cgpa/course/add-ajax', isAuth, async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.json({ success: false, error: 'Not authenticated' });
        }
        const userId = req.session.user.id;
        const { code, title, level_scope, semester, credit_units, grade } = req.body;
        const courseCode = (code || '').trim().toUpperCase();
        if (!courseCode) return res.json({ success: false, error: 'Course code required' });

        const exist = await pool.query(
            'SELECT id FROM public.cgpa_courses WHERE user_id = $1 AND course_code = $2 AND deleted = false',
            [userId, courseCode]
        );
        if (exist.rows.length > 0) {
            return res.json({ success: true, duplicate: true, error: 'Course already exists' });
        }

        await pool.query(
            `INSERT INTO public.cgpa_courses 
             (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)`,
            [
                userId,
                courseCode,
                (title || '').trim() || 'Course Module',
                parseInt(level_scope),
                parseInt(semester),
                parseInt(credit_units),
                (grade || '').trim().toUpperCase()
            ]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('AJAX Add Course Error:', err);
        res.json({ success: false, error: 'Error adding course' });
    }
});

// 3. EDIT EXISTING REGISTERED COURSE PARAMETERS
app.post('/cgpa/course/edit', isAuth, requirePaid, async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.redirect('/login');
        }
        const userId = req.session.user.id; 
        const { id, code, title, units, grade } = req.body;

        // Fixed target column to match database schema exactly
        await pool.query(
            `UPDATE public.cgpa_courses 
             SET course_code = $1, title = $2, credit_units = $3, grade = $4 
             WHERE id = $5 AND user_id = $6`,
            [code.toUpperCase(), title || 'Course Module', parseInt(units), grade.toUpperCase(), id, userId]
        );

        res.redirect('/cgpa?msg=Course updated successfully!');
    } catch (err) {
        console.error('Edit Course Error:', err);
        res.status(500).send('Error updating course parameters');
    }
});

app.post('/cgpa/course/toggle-visible/:id', isAuth, requirePaid, async (req, res) => {
    const userId = req.session.user.id;
    const { id }  = req.params;

    try {
        // Ownership + flip
        await pool.query(
            `UPDATE cgpa_courses
             SET is_hidden = NOT is_hidden, updated_at = NOW()
             WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );
        res.redirect('/cgpa');
    } catch (err) {
        console.error('Toggle Visibility Error:', err);
        res.redirect('/cgpa');
    }
});


app.post('/cgpa/course/delete/:id', isAuth, requirePaid, async (req, res) => {
    const userId = req.session.user.id;
    const { id }  = req.params;

    try {
        await pool.query(
            'DELETE FROM cgpa_courses WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        res.redirect('/cgpa?msg=Course removed.');
    } catch (err) {
        console.error('Delete Course Error:', err);
        res.redirect('/cgpa');
    }
});


app.post('/cgpa/reset', isAuth, requirePaid, async (req, res) => {
    const userId = req.session.user.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM cgpa_courses  WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM cgpa_profiles WHERE user_id = $1', [userId]);
        await client.query('COMMIT');
        res.redirect('/cgpa?msg=Profile reset. Start fresh!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('CGPA Reset Error:', err);
        res.redirect('/cgpa?msg=Reset failed.');
    } finally {
        client.release();
    }
});

app.get('/cgpa/api/data', isAuth, requirePaid, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const profileRes = await pool.query('SELECT * FROM cgpa_profiles WHERE user_id = $1', [userId]);
        const coursesRes = await pool.query('SELECT * FROM cgpa_courses  WHERE user_id = $1 ORDER BY level_scope, semester, created_at', [userId]);

        const profile = profileRes.rows[0];
        if (!profile) return res.json({ hasProfile: false });

        const stats = buildCGPA(profile, coursesRes.rows);
        res.json({ hasProfile: true, profile, courses: coursesRes.rows, stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load data.' });
    }
});

app.get('/api/heartbeat', (req, res) => {
    // Simply touching this route auto-renews your cookie expiration time via rolling: true
    res.status(200).json({ status: 'alive' });
});

const sendNotificationEmail = async (toEmail, subject, htmlContent) => {
    try {
        if (!toEmail) return;
        const mailOptions = {
            from: `"Prepium" <${process.env.EMAIL_USER}>`,
            to: toEmail,
            subject: subject,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #f1f5f9; border-radius: 16px;">
                    <div style="color: #0062ff; font-size: 24px; font-weight: 800; margin-bottom: 20px;">Prepium</div>
                    <div style="color: #0b1437; font-size: 16px; line-height: 1.6;">${htmlContent}</div>
                    <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 20px 0;">
                    <p style="color: #64748b; font-size: 12px;">Automated Workspace Notification.</p>
                </div>`
        };
        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.error("Mail worker failed:", error.message);
    }
};



// ==========================================
// DEADLINE EMAIL NOTIFICATION SYSTEM
// ==========================================

// Track which deadlines we've already notified about (in-memory, resets on restart)
const notifiedDeadlines = new Set();

async function checkDeadlineNotifications() {
    try {
        // 1. Find deadlines approaching within 1 hour (and not yet notified)
        const upcoming = await pool.query(`
            SELECT d.id, d.title, 
                   TO_CHAR(d.due_date, 'YYYY-MM-DD') as date_str,
                   TO_CHAR(d.due_time, 'HH24:MI') as time_str,
                   u.email, u.fullname
            FROM deadlines d
            JOIN users u ON d.user_id = u.id
            WHERE (d.due_date + d.due_time) > NOW()
            AND (d.due_date + d.due_time) <= NOW() + INTERVAL '1 hour'
            AND (d.id = ANY($1::int[])) = FALSE
        `, [notifiedDeadlines.size > 0 ? Array.from(notifiedDeadlines) : [0]]);

        for (const dl of upcoming.rows) {
            const dueDateTime = new Date(dl.date_str + 'T' + dl.time_str);
            const timeLeft = Math.ceil((dueDateTime - new Date()) / 60000);

            await sendNotificationEmail(
                dl.email,
                `⏰ Deadline Approaching: ${dl.title}`,
                `<p>Hi ${dl.fullname},</p>
                 <p>Your deadline <b>"${dl.title}"</b> is due in <b>${timeLeft} minutes</b>.</p>
                 <p>Due: ${dl.date_str} at ${dl.time_str}</p>
                 <p>Stay focused and finish strong!</p>`
            );
            notifiedDeadlines.add(dl.id);
            console.log(`[DEADLINE ALERT] Sent 1-hour warning for "${dl.title}" to ${dl.email}`);
        }

        // 2. Find deadlines that just expired (within last 5 minutes) and mark as notified
        const expired = await pool.query(`
            SELECT d.id, d.title, 
                   TO_CHAR(d.due_date, 'YYYY-MM-DD') as date_str,
                   TO_CHAR(d.due_time, 'HH24:MI') as time_str,
                   u.email, u.fullname
            FROM deadlines d
            JOIN users u ON d.user_id = u.id
            WHERE (d.due_date + d.due_time) <= NOW()
            AND (d.due_date + d.due_time) > NOW() - INTERVAL '5 minutes'
            AND (d.id = ANY($1::int[])) = FALSE
        `, [notifiedDeadlines.size > 0 ? Array.from(notifiedDeadlines) : [0]]);

        for (const dl of expired.rows) {
            await sendNotificationEmail(
                dl.email,
                `🚨 Deadline Reached: ${dl.title}`,
                `<p>Hi ${dl.fullname},</p>
                 <p>Your deadline <b>"${dl.title}"</b> has <b>just passed</b>.</p>
                 <p>Due: ${dl.date_str} at ${dl.time_str}</p>
                 <p>If you haven't completed it yet, consider updating your tracker with a new target.</p>`
            );
            notifiedDeadlines.add(dl.id);
            console.log(`[DEADLINE ALERT] Sent expiry notification for "${dl.title}" to ${dl.email}`);
        }

        // Clean up old IDs from the set (older than 7 days) to prevent memory growth
        if (notifiedDeadlines.size > 1000) {
            notifiedDeadlines.clear();
        }

    } catch (err) {
        console.error("[DEADLINE CHECKER ERROR]:", err.message);
    }
}

// Run the deadline checker every 5 minutes
setInterval(checkDeadlineNotifications, 5 * 60 * 1000);
// Also run once on startup (after a short delay to let the server fully start)
setTimeout(checkDeadlineNotifications, 10000);

// ─── WEEKLY LEADERBOARD RESET ───────────────────────────────────────────────
function getWeekKey(d) {
    const tmp = new Date(d);
    tmp.setHours(0,0,0,0);
    tmp.setDate(tmp.getDate() - tmp.getDay());
    return tmp.getFullYear() + '-W' + String(Math.ceil((tmp.getDate() + 1) / 7)).padStart(2, '0');
}
async function resetWeeklyLeaderboard() {
    try {
        const now = new Date();
        const currentWeek = getWeekKey(now);
        const r = await pool.query("SELECT value FROM app_config WHERE key = 'last_leaderboard_week'");
        const lastWeek = r.rows[0]?.value;
        if (lastWeek === currentWeek) return;
        await pool.query('DELETE FROM daily_leaderboard');
        await pool.query(
            "INSERT INTO app_config (key, value) VALUES ('last_leaderboard_week', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
            [currentWeek]
        );
        console.log('[Leaderboard] Reset for week', currentWeek);
    } catch (e) {
        console.error('[Leaderboard] Reset error:', e.message);
    }
}
// Check every 30 minutes
setInterval(resetWeeklyLeaderboard, 30 * 60 * 1000);
setTimeout(resetWeeklyLeaderboard, 5000);

// ======================== STUDY HUB ROUTES ========================

// Study AI helper — uses OpenRouter
function cleanAiText(t) {
  if (t == null) return '';
  var s = String(t);
  s = s.replace(/```[a-zA-Z]*\n?/g, '```');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1$2');
  s = s.replace(/(^|[^_])_(?!_)([^_\n]+?)_(?!_)/g, '$1$2');
  s = s.replace(/`+([^`\n]+?)`+/g, function(m, inner){ if(inner.indexOf('\\(') >= 0 || inner.indexOf('\\[') >= 0) return ''+inner+''; return inner; });
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '\u2022 ');
  s = s.replace(/^\s*(\d+)\.\s+/gm, '$1) ');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function cleanLatex(t) {
  if (t == null) return '';
  var s = String(t);
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, '\\[$1\\]');
  s = s.replace(/\$([^\$]*?)\$/g, '\\\($1\\\)');
  return s;
}

const CEREBRAS_MODELS = ['llama-3.3-70b', 'llama-3.1-70b'];
const GROQ_FAST = ['llama-3.1-8b-instant'];
const GROQ_SMART = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

async function cerebrasPrompt(prompt, jsonMode, maxTokens, noClean) {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) return { text: '', provider: 'cerebras-no-key' };
  maxTokens = maxTokens || 4000;
  for (const model of CEREBRAS_MODELS) {
    try {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: jsonMode ? 0.15 : 0.25,
        max_tokens: maxTokens,
        stream: false,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
      };
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      if (raw) return { text: jsonMode ? raw : (noClean ? raw : cleanLatex(raw)), provider: 'cerebras:' + model };
    } catch (_) { continue; }
  }
  return { text: '', provider: 'cerebras-failed' };
}

async function groqPrompt(prompt, jsonMode, smart, maxTokens, noClean) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { text: '', provider: 'groq-no-key' };
  const list = smart ? GROQ_SMART : GROQ_FAST;
  maxTokens = maxTokens || 4000;
  for (const model of list) {
    try {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: jsonMode ? 0.15 : 0.3,
        max_tokens: maxTokens,
        stream: false,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
      };
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      if (raw) return { text: jsonMode ? raw : (noClean ? raw : cleanLatex(raw)), provider: 'groq:' + model };
    } catch (_) { continue; }
  }
  return { text: '', provider: 'groq-failed' };
}

async function groqStream(prompt, onChunk) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return false;
  for (const model of GROQ_FAST) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          stream: true
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') return true;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content || '';
            if (delta) onChunk(delta);
          } catch (_) { continue; }
        }
      }
      return true;
    } catch (_) { continue; }
  }
  return false;
}

async function openRouterPrompt(prompt, jsonMode, maxTokens, noClean) {
  maxTokens = maxTokens || 4000;
  noClean = noClean || false;
  const fast = await groqPrompt(prompt, jsonMode, false, maxTokens, noClean);
  if (fast.text) return { text: fast.text, provider: fast.provider };
  const big = await cerebrasPrompt(prompt, jsonMode, maxTokens, noClean);
  if (big.text) return { text: big.text, provider: big.provider };
  const smart = await groqPrompt(prompt, jsonMode, true, maxTokens, noClean);
  if (smart.text) return { text: smart.text, provider: smart.provider };
  const orKey = process.env.OPENROUTER_API_KEY;
  const OR_MODELS = ['google/gemma-3-27b-it:free', 'mistralai/mistral-7b-instruct:free', 'google/gemini-2.0-flash-lite-preview-02-05:free'];
  if (orKey) {
    for (const model of OR_MODELS) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}`, 'HTTP-Referer': 'https://theprepium.vercel.app', 'X-Title': 'Prepium' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(30000)
        });
        if (res.ok) {
          const data = await res.json();
          const raw = data.choices?.[0]?.message?.content;
          if (raw) return { text: jsonMode ? raw : (noClean ? raw : cleanLatex(raw)), provider: 'openrouter:' + model };
        }
      } catch (_) { continue; }
    }
  }
  return { text: 'AI error: all providers failed', provider: 'none' };
}

async function studyPromptAI(prompt) { return openRouterPrompt(prompt, false, 4000, false); }

function extractJsonItems(text) {
  if (!text) return '';
  const stripped = String(text).replace(/```json|```/g, '').trim();
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      if (Array.isArray(obj)) return JSON.stringify(obj);
      if (Array.isArray(obj.items)) return JSON.stringify(obj.items);
      if (Array.isArray(obj.questions)) return JSON.stringify(obj.questions);
      if (Array.isArray(obj.quiz)) return JSON.stringify(obj.quiz);
      if (Array.isArray(obj.cards)) return JSON.stringify(obj.cards);
      if (Array.isArray(obj.flashcards)) return JSON.stringify(obj.flashcards);
      if (Array.isArray(obj.subtopics)) return JSON.stringify(obj.subtopics);
      if (Array.isArray(obj.courses)) return JSON.stringify(obj.courses);
      if (Array.isArray(obj.terms)) return JSON.stringify(obj.terms);
    } catch (_) {}
  }
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) return arrMatch[0];
  return stripped;
}

async function studyPromptJSON(prompt) {
  const wrapped = `${prompt.trim()}\n\nIMPORTANT: Return ONLY a single JSON object of the form { "items": [...the data array...] } Do not wrap in markdown. No prose outside JSON.`;
  const res = await openRouterPrompt(wrapped, true);
  if (res.text && !res.text.startsWith('AI error')) return res;
  const fallback = await openRouterPrompt(wrapped, false);
  if (fallback.text && !fallback.text.startsWith('AI error')) {
    const extracted = extractJsonItems(fallback.text);
    if (extracted) return { text: extracted, provider: 'extracted' };
  }
  const gemini = await callGeminiWithText(wrapped, '');
  if (gemini.success && gemini.text) {
    const extracted = extractJsonItems(gemini.text);
    if (extracted) return { text: extracted, provider: 'gemini-json' };
  }
  return res;
}

async function studyPromptSmart(prompt, opts) {
  opts = opts || {};
  const maxTokens = opts.maxTokens || 8000;
  const noClean = opts.noClean === true;
  const cere = await cerebrasPrompt(prompt, false, maxTokens, noClean);
  if (cere.text) return cere;
  const smart = await groqPrompt(prompt, false, true, maxTokens, noClean);
  if (smart.text) return smart;
  const or = await openRouterPrompt(prompt, false, maxTokens, noClean);
  if (or.text && !or.text.startsWith('AI error')) return or;
  const gemini = await callGeminiWithText(prompt, '', maxTokens);
  if (gemini.success && gemini.text) return { text: gemini.text, provider: 'gemini' };
  return { text: 'AI error: all providers could not generate this content. Please try again in a moment.', provider: 'none' };
}

async function studyPromptFast(prompt) {
  const fast = await groqPrompt(prompt, false, false);
  if (fast.text) return fast;
  const cere = await cerebrasPrompt(prompt, false);
  if (cere.text) return cere;
  return openRouterPrompt(prompt, false);
}

// Ensure study tables exist
(async function initStudyDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS study_courses (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_name VARCHAR(255) NOT NULL, course_code VARCHAR(50) DEFAULT '', unit INTEGER DEFAULT 3, source VARCHAR(20) DEFAULT 'manual', created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_topics (id SERIAL PRIMARY KEY, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL, topic_name VARCHAR(500) NOT NULL, title VARCHAR(500), completed BOOLEAN DEFAULT false, order_index INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_subtopics (id SERIAL PRIMARY KEY, topic_id INTEGER NOT NULL, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL, subtopic_name VARCHAR(500) NOT NULL, title VARCHAR(500), status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, course_name VARCHAR(255) DEFAULT '', elapsed_seconds INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'active', notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_progress (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, course_name VARCHAR(255) NOT NULL, total_sessions INTEGER DEFAULT 0, total_minutes INTEGER DEFAULT 0, last_studied TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_chat_messages (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, role VARCHAR(20) DEFAULT 'user', message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_flashcards (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, front TEXT NOT NULL, back TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_quiz_attempts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, question_type VARCHAR(50) DEFAULT 'multiple_choice', question_count INTEGER DEFAULT 10, time_limit INTEGER DEFAULT 0, score INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'in_progress', created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_quiz_questions (id SERIAL PRIMARY KEY, attempt_id INTEGER NOT NULL, question TEXT NOT NULL, options JSONB, correct_answer TEXT, user_answer TEXT, is_correct BOOLEAN, explanation TEXT, order_index INTEGER DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_youtube_videos (id SERIAL PRIMARY KEY, user_id INTEGER DEFAULT 0, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, title VARCHAR(500) DEFAULT '', url TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW())`);
    // Compatibility: make sure optional columns exist on legacy tables
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
      ['study_flashcards', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'created_at', 'TIMESTAMP DEFAULT NOW()'],
      ['study_chat_messages', 'subtopic_id', 'INTEGER DEFAULT 0'],
    ];
    for (const [t, c, d] of adds) { try { await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${d}`); } catch(_){} }
    try { await pool.query(`UPDATE study_quiz_attempts SET created_at = NOW() WHERE created_at IS NULL`); } catch(_){}
    // Backfill legacy title -> topic_name, keep title populated too
    await pool.query(`UPDATE study_topics SET topic_name = COALESCE(topic_name, title) WHERE topic_name IS NULL OR topic_name = ''`).catch(()=>{});
    await pool.query(`UPDATE study_topics SET title = COALESCE(title, topic_name) WHERE title IS NULL OR title = ''`).catch(()=>{});
    await pool.query(`UPDATE study_subtopics SET subtopic_name = COALESCE(subtopic_name, title) WHERE subtopic_name IS NULL OR subtopic_name = ''`).catch(()=>{});
    await pool.query(`UPDATE study_subtopics SET title = COALESCE(title, subtopic_name) WHERE title IS NULL OR title = ''`).catch(()=>{});
    // Loosen legacy NOT NULL constraint on title if it was kept from older schema
    try { await pool.query(`ALTER TABLE study_topics ALTER COLUMN title DROP NOT NULL`); } catch(_) {}
    try { await pool.query(`ALTER TABLE study_subtopics ALTER COLUMN title DROP NOT NULL`); } catch(_) {}
    try { await pool.query(`ALTER TABLE study_progress ADD CONSTRAINT study_progress_user_course UNIQUE (user_id, course_name)`); } catch(e) {}
    console.log('[Study] Tables ready');
  } catch(e) { console.error('[Study] Table init:', e.message); }
})();

// ==================== DB MANAGER ====================
const DB_PIN = process.env.DB_MANAGER_PIN || '1030';
const DB_PASS = process.env.DB_MANAGER_PASS || 'prepiumdb';

app.get('/admin/db-manager', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = result.rows.map(r => r.table_name);
    res.render('admin/db-manager', { tables, msg: req.query.msg || null, user: req.session.user });
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.post('/admin/db-manager/verify-pin', isAdmin, async (req, res) => {
  const { pin, password } = req.body;
  if (pin === DB_PIN && (!password || password === DB_PASS)) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.get('/admin/db-manager/data/:table', isAdmin, async (req, res) => {
  try {
    const table = req.params.table.replace(/[^a-zA-Z0-9_]/g, '');
    const result = await pool.query(`SELECT * FROM "${table}" LIMIT 200`);
    const columns = result.fields.map(f => f.name);
    res.json({ success: true, rows: result.rows, columns });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/db-manager/update', isAdmin, async (req, res) => {
  try {
    const { table, columns, row, pkCol, pkVal } = req.body;
    const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '');
    const sets = columns.filter(c => c !== pkCol).map((c, i) => `"${c}" = $${i + 1}`);
    const vals = columns.filter(c => c !== pkCol).map(c => row[c] === '' ? null : row[c]);
    vals.push(pkVal);
    const idx = sets.length + 1;
    await pool.query(`UPDATE "${safeTable}" SET ${sets.join(', ')} WHERE "${pkCol}" = $${idx}`, vals);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/db-manager/query', isAdmin, async (req, res) => {
  try {
    const { sql } = req.body;
    const lower = sql.trim().toLowerCase();
    if (!/^\s*(select|show|describe|explain)\b/i.test(sql)) {
      return res.status(400).json({ success: false, error: 'Only SELECT queries allowed' });
    }
    const result = await pool.query(sql);
    const columns = result.fields ? result.fields.map(f => f.name) : [];
    res.json({ success: true, rows: result.rows, columns });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY DASHBOARD ====================
app.get('/study', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [coursesRes, progressRes, sessionsRes, activeRes, streakRes, todayRes] = await Promise.all([
      pool.query('SELECT * FROM study_courses WHERE user_id = $1 ORDER BY course_name ASC', [uid]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 ORDER BY last_studied DESC', [uid]),
      pool.query("SELECT * FROM study_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10", [uid]),
      pool.query("SELECT * FROM study_sessions WHERE user_id = $1 AND status = 'active' LIMIT 1", [uid]),
      pool.query('SELECT current_streak FROM login_streaks WHERE user_id = $1', [uid]),
      pool.query("SELECT COUNT(*) as today_sessions, COALESCE(SUM(elapsed_seconds), 0) as today_seconds FROM study_sessions WHERE user_id = $1 AND status = 'completed' AND session_date = CURRENT_DATE", [uid])
    ]);
    const activeSession = activeRes.rows[0] || null;
    const streak = parseInt(streakRes.rows[0]?.current_streak) || 0;
    const todayStats = { sessions: parseInt(todayRes.rows[0]?.today_sessions) || 0, seconds: parseInt(todayRes.rows[0]?.today_seconds) || 0 };
    res.locals.seo.title = 'Prepium | Study Dashboard';
    res.locals.seo.description = 'Your personalized study dashboard — track courses, sessions, streaks, and progress with AI-powered learning tools on Prepium.';
    res.render('study', { user: req.session.user, courses: coursesRes.rows, progress: progressRes.rows, recentSessions: sessionsRes.rows, activeSession, streak, todayStats, subjects: [] });
  } catch (err) { console.error(err); res.status(500).send('Error loading study page'); }
});

// Course Detail
app.get('/study/course/:id', isAuth, requirePaid, async (req, res) => {
  try {
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (!course.rows[0]) return res.status(404).send('Course not found');
    const [topicsRes, subtopicsRes, progressRes] = await Promise.all([
      pool.query('SELECT * FROM study_topics WHERE course_id = $1 ORDER BY order_index ASC', [req.params.id]),
      pool.query('SELECT * FROM study_subtopics WHERE course_id = $1 ORDER BY topic_id, id ASC', [req.params.id]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 AND course_id = $2', [req.session.user.id, req.params.id])
    ]);
    const topics = topicsRes.rows.map(t => { t.subtopics = subtopicsRes.rows.filter(s => s.topic_id === t.id); return t; });
    res.locals.seo.title = 'Prepium | ' + (course.rows[0]?.course_name || 'Course');
    res.locals.seo.description = 'Study ' + (course.rows[0]?.course_name || 'this course') + ' with AI-powered explanations, flashcards, quizzes, and progress tracking on Prepium.';
    res.render('study-course', { user: req.session.user, course: course.rows[0], topics, progress: progressRes.rows[0] || null });
  } catch (err) { console.error(err); res.status(500).send('Error loading course'); }
});

// Study Session
app.get('/study/session/:id', isAuth, requirePaid, async (req, res) => {
  try {
    const sess = await pool.query('SELECT * FROM study_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (!sess.rows[0]) return res.status(404).send('Session not found');
    res.render('study-session', { user: req.session.user, session: sess.rows[0] });
  } catch (err) { console.error(err); res.status(500).send('Error loading session'); }
});

// Quiz Attempt
app.get('/study/quiz/:attemptId', isAuth, requirePaid, async (req, res) => {
  try {
    const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1 AND user_id = $2', [req.params.attemptId, req.session.user.id]);
    if (!attempt.rows[0]) return res.status(404).send('Quiz not found');
    let questions = (await pool.query('SELECT id, question, options, order_index FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC', [req.params.attemptId])).rows;
    questions = questions.map(function(q) {
      q.question = cleanLatex(q.question);
      if (q.options && Array.isArray(q.options)) q.options = q.options.map(function(o) { return cleanLatex(o).replace(/^[A-Da-d1-4][\.\)]\s*/, ''); });
      return q;
    });
    res.render('study-quiz', { user: req.session.user, attempt: attempt.rows[0], questions: questions });
  } catch (err) { res.status(500).send('Error loading quiz'); }
});

// Flashcards Page
app.get('/study/flashcards/:courseId', isAuth, requirePaid, async (req, res) => {
  try {
    const course = await pool.query('SELECT course_name FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.courseId, req.session.user.id]).catch(() => ({ rows: [{ course_name: '' }] }));
    res.render('study-flashcards', { user: req.session.user, courseId: parseInt(req.params.courseId), courseName: course.rows[0]?.course_name || '' });
  } catch (err) { res.status(500).send('Error loading flashcards'); }
});

// Subtopic Page
app.get('/study/subtopic/:id', isAuth, requirePaid, async (req, res) => {
  try {
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (!st.rows[0]) return res.status(404).send('Subtopic not found');
    const s = st.rows[0];
    if (s.content) s.content = cleanAiText(s.content);
    const topic = await pool.query('SELECT * FROM study_topics WHERE id = $1', [s.topic_id]).catch(() => ({ rows: [] }));
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [s.course_id || 0]).catch(() => ({ rows: [] }));
    const topicSubtopics = await pool.query('SELECT id, status FROM study_subtopics WHERE topic_id = $1', [s.topic_id]).catch(() => ({ rows: [] }));
    const subName = s.subtopic_name || s.title || 'Subtopic';
    const topicName = (topic.rows[0]?.topic_name || topic.rows[0]?.title || '');
    const courseName = (course.rows[0]?.course_name || '');
    res.locals.seo = { ...res.locals.seo, title: 'Prepium | ' + subName, description: 'Study ' + subName + (topicName ? ' as part of ' + topicName : '') + (courseName ? ' in ' + courseName : '') + ' with AI-powered explanations and quizzes on Prepium.' };
    res.render('study-subtopic', { user: req.session.user, subtopic: s, topic: topic.rows[0] || null, course: course.rows[0] || null, topicSubtopics: topicSubtopics.rows });
  } catch (err) { console.error(err); res.status(500).send('Error loading subtopic'); }
});

// ==================== STUDY API: IMPORT ====================
app.post('/api/study/import-timetable', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const tt = await pool.query('SELECT DISTINCT course, course_code, unit FROM timetables WHERE user_id = $1', [uid]);
    let count = 0;
    for (const row of tt.rows) {
      const exists = await pool.query('SELECT id FROM study_courses WHERE user_id = $1 AND course_name = $2', [uid, row.course]);
      if (!exists.rows[0]) { await pool.query('INSERT INTO study_courses (user_id, course_name, course_code, unit, source) VALUES ($1, $2, $3, $4, $5)', [uid, row.course, row.course_code || '', row.unit || 3, 'timetable']); count++; }
    }
    res.json({ success: true, imported: count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: COURSES ====================
app.post('/api/study/courses/add', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseName, courseCode, unit } = req.body;
    const r = await pool.query('INSERT INTO study_courses (user_id, course_name, course_code, unit) VALUES ($1, $2, $3, $4) RETURNING *', [req.session.user.id, courseName, courseCode || '', unit || 3]);
    res.json({ success: true, course: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/courses/delete/:id', isAuth, requirePaid, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    await pool.query('DELETE FROM study_topics WHERE course_id = $1', [req.params.id]);
    await pool.query('DELETE FROM study_subtopics WHERE course_id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/study/courses', isAuth, async (req, res) => {
  try {
    const courses = await pool.query('SELECT * FROM study_courses WHERE user_id = $1 ORDER BY course_name ASC', [req.session.user.id]);
    res.json({ courses: courses.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== STUDY API: TOPICS ====================
app.post('/api/study/topics/add', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, title } = req.body;
    const name = (title || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Topic name required' });
    const max = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 as n FROM study_topics WHERE course_id = $1::integer', [courseId]);
    const r = await pool.query('INSERT INTO study_topics (course_id, user_id, title, topic_name, order_index) VALUES ($1::integer, $2::integer, $3::text, $3::text, $4::integer) RETURNING *', [courseId, req.session.user.id, name, max.rows[0].n]);
    res.json({ success: true, topic: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/topics/delete/:id', isAuth, requirePaid, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_subtopics WHERE topic_id = $1', [req.params.id]);
    await pool.query('DELETE FROM study_topics WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/study/topics/:courseId', isAuth, async (req, res) => {
  try {
    const topics = await pool.query('SELECT t.*, (SELECT COUNT(*) FROM study_subtopics WHERE topic_id = t.id) as subtopic_count FROM study_topics t WHERE t.course_id = $1 ORDER BY t.order_index ASC', [req.params.courseId]);
    const subtopics = await pool.query('SELECT * FROM study_subtopics WHERE course_id = $1 ORDER BY topic_id, id ASC', [req.params.courseId]);
    res.json({ topics: topics.rows, subtopics: subtopics.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== STUDY API: SUBTOPICS ====================
app.post('/api/study/subtopics/ai-generate', isAuth, requirePaid, async (req, res) => {
  try {
    const { topicId, courseId, topicTitle, courseName, courseCode } = req.body;
    const prompt = `For the topic "${topicTitle}" in the course "${courseName}", generate a comprehensive list of subtopics that cover every aspect of this topic that should be studied. Include foundational concepts first, then more advanced aspects. Be thorough — break the topic down into its natural parts. Return a JSON array of strings. Do NOT wrap in markdown code blocks. ONLY output raw JSON.`;
    const aiRes = await studyPromptJSON(prompt);
    if (aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text });
    let subtopics = [];
    try {
      var txt = aiRes.text.trim();
      var m = txt.match(/\[[\s\S]*\]/);
      if (m) txt = m[0];
      subtopics = JSON.parse(txt);
    } catch {
      try {
        var cleaned = aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim();
        var m2 = cleaned.match(/\[[\s\S]*\]/);
        if (m2) cleaned = m2[0];
        subtopics = JSON.parse(cleaned);
      } catch { subtopics = aiRes.text.split('\n').filter(function(l){ return l.trim().match(/^["\w]/); }).map(function(l){ return l.replace(/^[\d.-\s"']+|["'\s]+$/g, ''); }).filter(Boolean); }
    }
    const uid = req.session.user.id;
    const results = [];
    for (const st of subtopics.slice(0, 25)) {
      const cleanName = st.replace(/^["'\s]+|["'\s]+$/g, '').trim();
      if (!cleanName) continue;
      const r = await pool.query('INSERT INTO study_subtopics (topic_id, course_id, user_id, subtopic_name, title, status) VALUES ($1::integer, $2::integer, $3::integer, $4::text, $5::text, $6::text) RETURNING *', [parseInt(topicId) || 0, parseInt(courseId) || 0, parseInt(uid) || 0, cleanName, cleanName, 'pending']);
      results.push(r.rows[0]);
    }
    res.json({ success: true, subtopics: results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/subtopics/update', isAuth, requirePaid, async (req, res) => {
  try {
    const { id, title, status } = req.body;
    await pool.query('UPDATE study_subtopics SET title = COALESCE($1, title), subtopic_name = COALESCE($1, subtopic_name), status = COALESCE($2, status) WHERE id = $3', [title, status, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/subtopics/delete/:id', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('DELETE FROM study_subtopics WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/study/subtopic/topic-progress', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const { topicId, subtopicId } = req.query;
    if (!topicId && !subtopicId) return res.json({ subtopics: [] });
    if (topicId) {
      const r = await pool.query('SELECT id, status FROM study_subtopics WHERE topic_id = $1 AND user_id = $2', [parseInt(topicId), uid]);
      return res.json({ subtopics: r.rows });
    }
    const st = await pool.query('SELECT topic_id FROM study_subtopics WHERE id = $1 AND user_id = $2', [parseInt(subtopicId), uid]);
    if (!st.rows[0]) return res.json({ subtopics: [] });
    const r = await pool.query('SELECT id, status FROM study_subtopics WHERE topic_id = $1 AND user_id = $2', [st.rows[0].topic_id, uid]);
    res.json({ subtopics: r.rows });
  } catch (err) { res.json({ subtopics: [] }); }
});

app.get('/api/study/subtopic/:id', isAuth, async (req, res) => {
  try {
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (!st.rows[0]) return res.status(404).json({ error: 'Not found' });
    const videos = await pool.query('SELECT * FROM study_youtube_videos WHERE subtopic_id = $1 ORDER BY created_at DESC LIMIT 5', [req.params.id]);
    const flashcards = await pool.query('SELECT * FROM study_flashcards WHERE subtopic_id = $1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    res.json({ subtopic: st.rows[0], videos: videos.rows, flashcards: flashcards.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/study/subtopic/:id/content', isAuth, requirePaid, async (req, res) => {
  try {
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (!st.rows[0]) return res.json({ success: false, error: 'Not found' });
    const s = st.rows[0];
    const topic = await pool.query('SELECT * FROM study_topics WHERE id = $1', [s.topic_id]).catch(() => ({ rows: [] }));
    const topicName = topic.rows[0] ? (topic.rows[0].topic_name || topic.rows[0].title) : 'General';
    const prompt = `You are an expert university professor giving a complete, in-depth lecture on "${s.subtopic_name || s.title}" (part of "${topicName}"). Your goal is to make the learner truly master this topic — full understanding, not surface memorization. Write extensively, with rich detail, explicit explanations, and thorough reasoning in every section.

Structure your response using EXACTLY these section headers (each on its own line ending with a colon). Use PLAIN TEXT with LaTeX math. For ALL mathematical expressions, formulas, equations, symbols, and variables — ALWAYS use proper LaTeX notation:
- Use \\( \\) for inline math like variables (x, y, derivatives), short formulas, and expressions within sentences.
- Use \\[ \\] for display math — standalone equations, multi-step derivations, system of equations, integrals, limits, summations.
- Always wrap mathematical variables in math mode: \\(x\\), \\(\\frac{dy}{dx}\\), \\(\\int_a^b f(x)\\,dx\\), \\(\\sum_{n=1}^{\\infty}\\), \\(\\lim_{x \\to 0}\\), \\(\\pi\\), \\(\\theta\\), \\(\\alpha\\), \\(\\beta\\).
- Use proper LaTeX for fractions \\(\\frac{numerator}{denominator}\\), exponents \\(x^{n}\\), subscripts \\(x_{i}\\), square roots \\(\\sqrt{x}\\), and integrals \\(\\int_{a}^{b}\\).
- NEVER write mathematical notation in plain text (e.g., write \\(x^2 + y^2 = 25\\) not "x^2 + y^2 = 25").
- For step-by-step calculations, use \\[ \\] display blocks so equations are clearly separated.

No markdown, no asterisks for bold, no hashtags, no backticks. Separate paragraphs with blank lines. You can include a simple Mermaid diagram (flowchart, sequence, or mindmap) by wrapping it in a code block with the word "mermaid" after the opening backticks — this is optional, use only where it clarifies relationships or processes.

What You Should Know:
Connect this topic to prerequisite concepts the learner should already know. Explain each prerequisite in detail — what it means, why it matters, and exactly how it connects to this new topic. Use mathematical notation where relevant. 5-8 sentences. If none, just say "No specific prerequisites."

Why It Matters:
Explain thoroughly what real problem this concept solves, the historical or practical motivation behind it, and how it appears in real-world or academic contexts. Give at least 2-3 concrete real-life or professional applications with details — include formulas or mathematical relationships involved. 5-8 sentences.

Plain Explanation:
Explain the concept in plain, everyday language first — as if talking to someone with no background. Use a vivid real-life analogy or story to introduce the concept. Then give the formal definition or statement with full interpretation of every symbol, variable, and operation. Break it into small, digestible sub-parts and explain each one. Use multiple analogies if they genuinely help. Define any new terminology used in the definition. Include ALL relevant mathematical formulas using proper LaTeX display math. Make this section thorough and detailed — at least 8-12 sentences.

Key Terms:
Bullet each term on its own line starting with a dash. Format: "- term: short definition where any symbols or formulas use \\( \\)". Cover every term the learner needs to know for full mastery — not just obvious ones. Include variables, operations, and notation as terms with proper LaTeX. Keep definitions concise but precise.

Step-by-Step Examples:
2-3 fully worked examples of increasing difficulty. For each example: state the problem clearly using proper LaTeX notation, walk through EVERY step with explicit reasoning and ALL intermediate mathematical expressions in \\[ \\] display blocks — not just the answer. Explain WHY each step is done, what technique is being applied, and what the result means. Use realistic numbers and contexts. Show ALL algebraic manipulation, calculus operations, or derivations in proper LaTeX. State the final answer clearly inside \\[ \\] and verify it. Make each example thorough and pedagogical.

Common Mistakes:
Describe 2-3 common errors or misconceptions students make on this topic. For each: state the wrong approach explicitly with the INCORRECT mathematical reasoning shown using LaTeX, explain in detail WHY it is wrong and what misconception leads to it, then contrast with the correct approach showing the RIGHT mathematical reasoning in LaTeX. Use "Wrong:" and "Right:" labels. Be thorough — deeply explain the thinking behind the mistakes.

Edge Cases:
Mention any special cases, exceptions, degenerate situations, or scenarios where the concept behaves differently than expected. For each edge case: describe the situation, show what happens mathematically using LaTeX, and explain why. If there are common pitfalls at boundaries, explain those with proper notation. If none, say "No major edge cases for this topic."

Practice Questions:
Write 5-7 practice questions arranged from easy to challenging. Number them. Give ONLY the questions here — NO answers or solutions yet. ALL mathematical expressions in questions MUST use proper LaTeX notation. Vary the types: computational, conceptual, application-based, and edge-case reasoning. Write each question as a clear, complete sentence with all formulas in LaTeX.

Step-by-Step Solutions:
Give the full, detailed worked solutions to ALL practice questions above. For each solution: restate the problem briefly in LaTeX, show EVERY step with explicit reasoning in proper \\[ \\] display math blocks, explain the technique used, and state the final answer clearly inside \\[ \\]. Verify the answer where possible. Label each solution clearly (e.g., "Solution 1:", "Solution 2:"). Each solution should be thorough — cover all algebra, calculus, or reasoning steps.

CRITICAL FORMATTING RULES:
- Each section should be SUBSTANTIAL — minimum 8-12 lines of meaningful content where the topic warrants it.
- Use blank lines between sections and between paragraphs.
- Use proper line spacing.
- Be explicit and verbose — assume the reader needs every detail spelled out.
- Do NOT summarize or rush — thoroughness is more important than brevity.
- Every mathematical symbol, variable, equation, or formula MUST be inside \\( \\) or \\[ \\] — never plain text math.`;
    let aiRes = await studyPromptSmart(prompt, { maxTokens: 8000, noClean: true });
    if (!aiRes.text || aiRes.text.startsWith('AI error')) {
      const shortPrompt = `You are an expert professor giving an in-depth lecture on "${s.subtopic_name || s.title}" (part of "${topicName}"). Write a thorough, comprehensive explanation covering: prerequisites in detail, real-world importance with concrete applications, plain explanation with vivid analogies, key terms with definitions, fully worked step-by-step examples, common mistakes with explicit wrong/right contrasts, edge cases, and practice questions with full worked solutions. Use these section headers exactly: "What You Should Know:", "Why It Matters:", "Plain Explanation:", "Key Terms:", "Step-by-Step Examples:", "Common Mistakes:", "Edge Cases:", "Practice Questions:", "Step-by-Step Solutions:". Use plain text with LaTeX math \\( \\) and \\[ \\]. Include a Mermaid diagram in a mermaid code block if it helps clarify relationships. Be thorough, explicit, and detailed — minimum 6-10 lines per section. Do not summarize.`;
      aiRes = await studyPromptSmart(shortPrompt, { maxTokens: 8000, noClean: true });
    }
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    const clean = cleanAiText(aiRes.text);
    await pool.query('UPDATE study_subtopics SET content = $1 WHERE id = $2', [clean, req.params.id]);
    res.json({ success: true, subtopic: s.subtopic_name || s.title, content: clean });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: AI DIAGNOSTIC ====================
// ==================== STUDY API: EXPLANATION Q&A ====================
app.post('/api/study/subtopic/:id/ask', isAuth, requirePaid, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.json({ success: false, error: 'Question is required' });
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (!st.rows[0]) return res.json({ success: false, error: 'Not found' });
    const s = st.rows[0];
    const content = s.content || '';
    const prompt = `You are a university tutor. The student is studying "${s.subtopic_name || s.title}" and has just read the following explanation:\n\n"""\n${content.slice(0, 5000)}\n"""\n\nThe student now asks:\n"${question}"\n\nAnswer their question clearly and concisely, building on the explanation above. Use PLAIN TEXT only. If they ask for clarification, re-explain simply. If they ask something beyond the explanation, use your knowledge to help. Separate paragraphs with blank lines. Use LaTeX math delimiters \\( \\) for inline and \\[ \\] for display math when needed.`;
    const aiRes = await studyPromptFast(prompt);
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    res.json({ success: true, answer: cleanAiText(aiRes.text) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: SESSIONS ====================
app.post('/api/study/sessions/start', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, subtopicId, courseName, durationMinutes } = req.body;
    const r = await pool.query('INSERT INTO study_sessions (user_id, course_id, subtopic_id, course_name, duration_minutes, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [req.session.user.id, courseId || 0, subtopicId || 0, courseName || 'General Study', durationMinutes || 60, 'active']);
    res.json({ success: true, session: r.rows[0], redirect: '/study/session/' + r.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/sessions/end', isAuth, requirePaid, async (req, res) => {
  try {
    const { sessionId, elapsedSeconds, notes, summary } = req.body;
    const mergedNotes = (notes || '') + (summary ? (notes ? '\n\n--- Key points ---\n' + summary : summary) : '');
    await pool.query("UPDATE study_sessions SET status = 'completed', elapsed_seconds = $1, notes = $2, completed_at = NOW() WHERE id = $3 AND user_id = $4", [elapsedSeconds || 0, mergedNotes, sessionId, req.session.user.id]);
    const s = (await pool.query('SELECT * FROM study_sessions WHERE id = $1', [sessionId])).rows[0];
    if (s) {
      const mins = Math.ceil((elapsedSeconds || 0) / 60);
      await pool.query('INSERT INTO study_progress (user_id, course_id, course_name, total_sessions, total_minutes, last_studied) VALUES ($1, $2, $3, 1, $4, NOW()) ON CONFLICT (user_id, course_name) DO UPDATE SET total_sessions = study_progress.total_sessions + 1, total_minutes = study_progress.total_minutes + $4, last_studied = NOW()', [s.user_id, s.course_id, s.course_name, mins]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/session/summarize', isAuth, requirePaid, async (req, res) => {
  try {
    const { notes, courseName } = req.body;
    if (!notes || !notes.trim()) return res.json({ success: false, error: 'No notes to summarize.' });
    const ctx = courseName ? ` from a "${courseName}" study session` : '';
    const prompt = `Read these student study notes${ctx} and produce 3-6 short bullet points capturing the most important takeaways. Output PLAIN TEXT only. No markdown, no asterisks, no hashtags, no backticks. Each line should be a short key point. Lines separated by newline. Keep it concise (max 60 words total).\n\nNotes:\n"""${notes.slice(0, 4000)}"""\n\nKey points:`;
    const aiRes = await studyPromptFast(prompt);
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    res.json({ success: true, summary: cleanAiText(aiRes.text) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/sessions/update', isAuth, requirePaid, async (req, res) => {
  try {
    const { sessionId, elapsedSeconds, notes } = req.body;
    await pool.query('UPDATE study_sessions SET elapsed_seconds = $1, notes = COALESCE($2, notes) WHERE id = $3 AND user_id = $4', [elapsedSeconds || 0, notes || null, sessionId, req.session.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: AI CHAT (streaming SSE) ====================
app.post('/api/study/chat', isAuth, requirePaid, async (req, res) => {
  try {
    const { message, courseId, subtopicId, courseName } = req.body;
    const uid = req.session.user.id;
    const cleanUser = cleanAiText(message);
    await pool.query('INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, $2, $3, $4, $5)', [uid, courseId || 0, subtopicId || 0, 'user', cleanUser]);
    const ctx = courseName ? `Context: Student is studying "${courseName}". ` : '';
    const prompt = `${ctx}You are a helpful study assistant for university students. Answer the question in PLAIN TEXT. Use \\( \\) for inline LaTeX math and \\[ \\] for display math when formulas are needed. No markdown, no asterisks for bold, no hashtags, no backticks. Use short paragraphs separated by blank lines.\n\nStudent's question: ${cleanUser}\n\nProvide a thorough, educational response.`;
    let reply = '';
    const streamed = await groqStream(prompt, async function(delta) { reply += delta; });
    if (streamed) {
      reply = cleanAiText(reply);
    } else {
      const fallback = await studyPromptFast(prompt);
      if (!fallback.text || fallback.text.startsWith('AI error')) {
        return res.json({ success: false, error: fallback.text || 'AI error' });
      }
      reply = cleanAiText(fallback.text);
    }
    try {
      await pool.query('INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, $2, $3, $4, $5)', [uid, courseId || 0, subtopicId || 0, 'ai', reply]);
    } catch (e) { console.error('Chat message persist failed:', e.message); }
    res.json({ success: true, reply: reply });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/study/chat/history', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId } = req.query;
    let q = 'SELECT * FROM study_chat_messages WHERE user_id = $1';
    const p = [req.session.user.id];
    if (courseId) { q += ' AND course_id = $2'; p.push(parseInt(courseId)); }
    if (subtopicId) { q += ` AND subtopic_id = $${p.length + 1}`; p.push(parseInt(subtopicId)); }
    q += ' ORDER BY created_at ASC LIMIT 100';
    const r = await pool.query(q, p);
    const messages = r.rows.map(function(m) { m.message = cleanLatex(m.message); return m; });
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== STUDY API: YOUTUBE VIDEOS ====================
app.post('/api/study/youtube/search', isAuth, requirePaid, async (req, res) => {
  try {
    const { query: searchQuery, subtopicId, courseId } = req.body;
    const prompt = `Generate a list of 5 YouTube video search queries for studying the topic: "${searchQuery}". Return a JSON array of strings. Do NOT wrap in markdown code blocks. ONLY output raw JSON.`;
    const aiRes = await studyPromptJSON(prompt);
    let terms = [];
    try { terms = JSON.parse(aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim()); } catch { terms = [searchQuery]; }
    const html = terms.map(function(t) {
      const encoded = encodeURIComponent(t);
      return '<div class="yt-card" onclick="window.open(\'https://www.youtube.com/results?search_query=' + encoded + '\',\'_blank\')"><i class="fab fa-youtube" style="color:#ff0000;font-size:1.5rem;"></i><div><strong>' + t + '</strong><br><span style="font-size:0.75rem;color:var(--text-sub)">Click to search on YouTube</span></div></div>';
    }).join('');
    if (subtopicId && parseInt(subtopicId) > 0) {
      for (const t of terms.slice(0, 3)) { await pool.query('INSERT INTO study_youtube_videos (course_id, subtopic_id, title, url) VALUES ($1, $2, $3, $4)', [courseId || 0, subtopicId, t, 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t)]); }
    }
    res.json({ success: true, html, terms });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: QUIZ ====================
app.post('/api/study/quiz/generate', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, subtopicId, topicTitle, questionType, questionCount, timeLimit } = req.body;
    const count = parseInt(questionCount) || 10;
    const uid = req.session.user.id;
    var qType = questionType || 'multiple_choice';
    var typeGuide = qType === 'mixed' ? 'Mix of multiple choice (with 4 options) and theory questions (options: [])' : (qType === 'theory' ? 'All theory questions (options: [], correctAnswer is the expected answer)' : 'All multiple choice with 4 options each');
    var notes = '';
    if (subtopicId && parseInt(subtopicId) > 0) {
      const st = await pool.query('SELECT content FROM study_subtopics WHERE id = $1', [subtopicId]).catch(() => ({ rows: [] }));
      if (st.rows[0] && st.rows[0].content) notes = '\n\nStudy material for reference:\n' + String(st.rows[0].content).slice(0, 4000);
    }
    const prompt = `Generate ${count} ${typeGuide} about "${topicTitle || 'General Study'}" for university exam preparation. Use JSON key "question" for text, "options" array for choices (do NOT prefix options with A), "correctAnswer" must be the LETTER ONLY (e.g., "A", not the full text), "explanation" for explanation. Return a JSON array. Do NOT wrap in markdown. ONLY output raw JSON.${notes}`;
    const aiRes = await studyPromptJSON(prompt);
    let questions = [];
    try {
      var txt = aiRes.text.trim();
      var m = txt.match(/\[[\s\S]*\]/);
      if (m) txt = m[0];
      questions = JSON.parse(txt);
    } catch (e) {
      try {
        var cleaned = aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim();
        var m2 = cleaned.match(/\[[\s\S]*\]/);
        if (m2) cleaned = m2[0];
        questions = JSON.parse(cleaned);
      } catch { throw new Error('Failed to parse AI response. Please try again.'); }
    }
    // Normalize question keys and extract answer letter
    function cleanOptPrefix(o) {
      return String(o).replace(/^[A-Da-d1-4][\.\)]\s*/, '');
    }
    function answerLetter(val, options) {
      if (!val) return 'A';
      var s = String(val).trim();
      var m = s.match(/^([A-Da-d])[\.\)]\s*/);
      if (m) return m[1].toUpperCase();
      if (/^[A-Da-d]$/i.test(s)) return s.toUpperCase();
      var n = parseInt(s);
      if (!isNaN(n)) return String.fromCharCode(65 + (n >= 1 && n <= 4 ? n - 1 : n));
      if (Array.isArray(options)) {
        for (var i = 0; i < options.length; i++) {
          if (cleanOptPrefix(options[i]).toLowerCase() === s.toLowerCase() || options[i].toLowerCase() === s.toLowerCase()) return String.fromCharCode(65 + i);
        }
      }
      return 'A';
    }
    questions = questions.map(function(q) {
      var normQ = q.question || q.text || q.questionText || q.question_text || '';
      var normExp = q.explanation || q.exp || '';
      var raw = q.options || q.choices || [];
      var cleaned = Array.isArray(raw) ? raw.map(function(o) { return cleanLatex(cleanOptPrefix(o)); }) : [];
      return {
        question: cleanLatex(normQ),
        options: cleaned,
        correctAnswer: answerLetter(q.correctAnswer || q.correct || q.answer || '', cleaned),
        explanation: cleanLatex(normExp)
      };
    }).filter(function(q) { return q.question; });
    const attempt = await pool.query("INSERT INTO study_quiz_attempts (user_id, course_id, subtopic_id, question_type, question_count, time_limit, status) VALUES ($1, $2, $3, $4, $5, $6, 'in_progress') RETURNING *", [uid, courseId || 0, subtopicId || 0, questionType || 'multiple_choice', questions.length, timeLimit || 0]);
    const attemptId = attempt.rows[0].id;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await pool.query('INSERT INTO study_quiz_questions (attempt_id, question, options, correct_answer, explanation, order_index) VALUES ($1, $2, $3, $4, $5, $6)', [attemptId, q.question, JSON.stringify(q.options || []), q.correctAnswer, q.explanation || '', i]);
    }
    res.json({ success: true, attempt: attempt.rows[0], questions });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/quiz/submit', isAuth, requirePaid, async (req, res) => {
  try {
    const { attemptId, answers } = req.body;
    let score = 0;
    for (const a of answers) {
      const q = await pool.query('SELECT * FROM study_quiz_questions WHERE id = $1 AND attempt_id = $2', [a.questionId, attemptId]);
      if (q.rows[0]) {
        const isCorrect = String(a.answer).trim().toUpperCase() === String(q.rows[0].correct_answer).trim().toUpperCase();
        if (isCorrect) score++;
        await pool.query('UPDATE study_quiz_questions SET user_answer = $1, is_correct = $2 WHERE id = $3', [a.answer, isCorrect, a.questionId]);
      }
    }
    const total = (await pool.query('SELECT COUNT(*) as c FROM study_quiz_questions WHERE attempt_id = $1', [attemptId])).rows[0].c;
    await pool.query("UPDATE study_quiz_attempts SET score = $1, total_questions = $2, status = 'completed', completed_at = NOW() WHERE id = $3", [score, total, attemptId]);
    try {
      const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1', [attemptId]);
      if (attempt.rows[0] && attempt.rows[0].course_id > 0) {
        const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [attempt.rows[0].course_id]);
        if (course.rows[0]) { await pool.query("INSERT INTO study_progress (user_id, course_id, course_name, total_sessions, total_minutes, last_studied) VALUES ($1, $2, $3, 1, 5, NOW()) ON CONFLICT (user_id, course_name) DO UPDATE SET total_sessions = study_progress.total_sessions + 1, total_minutes = study_progress.total_minutes + 5, last_studied = NOW()", [attempt.rows[0].user_id, attempt.rows[0].course_id, course.rows[0].course_name]); }
      }
    } catch (e) { console.error('Quiz-study sync error:', e.message); }
    res.json({ success: true, score, total });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/study/quiz/result/:attemptId', isAuth, async (req, res) => {
  try {
    const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1 AND user_id = $2', [req.params.attemptId, req.session.user.id]);
    let questions = (await pool.query('SELECT * FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC', [req.params.attemptId])).rows;
    questions = questions.map(function(q) {
      q.question = cleanLatex(q.question);
      q.explanation = cleanLatex(q.explanation || '');
      q.correct_answer = cleanLatex(q.correct_answer || '');
      return q;
    });
    res.json({ attempt: attempt.rows[0], questions: questions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== STUDY API: FLASHCARDS ====================
app.post('/api/study/flashcards/generate', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, subtopicId, topicTitle, count } = req.body;
    const fcCount = parseInt(count) || 10;
    const uid = req.session.user.id;
    const prompt = `Generate ${fcCount} high-quality flashcards for studying "${topicTitle || 'this course'}". Each flashcard: front (a clear question, term, or concept prompt), back (a thorough answer, definition, or explanation — include a short example or mnemonic where helpful, 1-3 sentences). Make cards genuinely useful for learning — avoid trivial facts. Use LaTeX math where appropriate. Return a JSON array of objects with keys "front" and "back". Do NOT wrap in markdown code blocks. ONLY output raw JSON.`;
    const aiRes = await studyPromptJSON(prompt);
    let cards = [];
    try {
      var txt = aiRes.text.trim();
      var m = txt.match(/\[[\s\S]*\]/);
      if (m) txt = m[0];
      cards = JSON.parse(txt);
    } catch (e) {
      try {
        var cleaned = aiRes.text.replace(/```json/g, '').replace(/```/g, '').trim();
        var m2 = cleaned.match(/\[[\s\S]*\]/);
        if (m2) cleaned = m2[0];
        cards = JSON.parse(cleaned);
      } catch { throw new Error('Failed to generate flashcards'); }
    }
    for (const c of cards) {
      const front = cleanAiText(c.front);
      const back = cleanAiText(c.back);
      await pool.query('INSERT INTO study_flashcards (user_id, course_id, subtopic_id, front, back) VALUES ($1, $2, $3, $4, $5)', [uid, courseId || null, subtopicId || null, front, back]);
      c.front = front; c.back = back;
    }
    res.json({ success: true, count: cards.length, cards });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/study/flashcards', isAuth, async (req, res) => {
  try {
    const { courseId, subtopicId } = req.query;
    let q = 'SELECT * FROM study_flashcards WHERE user_id = $1';
    const p = [req.session.user.id];
    if (courseId) { q += ' AND course_id = $' + (p.length + 1); p.push(courseId); }
    if (subtopicId) { q += ' AND subtopic_id = $' + (p.length + 1); p.push(subtopicId); }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    const flashcards = r.rows.map(function(f) { f.front = cleanLatex(f.front); f.back = cleanLatex(f.back); return f; });
    res.json({ flashcards });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/study/flashcards/delete/:id', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('DELETE FROM study_flashcards WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/study/flashcards/delete-all', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, subtopicId } = req.body;
    const uid = req.session.user.id;
    let q = 'DELETE FROM study_flashcards WHERE user_id = $1';
    const p = [uid];
    if (subtopicId) { q += ' AND subtopic_id = $' + (p.length + 1); p.push(parseInt(subtopicId)); }
    else if (courseId) { q += ' AND course_id = $' + (p.length + 1); p.push(parseInt(courseId)); }
    const r = await pool.query(q, p);
    res.json({ success: true, deleted: r.rowCount });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== STUDY API: STATS & EXPORT ====================
app.get('/api/study/stats', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [ts, tm, ad, tc, fc] = await Promise.all([
      pool.query("SELECT COUNT(*) as c FROM study_sessions WHERE user_id = $1 AND status = 'completed'", [uid]),
      pool.query("SELECT COALESCE(SUM(elapsed_seconds), 0) as t FROM study_sessions WHERE user_id = $1 AND status = 'completed'", [uid]),
      pool.query("SELECT COUNT(DISTINCT session_date) as d FROM study_sessions WHERE user_id = $1 AND status = 'completed'", [uid]),
      pool.query('SELECT COUNT(*) as c FROM study_courses WHERE user_id = $1', [uid]),
      pool.query('SELECT COUNT(*) as c FROM study_flashcards WHERE user_id = $1', [uid])
    ]);
    res.json({ totalSessions: parseInt(ts.rows[0].c), totalMinutes: Math.floor(parseInt(tm.rows[0].t) / 60), activeDays: parseInt(ad.rows[0].d), totalCourses: parseInt(tc.rows[0].c), totalFlashcards: parseInt(fc.rows[0].c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/study/export/:courseId', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const course = (await pool.query('SELECT * FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.courseId, uid])).rows[0];
    if (!course) return res.status(404).json({ error: 'Not found' });
    const topics = (await pool.query('SELECT * FROM study_topics WHERE course_id = $1 ORDER BY order_index', [req.params.courseId])).rows;
    const subtopics = (await pool.query('SELECT * FROM study_subtopics WHERE course_id = $1 ORDER BY id', [req.params.courseId])).rows;
    const flashcards = (await pool.query('SELECT * FROM study_flashcards WHERE course_id = $1 AND user_id = $2', [req.params.courseId, uid])).rows;
    res.json({ course, topics, subtopics, flashcards, exportedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== STUDY API: CGPA SYNC ====================
app.post('/api/study/cgpa-sync', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const courses = await pool.query('SELECT * FROM study_courses WHERE user_id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up CGPA profile first' });
    let synced = 0;
    for (const c of courses.rows) {
      const exists = await pool.query('SELECT id FROM public.cgpa_courses WHERE user_id = $1 AND course_code = $2 AND deleted = false', [uid, c.course_code || c.course_name]);
      if (!exists.rows[0]) { const level = profile.rows[0].current_level || 300; await pool.query('INSERT INTO public.cgpa_courses (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)', [uid, c.course_code || c.course_name, c.course_name, level, 1, c.unit || 3, 'A']); synced++; }
    }
    res.json({ success: true, synced });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: CGPA forecast / what-if analysis
app.post('/api/cgpa/forecast', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ error: 'No profile' });
    const p = profile.rows[0];
    const scale = p.grading_scale || 5;
    const gpMap = scale === 5 ? { A:5, B:4, C:3, D:2, E:1, F:0 } : { A:4, B:3, C:2, D:1, F:0 };
    const visible = await pool.query('SELECT * FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false', [uid]);

    let curUnits = parseInt(p.prev_units) || 0;
    let curPoints = parseFloat(p.prev_gp) || 0;
    visible.rows.forEach(c => { const u = parseInt(c.credit_units)||0; curUnits += u; curPoints += (gpMap[c.grade]||0) * u; });
    const currentCGPA = curUnits > 0 ? (curPoints / curUnits) : 0;

    // Generate what-if scenarios
    const scenarios = [];
    const grades = scale === 5 ? ['A','B','C','D','E','F'] : ['A','B','C','D','F'];
    const targetCourses = visible.rows.filter(c => c.grade === 'F' || c.grade === 'E' || c.grade === 'D');
    const weakCoursesList = targetCourses.map(c => ({ code: c.course_code || c.title || 'Course', title: c.title || c.course_code || '', grade: c.grade, units: parseInt(c.credit_units)||0 }));
    if (targetCourses.length > 0) {
      for (const g of ['A', 'B', 'C']) {
        let newPoints = curPoints;
        let newUnits = curUnits;
        targetCourses.forEach(c => {
          const u = parseInt(c.credit_units)||0;
          newPoints -= (gpMap[c.grade]||0) * u;
          newPoints += (gpMap[g]||0) * u;
        });
        const newCGPA = newUnits > 0 ? (newPoints / newUnits) : 0;
        scenarios.push({ label: `If all D/E/F → ${g}`, grade: g, cgpa: newCGPA.toFixed(2), change: (newCGPA - currentCGPA).toFixed(3) });
      }
    }

    // What CGPA if add X new courses with all A's
    const addScenarios = [];
    for (let extra of [3, 5, 10]) {
      const addUnits = extra * 3;
      const addPoints = addUnits * (gpMap['A']||5);
      const newCGPA = (curPoints + addPoints) / (curUnits + addUnits);
      addScenarios.push({ courses: extra, units: addUnits, cgpa: newCGPA.toFixed(2) });
    }

    // Target CGPA calculation
    let targetData = null;
    const { targetCGPA } = req.body;
    if (targetCGPA && parseFloat(targetCGPA) > currentCGPA) {
      const tgt = parseFloat(targetCGPA);
      const neededPoints = tgt * curUnits;
      const deficit = neededPoints - curPoints;
      const unitsNeededA = Math.ceil(deficit / (gpMap['A']||5));
      targetData = { target: tgt, deficit: deficit.toFixed(1), unitsNeededA, coursesNeededA: Math.ceil(unitsNeededA / 3) };
    }

    res.json({ success: true, currentCGPA: currentCGPA.toFixed(2), scenarios, addScenarios, targetData, weakCourses: weakCoursesList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cgpa/ai-predict', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const courses = await pool.query("SELECT course_code, title, credit_units, grade, level_scope, semester FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false ORDER BY level_scope DESC, semester DESC LIMIT 60", [uid]);
    if (courses.rows.length === 0) return res.json({ success: false, error: 'Log at least one course to get a prediction.' });
    const prompt = `You are an academic advisor. The student has the following academic profile on a ${p.grading_scale || 5}-point scale:
Level: ${p.current_level || 'unknown'} ${p.department || ''}
Recent courses (code | title | units | grade | level-sem):
${courses.rows.map(c => '- ' + c.course_code + ' | ' + (c.title||'') + ' | ' + c.credit_units + 'u | ' + c.grade + ' | L' + c.level_scope + 'S' + c.semester).join('\n')}

Predict their likely GPA range next semester, identify subjects they are at risk of failing, and give 4 short practical study tips to lift their CGPA. Output PLAIN TEXT only (no markdown, no asterisks, no hashtags, no backticks). Use short paragraphs and numbered points as 1), 2), 3) where useful. Maximum 200 words.`;
    const aiRes = await studyPromptSmart(prompt);
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    res.json({ success: true, prediction: cleanAiText(aiRes.text) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/ai-whatif', isAuth, async (req, res) => {
  try {
    const { courseName, units, anticipatedGrade } = req.body;
    if (!courseName || !units || !anticipatedGrade) return res.json({ success: false, error: 'Fill in all fields.' });
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const scale = p.grading_scale || 5;
    const gpMap = scale === 5 ? { A:5, B:4, C:3, D:2, E:1, F:0 } : { A:4, B:3, C:2, D:1, F:0 };
    const courses = await pool.query("SELECT credit_units, grade FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false", [uid]);
    let curUnits = parseInt(p.prev_units) || 0;
    let curPoints = parseFloat(p.prev_gp) || 0;
    courses.rows.forEach(c => { const u = parseInt(c.credit_units)||0; curUnits += u; curPoints += (gpMap[c.grade]||0) * u; });
    const curCGPA = curUnits > 0 ? (curPoints / curUnits) : 0;
    const addU = parseInt(units) || 0;
    const addPts = (gpMap[String(anticipatedGrade).toUpperCase()] || 0) * addU;
    const newCGPA = (curPoints + addPts) / (curUnits + addU);
    const warn = newCGPA < curCGPA ? 'This would lower your CGPA. Consider aiming higher if possible.' : 'Good — this move improves your cumulative GPA.';
    const advicePrompt = `You are an academic advisor. The student asks: "If I take "${courseName}" (${addU} units) and aim for grade ${anticipatedGrade}, what's the impact?" Their current CGPA is ${curCGPA.toFixed(2)} / ${scale}. New CGPA would be ${newCGPA.toFixed(2)}. Give a 3-sentence plain-text answer about the impact and what to focus on to actually achieve ${anticipatedGrade}. No markdown, no asterisks.`;
    const aiRes = await studyPromptSmart(advicePrompt);
    const advice = (!aiRes.text || aiRes.text.startsWith('AI error')) ? warn : cleanAiText(aiRes.text);
    res.json({ success: true, currentCGPA: curCGPA.toFixed(2), newCGPA: newCGPA.toFixed(2), advice: advice });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/bulk-whatif', isAuth, async (req, res) => {
  try {
    const { courses: whatifCourses } = req.body;
    if (!whatifCourses || !Array.isArray(whatifCourses) || whatifCourses.length === 0)
      return res.json({ success: false, error: 'Add at least one course.' });
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const scale = p.grading_scale || 5;
    const gpMap = scale === 5 ? { A:5, B:4, C:3, D:2, E:1, F:0 } : { A:4, B:3, C:2, D:1, F:0 };
    const courses = await pool.query("SELECT credit_units, grade FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false", [uid]);
    let curUnits = parseInt(p.prev_units) || 0;
    let curPoints = parseFloat(p.prev_gp) || 0;
    courses.rows.forEach(c => { const u = parseInt(c.credit_units)||0; curUnits += u; curPoints += (gpMap[c.grade]||0) * u; });
    const curCGPA = curUnits > 0 ? (curPoints / curUnits) : 0;
    let addUnits = 0, addPoints = 0;
    const detail = [];
    for (const c of whatifCourses) {
      const u = parseInt(c.units) || 3;
      const g = String(c.grade || 'A').toUpperCase();
      addUnits += u;
      addPoints += (gpMap[g] || 0) * u;
      detail.push({ name: c.name || 'Course', units: u, grade: g });
    }
    const newCGPA = (curPoints + addPoints) / (curUnits + addUnits);
    res.json({
      success: true,
      currentCGPA: curCGPA.toFixed(2),
      newCGPA: newCGPA.toFixed(2),
      change: (newCGPA - curCGPA).toFixed(3),
      totalUnits: curUnits,
      newTotalUnits: curUnits + addUnits,
      detail
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/ai-chat', isAuth, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) return res.json({ success: false, error: 'Empty message.' });
    const uid = req.session.user.id;
    const cleanUser = cleanAiText(message);
    await pool.query('INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, 0, 0, $2, $3)', [uid, 'user:' + cleanUser]).catch(()=>{});
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    const courses = await pool.query("SELECT course_code, credit_units, grade, level_scope, semester FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false ORDER BY id DESC LIMIT 20", [uid]);
    let ctx = '';
    if (profile.rows[0]) {
      const p = profile.rows[0];
      ctx += 'Context: Student academic profile — current level ' + (p.current_level || 'unknown') + ', ' + (p.department || '') + ', scale ' + (p.grading_scale || 5) + '.\n';
    }
    if (courses.rows.length) {
      ctx += 'Recent courses (code | units | grade | lvl-sem):\n' + courses.rows.map(c => '- ' + c.course_code + ' | ' + c.credit_units + 'u | ' + c.grade + ' | L' + c.level_scope + 'S' + c.semester).join('\n') + '\n';
    }
    let convo = '';
    if (Array.isArray(history)) {
      history.slice(-6).forEach(function(m){ convo += (m.role === 'user' ? 'Student' : 'Advisor') + ': ' + (m.text || '').slice(0, 500) + '\n'; });
    }
    const prompt = 'You are a helpful academic advisor chatbot. Answer clearly and practically. Output PLAIN TEXT only (no markdown, no asterisks, no hashtags, no backticks). Use short paragraphs. Maximum 180 words per reply.\n\n' + ctx + (convo ? 'Conversation so far:\n' + convo + '\n' : '') + 'Student: ' + cleanUser + '\nAdvisor:';
    const aiRes = await studyPromptFast(prompt);
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    res.json({ success: true, reply: cleanAiText(aiRes.text) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Transcript export - structured JSON
app.get('/api/cgpa/transcript', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const user = await pool.query('SELECT fullname, email FROM users WHERE id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    const courses = await pool.query('SELECT * FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false ORDER BY level_scope ASC, semester ASC', [uid]);
    const scale = profile.rows[0] ? (profile.rows[0].grading_scale || 5) : 5;
    const gpMap = scale === 5 ? { A:5, B:4, C:3, D:2, E:1, F:0 } : { A:4, B:3, C:2, D:1, F:0 };
    let totalUnits = parseInt(profile.rows[0]?.prev_units) || 0;
    let totalPoints = parseFloat(profile.rows[0]?.prev_gp) || 0;
    const semesterData = {};
    courses.rows.forEach(c => {
      const key = `L${c.level_scope} S${c.semester}`;
      if (!semesterData[key]) semesterData[key] = { level: c.level_scope, semester: c.semester, courses: [], units: 0, points: 0 };
      const u = parseInt(c.credit_units)||0;
      const pts = (gpMap[c.grade]||0) * u;
      if (!c.is_hidden) { semesterData[key].units += u; semesterData[key].points += pts; totalUnits += u; totalPoints += pts; }
      semesterData[key].courses.push({ code: c.course_code, title: c.title, units: c.credit_units, grade: c.grade, excluded: c.is_hidden });
    });
    const cgpa = totalUnits > 0 ? (totalPoints / totalUnits) : 0;
    let degreeClass = '';
    if (scale === 5) { if (cgpa >= 4.5) degreeClass = 'First Class Honours'; else if (cgpa >= 3.5) degreeClass = 'Second Class (Upper)'; else if (cgpa >= 2.4) degreeClass = 'Second Class (Lower)'; else if (cgpa >= 1.5) degreeClass = 'Third Class'; else degreeClass = 'Pass'; }
    else { if (cgpa >= 3.5) degreeClass = 'First Class Honours'; else if (cgpa >= 3.0) degreeClass = 'Second Class (Upper)'; else if (cgpa >= 2.0) degreeClass = 'Second Class (Lower)'; else if (cgpa >= 1.5) degreeClass = 'Third Class'; else degreeClass = 'Pass'; }

    const semesters = Object.values(semesterData).sort((a,b) => a.level - b.level || a.semester - b.semester);
    let totalPassed = 0;
    semesters.forEach(s => {
      s.courses.forEach(c => { if (c.grade !== 'F' && !c.excluded) totalPassed++; });
    });
    const refNum = 'PPT/' + new Date().getFullYear() + '/' + String(uid).slice(-4) + '/' + String(Date.now()).slice(-6);

    res.json({
      student: user.rows[0] ? { name: user.rows[0].fullname, email: user.rows[0].email } : {},
      department: profile.rows[0]?.department || '',
      currentLevel: profile.rows[0]?.current_level || '',
      gradingScale: scale,
      semesters,
      totalUnits, totalPassed, cgpa: cgpa.toFixed(2), degreeClass,
      refNumber: refNum,
      generatedAt: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Study stats
// ======================== END STUDY HUB ROUTES ========================

// Global error handler - catches multer and other errors, returns JSON
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'File too large. Maximum size is 100MB.' });
        }
        return res.status(413).json({ success: false, message: err.message });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'File too large. Maximum size is 100MB.' });
    }
    res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
});

const config = {
    maxDuration: 60,
};

(async function initAIQuiz() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_courses (
      id SERIAL PRIMARY KEY,
      university_id INTEGER NOT NULL,
      course_code VARCHAR(50) NOT NULL,
      course_title VARCHAR(500) NOT NULL,
      question_count INTEGER DEFAULT 10,
      created_by INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_questions (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      options JSONB DEFAULT '[]',
      correct_answer VARCHAR(500),
      explanation TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[AI Quiz] Tables ready');
  } catch(e) { console.error('[AI Quiz] Init:', e.message); }
})();

(async function initCoupons() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      discount_type VARCHAR(10) NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
      discount_value INTEGER NOT NULL,
      max_uses INTEGER DEFAULT 0,
      times_used INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    try { await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS used_coupon VARCHAR(50)"); } catch (_) {}
    try { await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS current_level INTEGER DEFAULT 0"); } catch (_) {}
    console.log('[Coupons] Table ready');
  } catch(e) { console.error('[Coupons] Init:', e.message); }
})();

// Payments log table
(async function initPayments() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      reference VARCHAR(100) UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      currency VARCHAR(10) DEFAULT 'NGN',
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      coupon_code VARCHAR(50) DEFAULT '',
      channel VARCHAR(50) DEFAULT '',
      metadata JSONB DEFAULT '{}',
      verified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[Payments] Table ready');
  } catch(e) { console.error('[Payments] Init:', e.message); }
})();

(async function initAdminQuiz() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_quiz_sessions (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      university_id INTEGER NOT NULL,
      level VARCHAR(10) NOT NULL,
      status VARCHAR(20) DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_quiz_courses (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      course_code VARCHAR(50),
      course_title VARCHAR(500),
      department VARCHAR(200) DEFAULT '',
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_quiz_questions (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL,
      question_text TEXT,
      options JSONB DEFAULT '[]',
      correct_answer VARCHAR(500),
      explanation TEXT DEFAULT '',
      question_type VARCHAR(20) DEFAULT 'mcq',
      diagram_url TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS student_quiz_attempts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      course_id INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      data JSONB DEFAULT '[]',
      completed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_challenge_attempts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      subject VARCHAR(200) NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      score INTEGER DEFAULT 0,
      total INTEGER DEFAULT 20,
      completed BOOLEAN DEFAULT false,
      questions JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Drop old subject_groups and preset questions
    await pool.query('DROP TABLE IF EXISTS subject_groups CASCADE').catch(()=>{});
    await pool.query('DROP TABLE IF EXISTS preset_questions CASCADE').catch(()=>{});
    await pool.query('DROP TABLE IF EXISTS group_questions CASCADE').catch(()=>{});
    console.log('[Admin Quiz] Tables ready');
  } catch(e) { console.error('[Admin Quiz] Init:', e.message); }
})();

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;