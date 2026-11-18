const express = require('express');
const http = require('http');
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

// Session secret: use the configured value, or a random per-process secret as a
// safe fallback (sessions will not survive restarts in that case).
if (!process.env.SESSION_SECRET) {
    console.warn('[Session] SESSION_SECRET is not set — using an ephemeral secret. Set it in production.');
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Premium price (configurable via env)
const PREMIUM_PRICE = parseInt(process.env.PREMIUM_PRICE) || 2000;

const pdfParse = require('pdf-parse');

// Memory storage: Vercel's filesystem is read-only/ephemeral, so uploads are
// persisted in Postgres instead of local disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

// Memory storage for timetable extraction (need buffer)
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
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

// Prevent the in-memory limiter from growing without bound.
const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(rateLimitStore)) {
        if (now - rateLimitStore[key].start > 10 * 60 * 1000) delete rateLimitStore[key];
    }
}, 5 * 60 * 1000);
if (rateLimitCleanup.unref) rateLimitCleanup.unref();

// Helper for async routes: guarantees rejected handler promises reach the
// central error handler (registered at the end of this file).
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
  family: 4
});

// Handle pool errors gracefully
pool.on('error', (err) => {
    console.error('[DB] Pool error:', err.message);
});

// Shared, trusted calculation + XP modules (single source of truth).
const cgpaLib = require('./lib/cgpa');
const xpLib = require('./lib/xp');
const { runMigrations } = require('./scripts/migrate');

// Apply version-controlled migrations on boot (idempotent, tracked in
// schema_migrations). The promise is retained so seeds and feature routes can
// await it — otherwise they race the migration and fail with
// "relation does not exist" on any database where 001 has not applied yet.
const migrationsReady = (async () => {
    try {
        await runMigrations(pool);
        console.log('[DB] Migrations up to date');
    } catch (err) {
        console.error('[DB] Migration error:', err.message);
        throw err;
    }
})();
// The gate below surfaces migration failures through the central error
// handler; this no-op catch just stops Node warning about an unhandled
// rejection when no request ever awaits the promise.
migrationsReady.catch(() => {});

// Keep the (free-tier) database awake — Neon suspends after ~5 min idle,
// and a cold start can exceed the connection timeout and kill requests.
// Only useful on a long-running server; skip on serverless.
if (!process.env.VERCEL) {
    const keepAlive = setInterval(() => {
        pool.query('SELECT 1').catch(() => {});
    }, 120000);
    if (keepAlive.unref) keepAlive.unref();
}

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
app.set('view cache', process.env.NODE_ENV === 'production');

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

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Add this line directly ABOVE your app.use(session({...})) middleware declaration
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const sessionStore = new pgSession({
    pool: pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
});

app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    }
}));

// Page-view tracking for analytics (fire-and-forget, skips admin/API/static)
app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.session || !req.session.user) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin') ) return next();
    pool.query(
        'INSERT INTO page_views (user_id, page_path, visit_time) VALUES ($1, $2, NOW())',
        [req.session.user.id, req.path.split('?')[0]]
    ).catch(() => {});
    next();
});

// Middleware to check if user is logged in
const isAuth = (req, res, next) => {
    if (req.session.user) return next();
    if (req.xhr || req.headers.accept?.includes('json') || req.headers['content-type']?.includes('multipart') || req.headers['content-type']?.includes('json') || req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    res.redirect('/login');
};

const requirePaid = async (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    try {
        const r = await pool.query('SELECT has_paid, migrated_locked FROM users WHERE id = $1', [req.session.user.id]);
        const u = r.rows[0];
        if (u && u.has_paid) {
            req.session.user.has_paid = true;
            return next();
        }
        if (u && u.migrated_locked) req.session.user.has_paid = false;
        const isAPI = req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/');
        if (isAPI) {
            return res.status(402).json({ success: false, message: 'Premium required', premium_required: true });
        }
        return res.redirect('/dashboard?msg=Premium+feature.+Recharge+to+continue');
    } catch (err) {
        const isAPI = req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/');
        if (isAPI) {
            return res.status(402).json({ success: false, message: 'Premium required', premium_required: true });
        }
        return res.redirect('/dashboard?msg=Premium+feature.+Recharge+to+continue');
    }
};

const isAdmin = (req, res, next) => {
    // Check if the session user exists AND the is_admin flag is true
    if (req.session.user && req.session.user.is_admin === true) {
        return next();
    }

    // If they aren't an admin, they stay out
    res.status(403).send("Access Denied: Admins Only");
};

// Constant-time string comparison (hashes first so lengths always match)
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a || '')).digest();
    const hb = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}

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
      { loc: BASE_URL + '/login', priority: '0.5', changefreq: 'monthly' },
      { loc: BASE_URL + '/library', priority: '0.8', changefreq: 'weekly' },
      { loc: BASE_URL + '/library/university-of-ibadan', priority: '0.7', changefreq: 'weekly' }
    ];
    const libUnis = await pool.query("SELECT slug FROM universities WHERE id IN (SELECT DISTINCT university_id FROM library_courses)").catch(() => ({ rows: [] }));
    for (const lu of libUnis.rows) {
      pages.push({ loc: BASE_URL + '/library/' + lu.slug, priority: '0.7', changefreq: 'weekly' });
    }
    // Study Hub pages are behind authentication and premium entitlements, so they
    // are intentionally excluded from the sitemap (no private content in search).
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

// Front Page
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/guide', (req, res) => {
    res.locals.seo.title = 'Prepium | User Guide';
    res.locals.seo.description = 'Complete guide to Prepium — learn how to use CBT practice, AI study tools, flashcards, quizzes, and more to ace your exams.';
    res.render('guide', { user: req.session.user || null });
});

app.get('/terms', (req, res) => {
    res.render('terms');
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

// Offline fallback for the PWA service worker
app.get('/offline', (req, res) => {
    res.locals.seo.robots = 'noindex,nofollow';
    res.render('offline', { user: req.session.user || null });
});

// Dedicated app-installation guide page
app.get('/install', (req, res) => {
    res.locals.seo.title = 'Install Prepium App';
    res.locals.seo.description = 'Install the Prepium app on your Android phone, iPhone or computer for a faster, full-screen study experience.';
    res.render('install', { user: req.session.user || null });
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

        // School-based premium: free schools → auto premium, paid schools → must pay
        const school = uniId ? await getSchoolById(uniId) : null;
        const paidSchool = !!school && school.is_paid;
        const hasPaid = !paidSchool;

        await pool.query(
            'INSERT INTO users (fullname, email, password, university_id, unique_code, has_paid) VALUES ($1, $2, $3, $4, $5, $6)',
            [
                fullname,
                email.toLowerCase(),
                hashedPassword,
                uniId,
                cleanReferralCode,
                hasPaid
            ]
        );

        res.redirect(paidSchool
            ? '/login?msg=Account created! Your school requires premium access.'
            : '/login?msg=Account created! You now have full Premium access.');

    } catch (err) {
        console.error("Signup Error:", err);
        res.redirect('/signup?error=Error creating account.');
    }
});


// Payment verification handled via GET /verify-payment (Paystack callback)

// --- GET Login Page ---
async function getLoginNotice() {
    try {
        const r = await pool.query(`SELECT value FROM app_config WHERE key = 'login_notice'`);
        if (!r.rows.length) return null;
        const parsed = JSON.parse(r.rows[0].value);
        if (!parsed || !parsed.message) return null;
        return { message: parsed.message, link: parsed.link || '', label: parsed.label || 'Read More' };
    } catch (e) { return null; }
}

app.get('/login', async (req, res) => {
    const notice = await getLoginNotice();
    res.render('login', { error: null, notice });
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

                    // 6b. Record login for analytics (fire-and-forget)
                    pool.query('INSERT INTO login_history (user_id, login_at) VALUES ($1, NOW())', [user.id]).catch(() => {});

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

// ─── Premium Migration (for users who registered before auto-premium) ───
app.get('/migrate-premium', (req, res) => {
    res.render('migrate-premium', { user: req.session.user || null });
});

app.post('/api/premium/migrate/lookup', rateLimit(15, 60000), async (req, res) => {
    try {
        await ensureMigrationColumns();
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: false, error: 'Enter a valid email address' });
        }
        const r = await pool.query(
            `SELECT u.id, u.fullname, u.email, u.has_paid, u.migrated_free, u.migrated_locked, uni.name AS school
             FROM users u LEFT JOIN universities uni ON u.university_id = uni.id
             WHERE LOWER(TRIM(u.email)) = $1 LIMIT 1`, [email]);
        if (!r.rows[0]) return res.json({ success: false, error: 'No account found with this email.' });
        const u = r.rows[0];
        res.json({ success: true, found: true, alreadyPremium: !!u.has_paid, locked: !!u.migrated_locked && !u.has_paid, email: u.email, name: u.fullname, school: u.school || 'Not set', id: u.id });
    } catch (err) { res.status(500).json({ success: false, error: 'Server error. Try again.' }); }
});

app.post('/api/premium/migrate/activate', rateLimit(10, 60000), async (req, res) => {
    try {
        await ensureMigrationColumns();
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: false, error: 'Enter a valid email address' });
        }
        const r = await pool.query(
            `SELECT u.id, u.fullname, u.email, u.has_paid, u.migrated_locked, uni.name AS school
             FROM users u LEFT JOIN universities uni ON u.university_id = uni.id
             WHERE LOWER(TRIM(u.email)) = $1 LIMIT 1`, [email]);
        if (!r.rows[0]) return res.json({ success: false, error: 'No account found with this email.' });
        const u = r.rows[0];
        if (u.has_paid) return res.json({ success: true, alreadyPremium: true, name: u.fullname, email: u.email });
        if (u.migrated_locked) return res.json({ success: false, error: 'This account already got free migration. Recharge from your dashboard to keep Premium.' });
        await pool.query('UPDATE users SET has_paid = true, migrated_free = true, migrated_at = COALESCE(migrated_at, NOW()) WHERE id = $1', [u.id]);
        if (req.session && req.session.user && req.session.user.id === u.id) req.session.user.has_paid = true;
        res.json({ success: true, name: u.fullname, email: u.email });
    } catch (err) { res.status(500).json({ success: false, error: 'Server error. Try again.' }); }
});

// ─── Admin: Premium Migration Management ───
const PREMIUM_FEATURES = [
  { key: 'study', label: 'Study Hub & AI', icon: 'fa-graduation-cap' },
  { key: 'timetable', label: 'Timetable', icon: 'fa-calendar-alt' },
  { key: 'reading', label: 'Reading Schedule', icon: 'fa-book-open' },
  { key: 'cgpa', label: 'CGPA Tracker', icon: 'fa-chart-line' },
  { key: 'ai_quiz', label: 'AI Quiz Generator', icon: 'fa-wand-magic-sparkles' },
  { key: 'history', label: 'History & Stats', icon: 'fa-chart-bar' },
  { key: 'competition', label: 'Live Arena', icon: 'fa-trophy' },
  { key: 'deadlines', label: 'Deadlines', icon: 'fa-hourglass-half' }
];

async function getPremiumSettings() {
  const defaults = { recharge_price: PREMIUM_PRICE, locked_features: [], migrated_locked: false };
  try {
    const r = await pool.query('SELECT key, value FROM premium_settings');
    r.rows.forEach(row => {
      if (row.key === 'recharge_price') defaults.recharge_price = parseInt(row.value) || PREMIUM_PRICE;
      else if (row.key === 'locked_features') { try { defaults.locked_features = JSON.parse(row.value || '[]'); } catch (_) { defaults.locked_features = []; } }
      else if (row.key === 'migrated_locked') defaults.migrated_locked = row.value === 'true';
    });
  } catch (_) { }
  return defaults;
}

async function savePremiumSettings(patch) {
  for (const k of Object.keys(patch)) {
    const v = typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : String(patch[k]);
    await pool.query(`INSERT INTO premium_settings (key, value, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [k, v]);
  }
}

async function getSchoolById(id) {
  if (!id) return null;
  try {
    const r = await pool.query('SELECT id, name, slug, is_paid, price, locked_features FROM universities WHERE id = $1', [id]);
    if (!r.rows.length) return null;
    const s = r.rows[0];
    return { ...s, is_paid: !!s.is_paid, price: parseInt(s.price) || 0, locked_features: Array.isArray(s.locked_features) ? s.locked_features : [] };
  } catch (_) { return null; }
}

async function getSchoolForUser(userId) {
  try {
    const r = await pool.query('SELECT university_id FROM users WHERE id = $1', [userId]);
    return r.rows[0] && r.rows[0].university_id ? getSchoolById(r.rows[0].university_id) : null;
  } catch (_) { return null; }
}

// Feature-level lock middleware (school + global locked features)
function featureLock(key) {
  return async (req, res, next) => {
    try {
      if (!req.session.user) return res.redirect('/login');
      const school = await getSchoolForUser(req.session.user.id);
      const settings = await getPremiumSettings();
      const locked = [...(settings.locked_features || []), ...(school?.locked_features || [])];
      if (key && locked.includes(key)) {
        const isAPI = req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/');
        if (isAPI) return res.status(403).json({ success: false, message: 'This feature is locked for your school' });
        return res.redirect('/dashboard?msg=' + encodeURIComponent('This feature is locked for your school by the administrator'));
      }
      next();
    } catch (err) {
      // Fail closed: if entitlements cannot be verified, do not grant access.
      console.error('[featureLock]', err.message);
      const isAPI = req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/');
      if (isAPI) return res.status(503).json({ success: false, message: 'Could not verify feature access. Try again.' });
      return res.status(503).send('Could not verify feature access. Please try again later.');
    }
  };
}

app.get('/admin/migrations', isAdmin, async (req, res) => {
  try {
    await ensureMigrationColumns();
    const users = await pool.query(`
      SELECT u.id, u.fullname, u.email, u.has_paid, u.migrated_free, u.migrated_at, u.migrated_locked, uni.name AS school
      FROM users u LEFT JOIN universities uni ON u.university_id = uni.id
      WHERE u.migrated_free = true
      ORDER BY u.migrated_at DESC NULLS LAST, u.id DESC`);
    const locked = await pool.query('SELECT COUNT(*) FROM users WHERE migrated_free = true AND migrated_locked = true');
    const settings = await getPremiumSettings();
    res.render('admin/migrations', {
      users: users.rows,
      lockedCount: parseInt(locked.rows[0].count) || 0,
      settings,
      features: PREMIUM_FEATURES,
      user: req.session.user
    });
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.post('/admin/migrations/settings', isAdmin, async (req, res) => {
  try {
    const price = parseInt(req.body.recharge_price) || 0;
    const lockedFeatures = Array.isArray(req.body.locked_features)
      ? req.body.locked_features
      : (req.body.locked_features ? [req.body.locked_features] : []);
    await savePremiumSettings({ recharge_price: price, locked_features: lockedFeatures });
    res.redirect('/admin/migrations?msg=Settings+saved');
  } catch (e) { res.redirect('/admin/migrations?error=' + encodeURIComponent(e.message)); }
});

app.post('/admin/migrations/lock', isAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET has_paid = false, migrated_locked = true WHERE migrated_free = true AND has_paid = true RETURNING id');
    await savePremiumSettings({ migrated_locked: true });
    res.redirect('/admin/migrations?msg=Locked+' + r.rowCount + '+migrated+users+out');
  } catch (e) { res.redirect('/admin/migrations?error=' + encodeURIComponent(e.message)); }
});

app.post('/admin/migrations/unlock', isAdmin, async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET has_paid = true, migrated_locked = false WHERE migrated_free = true AND migrated_locked = true RETURNING id');
    await savePremiumSettings({ migrated_locked: false });
    res.redirect('/admin/migrations?msg=Restored+premium+for+' + r.rowCount + '+users');
  } catch (e) { res.redirect('/admin/migrations?error=' + encodeURIComponent(e.message)); }
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

        // Shared trusted calculation (lib/cgpa.js) — same values as the tracker
        const cgpaStats = cgpaLib.computeCGPA({
            scale,
            prevUnits: cgpaProfile ? cgpaProfile.prev_units : 0,
            prevPoints: cgpaProfile ? cgpaProfile.prev_gp : 0,
            courses: coursesRes.rows
        });
        const calculatedCGPA = cgpaStats.cgpaNumber;

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
            recentUsers: recentUsers.rows,
            notice: await getLoginNotice()
        });

    } catch (err) {
        console.error("Admin Dashboard Error:", err);
        res.status(500).send("Database Error: Verify your table structures (users, universities, subjects, questions).");
    }
});

// --- Save/Clear Login Notice (admin customizable, shown to all users) ---
app.post('/admin/notice', isAdmin, async (req, res) => {
    try {
        const message = (req.body.message || '').trim();
        const link = (req.body.link || '').trim();
        const label = (req.body.label || 'Read More').trim();
        if (!message) {
            await pool.query(`DELETE FROM app_config WHERE key = 'login_notice'`);
            return res.json({ success: true, cleared: true });
        }
        const payload = JSON.stringify({ message, link, label });
        await pool.query(`INSERT INTO app_config (key, value) VALUES ('login_notice', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [payload]);
        res.json({ success: true });
    } catch (err) {
        console.error('Save login notice error:', err);
        res.json({ success: false, message: 'Failed to save notice' });
    }
});

// ==========================================
// 1. UNIVERSITY MANAGEMENT (NEW)
// ==========================================

// View all universities
app.get('/admin/universities', isAdmin, async (req, res) => {
    try {
        await ensureMigrationColumns();
        const result = await pool.query('SELECT * FROM universities ORDER BY name ASC');
        res.render('admin/universities', { universities: result.rows, features: PREMIUM_FEATURES });
    } catch (err) {
        res.status(500).send("Error loading universities");
    }
});

// Add a university (with school premium defaults)
app.post('/admin/universities/add', isAdmin, async (req, res) => {
    const { name, slug, is_paid, price } = req.body;
    try {
        await pool.query('INSERT INTO universities (name, slug, is_paid, price) VALUES ($1, $2, $3, $4)',
            [name, slug.toLowerCase(), is_paid === 'on' || is_paid === 'true', parseInt(price) || 2000]);
        res.redirect('/admin/universities');
    } catch (err) {
        res.status(500).send("Error adding university");
    }
});

// AI-assisted university name suggestion
app.post('/admin/universities/ai-suggest', isAdmin, async (req, res) => {
    const input = (req.body.input || '').trim();
    if (!input) return res.json({ success: false, message: 'Type a hint first' });
    try {
        const prompt = 'You are a Nigerian university database. The user typed a partial university name: "' + input +
            '". Return the FULL official name of the most likely Nigerian university and a short lowercase slug (abbreviation). ' +
            'Respond with STRICT JSON only, no markdown: {"name":"...","slug":"..."}. If unsure, keep the name close to their input and make a slug from it.';
        const result = await callGeminiWithText(prompt, '');
        const text = (result.text || result.response || '').trim();
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : text);
        res.json({ success: true, name: parsed.name || input, slug: (parsed.slug || '').toLowerCase() || input.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) });
    } catch (err) {
        console.error('AI suggest error:', err);
        res.json({ success: false, message: 'AI suggestion failed. Check Gemini API keys.' });
    }
});

// Save per-school premium config (paid/free, price, locked features)
app.post('/admin/universities/config/:id', isAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.redirect('/admin/universities?msg=Invalid+school');
    const is_paid = req.body.is_paid === 'on' || req.body.is_paid === 'true' || req.body.is_paid === '1';
    const price = parseInt(req.body.price) || 0;
    const lockedFeatures = Array.isArray(req.body.locked_features)
        ? req.body.locked_features
        : (req.body.locked_features ? [req.body.locked_features] : []);
    try {
        await pool.query('UPDATE universities SET is_paid = $1, price = $2, locked_features = $3 WHERE id = $4',
            [is_paid, price, JSON.stringify(lockedFeatures), id]);
        res.redirect('/admin/universities?msg=Saved+settings+for+school');
    } catch (err) {
        console.error('Config save error:', err);
        res.redirect('/admin/universities?error=' + encodeURIComponent(err.message));
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
  try {
    const userId = req.session.user.id;
    const userRes = await pool.query('SELECT has_paid, used_coupon, migrated_free, migrated_locked FROM users WHERE id = $1', [userId]);
    const u = userRes.rows[0] || {};
    const school = await getSchoolForUser(userId);
    const premiumSettings = await getPremiumSettings();
    const isPaidSchool = !!school && school.is_paid;
    const schoolPrice = isPaidSchool && school.price ? school.price : premiumSettings.recharge_price;
    const schoolLocked = (school && Array.isArray(school.locked_features)) ? school.locked_features : [];
    res.locals.seo.title = 'Prepium Premium | Unlock AI Study Tools';
    res.locals.seo.description = 'Unlock the full Prepium experience — AI study assistant, PDF-to-quiz generator, flashcards, CGPA tools, smart planners and more.';
    res.render('upgrade', {
      user: { ...req.session.user, ...u },
      paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
      premiumPrice: isPaidSchool ? schoolPrice : PREMIUM_PRICE,
      rechargePrice: schoolPrice,
      isPaidSchool,
      migratedLocked: !!(u.migrated_free && u.migrated_locked && !u.has_paid),
      schoolLockedFeatures: schoolLocked,
      paymentState: req.query.payment === 'success' ? 'success' : (req.query.payment === 'failed' ? 'failed' : null),
      paymentReason: req.query.reason || null
    });
  } catch (err) {
    console.error('Upgrade page error:', err);
    res.redirect('/dashboard');
  }
});

// ==========================================
// 4. API FOR THE STUDENT APP
// ==========================================

// JSON API for getting subjects based on student's university
app.get('/api/subjects', isAuth, async (req, res) => {
    try {
        const userUni = req.session.user.university_id;
        const result = await pool.query('SELECT * FROM subjects WHERE university_id = $1', [userUni]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch subjects" });
    }
});

// JSON API (To get questions for a subject) — never expose the answer key
app.get('/api/questions/:subject_id', isAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, subject_id, question_text, option_a, option_b, option_c, option_d
             FROM questions WHERE subject_id = $1`,
            [req.params.subject_id]
        );
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

// --- DELETE ACCOUNT ROUTE ---
app.get('/auth/delete-account', isAuth, async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    try {
        const userId = req.session.user.id;
        // Delete the user from the database
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        // Destroy the session
        req.session.destroy((err) => {
            if (err) {
                console.log("Logout error on account deletion:", err);
            }
            res.clearCookie('connect.sid');
            res.redirect('/'); // Redirect to homepage after deletion
        });
    } catch (err) {
        console.error("Error deleting account:", err);
        res.redirect('/dashboard?msg=Error deleting account');
    }
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

        await ensureMigrationColumns();

        // 1. Fetch Fresh User Data (Payment, Streak, and Quiz Attempts)
        const userRes = await pool.query(
            'SELECT has_paid, current_streak, quiz_attempts, migrated_free, migrated_at, migrated_locked FROM users WHERE id = $1',
            [userId]
        );
        const userData = userRes.rows[0];

        // 2. Notification Count (Unread) — per user: unread announcements + unread personal
        const notifCheck = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM notifications n
                 WHERE NOT EXISTS (
                     SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1
                 ))
              + (SELECT COUNT(*) FROM user_notifications WHERE user_id = $1 AND is_read = false) AS count`,
            [userId]
        );
        const unreadNotifs = parseInt(notifCheck.rows[0].count) || 0;

        // 3. Get Recent History
        const historyRes = await pool.query(`
            SELECT score, subject, TO_CHAR(taken_at, 'Mon DD, HH24:MI') as time
            FROM results
            WHERE user_id = $1
            ORDER BY taken_at DESC
            LIMIT 5`, [userId]);

        // 4. Get study stats for dashboard
        const [studyStatsRes, quizStatsRes, streakRes] = await Promise.all([
            pool.query('SELECT COALESCE(SUM(elapsed_seconds), 0) as t, COUNT(*) as s FROM study_sessions WHERE user_id = $1 AND status = $2', [userId, 'completed']),
            pool.query(`SELECT
                (SELECT COUNT(*) FROM quiz_results WHERE user_id = $1)
              + (SELECT COUNT(*) FROM results WHERE user_id = $1) as c,
                (SELECT COALESCE(AVG(pct), 0) FROM (
                    SELECT (score::float / NULLIF(total_questions, 0) * 100) as pct FROM quiz_results WHERE user_id = $1 AND total_questions > 0
                    UNION ALL
                    SELECT (score::float / NULLIF(total_questions, 0) * 100) as pct FROM results WHERE user_id = $1 AND total_questions > 0
                ) q) as avg`, [userId]),
            pool.query('SELECT current_streak FROM login_streaks WHERE user_id = $1', [userId])
        ]);
        const streak = parseInt(streakRes.rows[0]?.current_streak) || 0;
        const studySessions = parseInt(studyStatsRes.rows[0].s) || 0;
        const quizCount = parseInt(quizStatsRes.rows[0].c) || 0;
        const avgScore = Math.round(parseFloat(quizStatsRes.rows[0].avg) || 0);
        const aiQuizRes = await pool.query('SELECT COUNT(*) FROM quiz_results WHERE user_id = $1 AND subject_id IS NULL', [userId]);
        const aiQuizCount = parseInt(aiQuizRes.rows[0].count) || 0;

        // 5. Get recent quiz
        const recentQuizRes = await pool.query(`
            SELECT COALESCE(s.name, qr.title, 'Quiz') as subject, qr.score, qr.total_questions, TO_CHAR(qr.created_at, 'YYYY-MM-DD') as date_taken
            FROM quiz_results qr
            LEFT JOIN subjects s ON qr.subject_id = s.id
            WHERE qr.user_id = $1
            UNION ALL
            SELECT 'General Quiz' as subject, score, total_questions, TO_CHAR(taken_at, 'YYYY-MM-DD') as date_taken
            FROM results WHERE user_id = $1
            ORDER BY date_taken DESC
            LIMIT 1`, [userId]);

        const recentQuiz = recentQuizRes.rows[0] || null;

        // 6. School-based access: pricing + refer eligibility
        const school = await getSchoolForUser(userId);
        const premiumSettings = await getPremiumSettings();
        const isPaidSchool = !!school && school.is_paid;
        const schoolPrice = isPaidSchool && school.price ? school.price : premiumSettings.recharge_price;

        // 7. Personalised next-action data (real data only, batched)
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const [resumeRes, deadlinesRes, flashcardRes, planRes, tasksRes, footprintRes, weakRes] = await Promise.all([
            pool.query(`SELECT a.id, a.question_count, a.created_at, c.course_name
                        FROM study_quiz_attempts a
                        LEFT JOIN study_courses c ON c.id = a.course_id
                        WHERE a.user_id = $1 AND a.status = 'in_progress'
                        ORDER BY a.created_at DESC LIMIT 1`, [userId]),
            pool.query(`SELECT id, title, due_date, due_time FROM deadlines
                        WHERE user_id = $1 AND (due_date + due_time) > NOW()
                        ORDER BY due_date ASC, due_time ASC LIMIT 4`, [userId]),
            pool.query('SELECT COUNT(*) AS c FROM study_flashcards WHERE user_id = $1', [userId]),
            pool.query(`SELECT course, course_code, start_time, end_time FROM reading_timetables
                        WHERE user_id = $1 AND day = $2 ORDER BY start_time LIMIT 4`, [userId, todayName]),
            pool.query(`SELECT COUNT(*) AS c FROM daily_task_items WHERE user_id = $1 AND task_date = CURRENT_DATE AND is_done = false`, [userId]),
            pool.query(`SELECT
                (SELECT COUNT(*) FROM results WHERE user_id = $1) AS r,
                (SELECT COUNT(*) FROM study_sessions WHERE user_id = $1) AS s,
                (SELECT COUNT(*) FROM study_courses WHERE user_id = $1) AS c`, [userId]),
            pool.query(`SELECT subject, AVG(score::float / NULLIF(total_questions,0) * 100) AS avg_pct, COUNT(*) AS attempts
                        FROM results WHERE user_id = $1 AND total_questions > 0
                        GROUP BY subject HAVING COUNT(*) >= 2 AND AVG(score::float / NULLIF(total_questions,0) * 100) < 60
                        ORDER BY avg_pct ASC LIMIT 2`, [userId])
        ]);

        const resumeAttempt = resumeRes.rows[0] || null;
        const upcomingDeadlinesList = deadlinesRes.rows;
        const flashcardCount = parseInt(flashcardRes.rows[0].c) || 0;
        const todayPlan = planRes.rows;
        const pendingTasks = parseInt(tasksRes.rows[0].c) || 0;
        const footprint = footprintRes.rows[0] || { r: 0, s: 0, c: 0 };
        const isNewUser = (parseInt(footprint.r) || 0) === 0 && (parseInt(footprint.s) || 0) === 0 && (parseInt(footprint.c) || 0) === 0;
        const weakSubjects = weakRes.rows.map(w => ({ subject: w.subject, avg_pct: Math.round(parseFloat(w.avg_pct)), attempts: parseInt(w.attempts) }));

        // Build the single next-action recommendation from real data
        let nextAction = null;
        if (resumeAttempt) {
            nextAction = { icon: 'fa-play', title: 'Continue your quiz', sub: (resumeAttempt.course_name || 'Practice quiz') + ' \u00b7 ' + (resumeAttempt.question_count || 10) + ' questions', href: '/study/quiz/' + resumeAttempt.id, cta: 'Resume' };
        } else if (upcomingDeadlinesList.length > 0) {
            const d = upcomingDeadlinesList[0];
            const due = new Date(d.due_date);
            const days = Math.ceil((due - new Date(new Date().toDateString())) / 86400000);
            nextAction = { icon: 'fa-hourglass-half', title: d.title, sub: days <= 0 ? 'Due today' : (days === 1 ? 'Due tomorrow' : 'Due in ' + days + ' days'), href: '/deadlines', cta: 'View' };
        } else if (flashcardCount > 0) {
            nextAction = { icon: 'fa-clone', title: 'Review your flashcards', sub: flashcardCount + ' card' + (flashcardCount === 1 ? '' : 's') + ' saved across your courses', href: '/study', cta: 'Revise' };
        } else if (weakSubjects.length > 0) {
            nextAction = { icon: 'fa-bullseye', title: 'Practise ' + weakSubjects[0].subject, sub: 'Average ' + weakSubjects[0].avg_pct + '% over ' + weakSubjects[0].attempts + ' attempts — more practice will help', href: '/study', cta: 'Practise' };
        } else if (todayPlan.length > 0) {
            nextAction = { icon: 'fa-book-open', title: "Follow today's reading plan", sub: todayPlan.length + ' session' + (todayPlan.length === 1 ? '' : 's') + ' scheduled for ' + todayName, href: '/reading-timetable', cta: 'Start' };
        } else if (pendingTasks > 0) {
            nextAction = { icon: 'fa-tasks', title: 'Complete today\u2019s tasks', sub: pendingTasks + ' task' + (pendingTasks === 1 ? '' : 's') + ' still open', href: '/daily-task', cta: 'Open' };
        }

        res.render('dashboard', {
            user: { ...req.session.user, ...userData },
            notice: await getLoginNotice(),
            unreadNotifs,
            history: historyRes.rows,
            streak,
            studySessions,
            quizCount,
            avgScore,
            aiQuizCount,
            recentQuiz,
            nextAction,
            upcomingDeadlinesList,
            todayPlan,
            todayName,
            pendingTasks,
            flashcardCount,
            weakSubjects,
            isNewUser,
            paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
            premiumPrice: isPaidSchool ? schoolPrice : PREMIUM_PRICE,
            rechargePrice: schoolPrice,
            isPaidSchool,
            referEnabled: isPaidSchool,
            migratedLocked: !!(userData && userData.migrated_free && userData.migrated_locked && !userData.has_paid)
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.redirect('/login');
    }
});

app.get('/notifications', isStudent, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Global announcements with THIS user's read state
        const globals = await pool.query(
            `SELECT n.id, n.title, n.message, n.created_at,
                    (r.user_id IS NOT NULL) AS is_read
             FROM notifications n
             LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
             ORDER BY n.created_at DESC LIMIT 50`,
            [userId]
        );

        // 2. Personal social notifications (friend requests, chats, likes, groups)
        const personal = await pool.query(
            `SELECT id, type, title, body AS message, link, is_read, created_at
             FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [userId]
        );

        // 3. Mark read for THIS user only (after reading current states)
        await pool.query(
            `INSERT INTO notification_reads (notification_id, user_id)
             SELECT n.id, $1 FROM notifications n
             WHERE NOT EXISTS (
                 SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = $1
             )
             ON CONFLICT DO NOTHING`,
            [userId]
        );
        await pool.query('UPDATE user_notifications SET is_read = true WHERE user_id = $1', [userId]);

        // 4. Merge, newest first
        const items = [
            ...globals.rows.map(g => ({ kind: 'announcement', id: 'g' + g.id, title: g.title, message: g.message, link: null, is_read: g.is_read, created_at: g.created_at })),
            ...personal.rows.map(p => ({ kind: p.type, id: 'p' + p.id, title: p.title, message: p.message, link: p.link, is_read: p.is_read, created_at: p.created_at }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.render('student-notifications', { notifications: items, user: req.session.user });
    } catch (err) {
        console.error('[Notifications] error:', err.message);
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
            INSERT INTO student_materials (user_id, name, description, file_type, file_size, file_data)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            userId,
            name || file.originalname,
            description || '',
            file.mimetype,
            file.size,
            file.buffer
        ]);

        res.json({ success: true, message: 'Material uploaded successfully' });
    } catch (err) {
        console.error('Material upload error:', err);
        res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
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
            'SELECT file_data, file_path, file_type, name FROM student_materials WHERE id = $1 AND user_id = $2',
            [req.params.id, req.session.user.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }
        const file = result.rows[0];
        const safeName = String(file.name || 'material').replace(/[^\w.\- ]/g, '_');
        res.setHeader('Content-Type', file.file_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);

        if (file.file_data) {
            return res.send(file.file_data);
        }
        // Backwards compatibility for files stored on disk before this change.
        if (file.file_path && fs.existsSync(file.file_path)) {
            return res.sendFile(file.file_path);
        }
        return res.status(404).json({ error: 'File data not found' });
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

app.get('/history', isAuth, requirePaid, featureLock('history'), async (req, res) => {
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
                   taken_at AS created_at,
                   'General Quiz' as subject_name
            FROM results
            WHERE user_id = $1
            ORDER BY taken_at DESC
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

// GET: Show Ambassador Login Page (locked with Refer & Earn)
app.get('/ambassador/login', (req, res) => {
    res.redirect('/login');
});

// Ambassador login is disabled; the Refer & Earn system replaces it.
app.post('/ambassador/login', (req, res) => {
    res.status(403).json({ success: false, error: 'Refer & Earn is currently disabled' });
});

app.get('/ambassador/dashboard', (req, res) => {
    res.redirect('/dashboard');
});

app.post('/ambassador/update-bank', (req, res) => {
    res.status(403).json({ success: false, error: 'Refer & Earn is currently disabled' });
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
app.post('/admin/login', rateLimit(5, 60000), async (req, res) => {
    const { email, password } = req.body;

    try {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!adminEmail || !adminPassword) {
            console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
            return res.render('admin-login', { error: "Admin login not configured." });
        }

        if (safeEqual(email, adminEmail) && safeEqual(password, adminPassword)) {
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
app.get('/deadlines', isAuth, featureLock('deadlines'), async (req, res) => {
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
app.get('/timetable', isAuth, requirePaid, featureLock('timetable'), async (req, res) => {
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
app.get('/reading-timetable', isAuth, requirePaid, featureLock('reading'), async (req, res) => {
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

// Referral / "Refer & Earn" system is locked (disabled) — everyone is now auto-premium
// Refer & Earn is only available to users whose school is marked "paid"
async function referAllowed(req) {
    if (!req.session.user) return false;
    try {
        const school = await getSchoolForUser(req.session.user.id);
        return !!(school && school.is_paid);
    } catch (_) { return false; }
}

app.get('/refer', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (!(await referAllowed(req))) return res.redirect('/dashboard?msg=' + encodeURIComponent('Refer & Earn is available for students from paid schools only'));
    res.render('refer', { user: req.session.user || null });
});

app.get('/refer/dashboard', isAuth, async (req, res) => {
    if (!(await referAllowed(req))) return res.redirect('/dashboard?msg=' + encodeURIComponent('Refer & Earn is available for students from paid schools only'));
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
    if (!(await referAllowed(req))) return res.status(403).json({ success: false, error: 'Refer & Earn is available for students from paid schools only' });
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

// ==========================================
// SQUAD STREAKS — group accountability
// ==========================================
async function computeSquadStreak(squadId, memberCount) {
    try {
        if (!memberCount || memberCount <= 0) return 0;
        const r = await pool.query(
            `SELECT checkin_date, COUNT(DISTINCT user_id) AS cnt
             FROM squad_checkins
             WHERE squad_id = $1 AND checkin_date >= CURRENT_DATE - INTERVAL '90 days'
             GROUP BY checkin_date
             ORDER BY checkin_date DESC`, [squadId]
        );
        const complete = new Set();
        r.rows.forEach(row => { if (parseInt(row.cnt) >= memberCount) complete.add(row.checkin_date.toISOString().slice(0, 10)); });
        const today = new Date();
        const fmt = d => d.toISOString().slice(0, 10);
        const d = new Date(today);
        if (!complete.has(fmt(d))) d.setDate(d.getDate() - 1); // today still in progress
        let streak = 0;
        while (complete.has(fmt(d))) { streak++; d.setDate(d.getDate() - 1); }
        return streak;
    } catch (_) { return 0; }
}

async function getUserSquads(userId) {
    try {
        const r = await pool.query(
            `SELECT sq.id, sq.name, sq.owner_id, sq.invite_code,
                    (SELECT COUNT(*) FROM squad_members sm WHERE sm.squad_id = sq.id) AS member_count
             FROM squads sq
             JOIN squad_members sm ON sm.squad_id = sq.id
             WHERE sm.user_id = $1
             ORDER BY sq.created_at ASC`, [userId]
        );
        return r.rows || [];
    } catch (_) { return []; }
}

async function getUserSquad(userId) {
    const list = await getUserSquads(userId);
    return list[0] || null;
}

function genInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

app.get('/squads', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const squads = await getUserSquads(userId);
        const list = [];
        for (const sq of squads) {
            const members = await pool.query(
                `SELECT u.id, u.fullname, u.has_paid,
                        (EXISTS (SELECT 1 FROM squad_checkins sc WHERE sc.squad_id = $1 AND sc.user_id = u.id AND sc.checkin_date = CURRENT_DATE)) AS checked_today
                 FROM squad_members sm
                 JOIN users u ON u.id = sm.user_id
                 WHERE sm.squad_id = $1
                 ORDER BY sm.joined_at ASC`, [sq.id]
            );
            const memberCount = parseInt(sq.member_count);
            const streak = await computeSquadStreak(sq.id, memberCount);
            const checkedToday = members.rows.filter(m => m.checked_today).length;
            const meChecked = members.rows.some(m => m.id === userId && m.checked_today);
            list.push({
                id: sq.id,
                name: sq.name,
                inviteCode: sq.invite_code,
                ownerId: sq.owner_id,
                memberCount,
                checkedToday,
                meChecked,
                streak,
                isOwner: sq.owner_id === userId,
                members: members.rows
            });
        }
        res.render('squads', { user: req.session.user, squads: list, introTag: 'Together, we never miss' });
    } catch (err) {
        console.error('Squads page error:', err);
        res.status(500).send('Error loading squads');
    }
});

app.post('/squads/create', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const name = (req.body.name || '').trim().slice(0, 120);
        if (!name) return res.redirect('/squads?msg=' + encodeURIComponent('Enter a squad name'));
        let code = genInviteCode();
        let dup = await pool.query('SELECT id FROM squads WHERE invite_code = $1', [code]);
        while (dup.rows.length) { code = genInviteCode(); dup = await pool.query('SELECT id FROM squads WHERE invite_code = $1', [code]); }
        const sq = await pool.query('INSERT INTO squads (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING id', [name, userId, code]);
        await pool.query('INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)', [sq.rows[0].id, userId]);
        await pool.query(`INSERT INTO squad_checkins (squad_id, user_id, checkin_date) VALUES ($1, $2, CURRENT_DATE)
            ON CONFLICT DO NOTHING`, [sq.rows[0].id, userId]);
        res.redirect('/squads?msg=' + encodeURIComponent('Squad "' + name + '" created!'));
    } catch (err) { console.error('Create squad error:', err); res.redirect('/squads?msg=' + encodeURIComponent('Failed to create squad')); }
});

app.post('/squads/join', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const code = (req.body.code || '').trim().toUpperCase();
        if (!code) return res.redirect('/squads?msg=' + encodeURIComponent('Enter the invite code'));
        const sq = await pool.query('SELECT id, name FROM squads WHERE invite_code = $1', [code]);
        if (!sq.rows.length) return res.redirect('/squads?msg=' + encodeURIComponent('Invalid invite code'));
        const inSquad = await pool.query('SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2', [sq.rows[0].id, userId]);
        if (!inSquad.rows.length) {
            await pool.query('INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2)', [sq.rows[0].id, userId]);
        }
        res.redirect('/squads?msg=' + encodeURIComponent('Joined ' + sq.rows[0].name + '!'));
    } catch (err) { console.error('Join squad error:', err); res.redirect('/squads?msg=' + encodeURIComponent('Failed to join squad')); }
});

app.post('/squads/checkin', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const squadId = parseInt(req.body.squad_id);
        if (!squadId) return res.status(400).json({ success: false, error: 'Squad required' });
        const member = await pool.query('SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2', [squadId, userId]);
        if (!member.rows.length) return res.status(403).json({ success: false, error: 'Not a member of that squad' });
        await pool.query(`INSERT INTO squad_checkins (squad_id, user_id, checkin_date) VALUES ($1, $2, CURRENT_DATE)
            ON CONFLICT DO NOTHING`, [squadId, userId]);
        const sq = await pool.query('SELECT * FROM squads WHERE id = $1', [squadId]);
        const streak = sq.rows.length ? await computeSquadStreak(squadId, await (async () => {
            const c = await pool.query('SELECT COUNT(*)::int AS c FROM squad_members WHERE squad_id = $1', [squadId]);
            return c.rows[0].c;
        })()) : 0;
        res.json({ success: true, streak });
    } catch (err) { res.status(500).json({ success: false, error: 'Check-in failed' }); }
});

app.post('/squads/checkin-all', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const squads = await getUserSquads(userId);
        if (!squads.length) return res.status(400).json({ success: false, error: 'Join or create a squad first' });
        for (const sq of squads) {
            await pool.query(`INSERT INTO squad_checkins (squad_id, user_id, checkin_date) VALUES ($1, $2, CURRENT_DATE)
                ON CONFLICT DO NOTHING`, [sq.id, userId]);
        }
        res.json({ success: true, count: squads.length });
    } catch (err) { res.status(500).json({ success: false, error: 'Bulk check-in failed' }); }
});

app.post('/squads/leave', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const squadId = parseInt(req.body.squad_id || req.query.squad_id);
        const squad = squadId ? await pool.query('SELECT * FROM squads WHERE id = $1', [squadId]) : { rows: [] };
        if (!squad.rows.length) return res.redirect('/squads');
        const sq = squad.rows[0];
        if (sq.owner_id === userId) {
            await pool.query('DELETE FROM squad_checkins WHERE squad_id = $1', [sq.id]);
            await pool.query('DELETE FROM squad_members WHERE squad_id = $1', [sq.id]);
            await pool.query('DELETE FROM squads WHERE id = $1', [sq.id]);
            return res.redirect('/squads?msg=' + encodeURIComponent('Squad "' + sq.name + '" dissolved'));
        }
        await pool.query('DELETE FROM squad_checkins WHERE squad_id = $1 AND user_id = $2', [sq.id, userId]);
        await pool.query('DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2', [sq.id, userId]);
        res.redirect('/squads?msg=' + encodeURIComponent('You left "' + sq.name + '"'));
    } catch (err) { console.error('Leave squad error:', err); res.redirect('/squads'); }
});

// ==========================================
// PUBLIC FORMS — standalone score collectors (NAPS style, no login)
// ==========================================
function genFormSlug() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function napFields() {
    const now = Date.now();
    return [
        { id: 'f' + now + '_matric', label: 'Matric Number', type: 'text', required: true },
        { id: 'f' + now + '_gst212', label: 'GST 212', type: 'number', required: true },
        { id: 'f' + now + '_phy201', label: 'PHY 201', type: 'number', required: true },
        { id: 'f' + now + '_phy205', label: 'PHY 205', type: 'number', required: true },
        { id: 'f' + now + '_ent211', label: 'ENT 211', type: 'number', required: true },
        { id: 'f' + now + '_mth202', label: 'MTH 202', type: 'number', required: true }
    ];
}

app.get('/form/:slug', async (req, res) => {
    try {
        const f = await pool.query('SELECT * FROM pub_forms WHERE slug = $1', [req.params.slug]);
        if (!f.rows.length) return res.status(404).render('public-form-notfound', { seo: {} });
        res.render('public-form', { form: f.rows[0], seo: {}, error: null });
    } catch (err) { console.error('Public form error:', err); res.status(500).send('Error loading form'); }
});

app.post('/form/:slug', async (req, res) => {
    try {
        const f = await pool.query('SELECT * FROM pub_forms WHERE slug = $1', [req.params.slug]);
        if (!f.rows.length) return res.status(404).send('Form not found');
        const form = f.rows[0];
        const fields = form.fields || [];
        const data = {};
        for (const fld of fields) {
            let v = req.body['f_' + fld.id];
            if (fld.type === 'number') {
                v = v === '' || v === null || v === undefined ? NaN : parseFloat(v);
                if (isNaN(v) || v < 0 || v > 100) {
                    return res.status(400).render('public-form', { form, seo: {}, error: 'Invalid score for "' + fld.label + '". Scores must be between 0 and 100.' });
                }
            } else {
                v = (v || '').toString().trim();
            }
            if (fld.required && (v === '' || v === null || v === undefined || (fld.type === 'number' && isNaN(v)))) {
                return res.status(400).render('public-form', { form, seo: {}, error: 'Please fill the required field: "' + fld.label + '"' });
            }
            data[fld.id] = v;
        }
        await pool.query('INSERT INTO pub_responses (form_id, data) VALUES ($1, $2)', [form.id, JSON.stringify(data)]);
        res.render('public-form-thanks', { form, seo: {} });
    } catch (err) { console.error('Public form submit error:', err); res.status(500).send('Error saving response'); }
});

app.get('/admin/forms', isAdmin, async (req, res) => {
    try {
        const forms = await pool.query(`
            SELECT f.id, f.slug, f.title, f.description, f.fields, f.created_at,
                   (SELECT COUNT(*) FROM pub_responses r WHERE r.form_id = f.id) AS response_count
            FROM pub_forms f
            ORDER BY f.created_at DESC`);
        const list = forms.rows.map(f => ({
            id: f.id, slug: f.slug, title: f.title,
            description: f.description, created_at: f.created_at,
            response_count: parseInt(f.response_count),
            field_count: Array.isArray(f.fields) ? f.fields.length : 0
        }));
        res.render('admin/forms', { forms: list, msg: req.query.msg || null });
    } catch (err) { console.error('Admin forms error:', err); res.status(500).send('Error'); }
});

app.post('/admin/forms', isAdmin, async (req, res) => {
    try {
        const title = (req.body.title || '').trim() || 'Untitled Form';
        const description = (req.body.description || '').trim();
        const fields = req.body.fields === 'empty' ? [] : napFields();
        let slug = genFormSlug();
        let dup = await pool.query('SELECT id FROM pub_forms WHERE slug = $1', [slug]);
        while (dup.rows.length) { slug = genFormSlug(); dup = await pool.query('SELECT id FROM pub_forms WHERE slug = $1', [slug]); }
        const f = await pool.query(
            'INSERT INTO pub_forms (slug, title, description, fields) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
            [slug, title, description, JSON.stringify(fields)]
        );
        res.redirect('/admin/forms/' + f.rows[0].id);
    } catch (err) { console.error('Create form error:', err); res.redirect('/admin/forms?msg=error'); }
});

app.get('/admin/forms/:id', isAdmin, async (req, res) => {
    try {
        const f = await pool.query('SELECT * FROM pub_forms WHERE id = $1', [req.params.id]);
        if (!f.rows.length) return res.redirect('/admin/forms');
        const responses = await pool.query(
            'SELECT * FROM pub_responses WHERE form_id = $1 ORDER BY created_at DESC', [f.rows[0].id]
        );
        const link = `${req.protocol}://${req.get('host')}/form/${f.rows[0].slug}`;
        res.render('admin/form-edit', {
            form: f.rows[0], responses: responses.rows, link, msg: req.query.msg || null
        });
    } catch (err) { console.error('Form edit error:', err); res.status(500).send('Error'); }
});

app.post('/admin/forms/:id', isAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const title = (req.body.title || '').trim();
        if (!title) return res.redirect('/admin/forms/' + id + '?msg=' + encodeURIComponent('Title is required'));
        const description = (req.body.description || '').trim();
        const labels = Array.isArray(req.body.label) ? req.body.label : [req.body.label];
        const types = Array.isArray(req.body.type) ? req.body.type : [req.body.type];
        const ids = Array.isArray(req.body.fid) ? req.body.fid : [req.body.fid];
        const reqVals = Array.isArray(req.body.required)
            ? req.body.required.map(String)
            : (req.body.required !== undefined ? [String(req.body.required)] : []);
        const fields = [];
        for (let i = 0; i < labels.length; i++) {
            const label = (labels[i] || '').trim();
            if (!label) continue;
            fields.push({
                id: ids[i] || ('field_' + Date.now() + '_' + i),
                label,
                type: types[i] === 'number' ? 'number' : 'text',
                required: reqVals.includes(String(i)) ? true : false
            });
        }
        await pool.query(
            'UPDATE pub_forms SET title = $1, description = $2, fields = $3::jsonb, updated_at = NOW() WHERE id = $4',
            [title, description, JSON.stringify(fields), id]
        );
        res.redirect('/admin/forms/' + id + '?msg=' + encodeURIComponent('Form saved'));
    } catch (err) { console.error('Save form error:', err); res.redirect('/admin/forms/' + req.params.id + '?msg=error'); }
});

app.post('/admin/forms/:id/delete', isAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        await pool.query('DELETE FROM pub_responses WHERE form_id = $1', [id]);
        await pool.query('DELETE FROM pub_forms WHERE id = $1', [id]);
        res.redirect('/admin/forms');
    } catch (err) { console.error('Delete form error:', err); res.redirect('/admin/forms'); }
});

app.post('/admin/forms/:id/response/:rid/delete', isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM pub_responses WHERE id = $1 AND form_id = $2', [req.params.rid, req.params.id]);
        res.redirect('/admin/forms/' + req.params.id);
    } catch (err) { console.error('Delete response error:', err); res.redirect('/admin/forms/' + req.params.id); }
});

app.get('/admin/forms/:id/export', isAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const f = await pool.query('SELECT * FROM pub_forms WHERE id = $1', [id]);
        if (!f.rows.length) return res.status(404).send('Form not found');
        const form = f.rows[0];
        const responses = await pool.query(
            'SELECT * FROM pub_responses WHERE form_id = $1 ORDER BY created_at ASC', [id]
        );
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet((form.title || 'Responses').slice(0, 31));
        const fields = form.fields || [];
        const headers = ['S/N', 'Submitted'].concat(fields.map(fld => fld.label));
        ws.getRow(1).values = headers;
        const headRow = ws.getRow(1);
        headRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
        headRow.alignment = { vertical: 'middle' };
        ws.columns.forEach(col => { col.width = 20; });
        ws.getColumn(1).width = 6;
        responses.rows.forEach((r, i) => {
            const data = r.data || {};
            ws.addRow([i + 1, new Date(r.created_at).toLocaleString('en-GB')].concat(fields.map(fld => data[fld.id] !== undefined ? data[fld.id] : '')));
        });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="' + form.slug + '-responses.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (err) { console.error('Export error:', err); res.status(500).send('Export failed'); }
});

app.post('/ambassador/register', async (req, res) => {
    return res.status(403).json({ success: false, error: 'Refer & Earn is currently disabled' });
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
    const { attemptId, answers } = req.body;
    const userId = sessionUser.id;
    const username = sessionUser.fullname;

    try {
        const attempt = await pool.query(
            'SELECT id, questions FROM daily_challenge_attempts WHERE id = $1 AND user_id = $2 AND completed = false',
            [attemptId, userId]
        );
        if (!attempt.rows[0]) return res.status(403).json({ error: 'No active challenge.' });

        const questions = Array.isArray(attempt.rows[0].questions) ? attempt.rows[0].questions : [];
        if (!Array.isArray(answers) || answers.length !== questions.length) {
            return res.status(400).json({ error: 'Invalid answers submitted.' });
        }

        // Score is computed server-side from the stored answer key; never trust the client.
        let score = 0;
        questions.forEach((q, i) => {
            const given = typeof answers[i] === 'string' ? answers[i].trim().toUpperCase() : '';
            const correct = String(q.correct_option || '').trim().toUpperCase();
            if (given && given === correct) score += 10;
        });

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

        // Award XP through the shared traceable ledger (duplicate-proof).
        try { await awardDailyChallengeXP(userId, attemptId, score, questions.length); } catch (e) {
            console.error('[XP] daily challenge award:', e.message);
        }

        // Holiday Mode: a completed daily challenge counts toward 'challenges'
        // holiday goals (no-op unless Holiday Mode is active).
        await progressHolidayGoalsByType(userId, 'challenges', 1);

        res.json({ success: true, score });
    } catch (err) {
        console.error("ARENA_SUBMIT_ERROR:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/admin/analytics', isAdmin, async (req, res) => {
    try {
        const r = parseInt(req.query.range, 10);
        const rangeDays = [7, 30, 90].includes(r) ? r : 30;
        const interval = rangeDays > 0 ? `NOW() - INTERVAL '${rangeDays} days'` : null;
        const rangeFilter = interval ? ` > ${interval}` : ' IS NOT NULL';
        const rangeOn = (col) => interval ? ` ${col} > ${interval}` : ` COALESCE(${col}, NOW()) IS NOT NULL`;

        const [totals, signupTrend, activeUsers, examStats, hardest, subjectWeak, pages, coupons, revenue, today, streakLeaders, arenaToday, uniSignups] = await Promise.all([
            pool.query(`SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE created_at ${rangeFilter}) as new_users,
                (SELECT COUNT(*) FROM users WHERE has_paid = true) as premium_users,
                (SELECT COUNT(*) FROM users WHERE has_paid = true AND created_at ${rangeFilter}) as new_premium,
                (SELECT
                    (SELECT COUNT(*) FROM quiz_results WHERE created_at ${rangeFilter})
                  + (SELECT COUNT(*) FROM study_quiz_attempts WHERE created_at ${rangeFilter})
                  + (SELECT COUNT(*) FROM daily_challenge_attempts WHERE created_at ${rangeFilter})
                  + (SELECT COUNT(*) FROM renaissance_attempts WHERE status = 'submitted' AND submitted_at ${rangeFilter})) as assessments,
                (SELECT COALESCE(AVG(pct), 0) FROM (
                    SELECT percentage::numeric as pct FROM quiz_results WHERE created_at ${rangeFilter}
                    UNION ALL
                    SELECT (score::numeric / NULLIF(total, 0)) * 100 FROM study_quiz_attempts WHERE created_at ${rangeFilter}
                    UNION ALL
                    SELECT (score::numeric / NULLIF(total, 0)) * 100 FROM daily_challenge_attempts WHERE created_at ${rangeFilter}
                    UNION ALL
                    SELECT percentage::numeric FROM renaissance_attempts WHERE status = 'submitted' AND submitted_at ${rangeFilter}
                ) x) as avg_score,
                (SELECT COUNT(*) FROM (
                    SELECT 1 FROM quiz_results WHERE created_at ${rangeFilter} AND percentage >= 50
                    UNION ALL SELECT 1 FROM study_quiz_attempts WHERE created_at ${rangeFilter} AND score::numeric / NULLIF(total, 0) >= 0.5
                    UNION ALL SELECT 1 FROM daily_challenge_attempts WHERE created_at ${rangeFilter} AND score::numeric / NULLIF(total, 0) >= 0.5
                    UNION ALL SELECT 1 FROM renaissance_attempts WHERE status = 'submitted' AND submitted_at ${rangeFilter} AND percentage >= 50
                ) p) as passed,
                (SELECT COALESCE(SUM(elapsed_seconds), 0) / 60 FROM study_sessions WHERE status = 'completed' AND created_at ${rangeFilter}) as study_minutes`),

            pool.query(`SELECT TO_CHAR(created_at, 'DD Mon') as date, COUNT(*) as count
                        FROM users WHERE created_at ${rangeFilter}
                        GROUP BY date ORDER BY MIN(created_at) ASC`),

            pool.query(`SELECT u.fullname, u.email, un.name as university,
                       SUM(a.actions) as actions,
                       COALESCE(SUM(a.actions) FILTER (WHERE a.src = 'quiz'), 0) as quizzes,
                       COALESCE(SUM(a.actions) FILTER (WHERE a.src = 'exam'), 0) as exams,
                       COALESCE(SUM(a.actions) FILTER (WHERE a.src = 'study'), 0) as study_sessions
                       FROM users u
                       LEFT JOIN universities un ON un.id = u.university_id
                       INNER JOIN (
                           SELECT user_id, 'quiz' src, COUNT(*) actions FROM quiz_results WHERE created_at ${rangeFilter} GROUP BY user_id
                           UNION ALL SELECT user_id, 'exam', COUNT(*) FROM renaissance_attempts WHERE status = 'submitted' AND submitted_at ${rangeFilter} GROUP BY user_id
                           UNION ALL SELECT user_id, 'study', COUNT(*) FROM study_sessions WHERE status = 'completed' AND created_at ${rangeFilter} GROUP BY user_id
                           UNION ALL SELECT user_id, 'task', COUNT(*) FROM daily_task_items WHERE is_done = true AND created_at ${rangeFilter} GROUP BY user_id
                           UNION ALL SELECT user_id, 'daily', COUNT(*) FROM daily_challenge_attempts WHERE created_at ${rangeFilter} GROUP BY user_id
                       ) a ON a.user_id = u.id
                       GROUP BY u.id, un.name
                       ORDER BY actions DESC LIMIT 10`),

            pool.query(`SELECT e.id, e.title,
                       COUNT(a.id) as attempts,
                       ROUND(COALESCE(AVG(a.percentage), 0)) as avg_pct,
                       MAX(a.percentage) as best
                       FROM renaissance_exams e
                       INNER JOIN renaissance_attempts a ON a.exam_id = e.id AND a.status = 'submitted'
                       WHERE a.submitted_at ${rangeFilter}
                       GROUP BY e.id, e.title
                       ORDER BY attempts DESC LIMIT 10`),

            pool.query(`SELECT e.title as exam_title, q.id, LEFT(q.question_text, 120) as question_text,
                       q.correct_answer, COUNT(a.id) as answered,
                       COUNT(*) FILTER (WHERE UPPER(TRIM(a.answers->>CAST(q.id AS text))) = UPPER(TRIM(q.correct_answer))) as correct
                       FROM renaissance_questions q
                       INNER JOIN renaissance_exams e ON e.id = q.exam_id
                       INNER JOIN renaissance_attempts a ON a.exam_id = q.exam_id AND a.status = 'submitted'
                       WHERE a.submitted_at ${rangeFilter} AND q.question_type = 'mcq'
                       GROUP BY q.id, e.title
                       HAVING COUNT(a.id) >= 3
                       ORDER BY (COUNT(*) FILTER (WHERE UPPER(TRIM(a.answers->>CAST(q.id AS text))) = UPPER(TRIM(q.correct_answer))))::float / COUNT(a.id) ASC, COUNT(a.id) DESC
                       LIMIT 8`),

            pool.query(`SELECT s.name as subject, COUNT(*) as attempts, ROUND(AVG(qr.percentage)) as avg_pct
                       FROM quiz_results qr
                       INNER JOIN subjects s ON s.id = qr.subject_id
                       WHERE qr.created_at ${rangeFilter}
                       GROUP BY s.name
                       ORDER BY avg_pct ASC LIMIT 8`),

            pool.query(`SELECT page_path, COUNT(*) as views FROM page_views
                       WHERE visit_time ${rangeFilter}
                       GROUP BY page_path ORDER BY views DESC LIMIT 8`).catch(() => ({ rows: [] })),

            pool.query(`SELECT code, discount_type, discount_value, times_used, max_uses, is_active
                       FROM coupons ORDER BY times_used DESC LIMIT 10`),

            pool.query(`SELECT COUNT(*) as payments, COALESCE(SUM(amount), 0) as revenue,
                       COUNT(*) FILTER (WHERE coupon_code IS NOT NULL) as coupon_paid
                       FROM payments WHERE status = 'success' AND ${rangeOn('verified_at')}`),

            pool.query(`SELECT
                       (SELECT COUNT(*) FROM (
                           SELECT user_id FROM login_history WHERE login_at > NOW() - INTERVAL '24 hours'
                           UNION SELECT user_id FROM quiz_results WHERE created_at > NOW() - INTERVAL '24 hours'
                           UNION SELECT user_id FROM study_sessions WHERE created_at > NOW() - INTERVAL '24 hours'
                           UNION SELECT user_id FROM renaissance_attempts WHERE status = 'submitted' AND submitted_at > NOW() - INTERVAL '24 hours'
                           UNION SELECT user_id FROM daily_challenge_attempts WHERE created_at > NOW() - INTERVAL '24 hours'
                       ) t) as active_today,
                       (SELECT COUNT(*) FROM login_history WHERE login_at > NOW() - INTERVAL '24 hours') as logins_today,
                       (SELECT COUNT(*) FROM daily_task_items WHERE task_date = CURRENT_DATE AND is_done = true) as tasks_done,
                       (SELECT COUNT(*) FROM daily_task_items WHERE task_date = CURRENT_DATE) as tasks_total`),

            pool.query(`SELECT u.fullname, MAX(ls.current_streak) as current_streak, MAX(ls.longest_streak) as longest_streak
                       FROM login_streaks ls
                       INNER JOIN users u ON u.id = ls.user_id
                       WHERE ls.current_streak > 0
                       GROUP BY u.id, u.fullname
                       ORDER BY current_streak DESC, longest_streak DESC LIMIT 6`),

            pool.query(`SELECT username, current_daily_score, monthly_score, streak
                       FROM daily_leaderboard
                       ORDER BY current_daily_score DESC, monthly_score DESC LIMIT 5`),

            pool.query(`SELECT un.name as university, COUNT(u.id) as signups
                       FROM users u
                       LEFT JOIN universities un ON un.id = u.university_id
                       WHERE u.created_at ${rangeFilter}
                       GROUP BY un.name ORDER BY signups DESC LIMIT 6`)
        ]);

        const s = totals.rows[0];

        res.render('admin/analytics', {
            rangeDays,
            signups: { daily: s.daily_signups, weekly: s.weekly_signups },
            stats: {
                total_users: s.total_users || 0,
                new_users: s.new_users || 0,
                premium_users: s.premium_users || 0,
                new_premium: s.new_premium || 0,
                assessments: s.assessments || 0,
                avg_score: Math.min(100, Math.round((s.avg_score || 0) * 10) / 10),
                passed: s.passed || 0,
                pass_rate: s.assessments ? Math.round(((s.passed || 0) / s.assessments) * 100) : 0,
                study_minutes: s.study_minutes || 0
            },
            today: today.rows[0] || { active_today: 0, logins_today: 0, tasks_done: 0, tasks_total: 0 },
            streakLeaders: streakLeaders.rows,
            arenaToday: arenaToday.rows,
            revenue: { real: revenue.rows[0] || { payments: 0, revenue: 0, coupon_paid: 0 } },
            coupons: coupons.rows,
            activeUsers: activeUsers.rows,
            examStats: examStats.rows,
            hardest: hardest.rows,
            subjectWeak: subjectWeak.rows,
            uniSignups: uniSignups.rows,
            chartData: {
                labels: signupTrend.rows.map(r => r.date),
                values: signupTrend.rows.map(r => r.count),
                examLabels: examStats.rows.map(r => (r.title || 'Exam').slice(0, 18)),
                examValues: examStats.rows.map(r => r.attempts)
            },
            pages: pages.rows,
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

app.post('/upload-pdf', isAuth, requirePaid, rateLimit(10, 60000), uploadMemory.single('lecture_note'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded." });
        }

        // memoryStorage gives us req.file.buffer, not a file path
        const pdfBuffer = req.file.buffer;

        const text = await extractPdfText(pdfBuffer);
        if (!text) {
            return res.status(500).json({ success: false, message: "Failed to parse PDF." });
        }
        console.log("Extracted text successfully.");
        res.json({ success: true, text: text });

    } catch (err) {
        console.error("Route Error:", err);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

function buildCGPA(profile, courses) {
    // Delegates to the shared, trusted calculation module (lib/cgpa.js) so the
    // tracker, forecasts, AI context and transcripts always agree.
    return cgpaLib.computeCGPA({
        scale: profile.grading_scale,
        prevUnits: profile.prev_units,
        prevPoints: profile.prev_gp,
        courses
    });
}

// A. GET: DASHBOARD LOADER
app.get('/cgpa', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
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
            `SELECT id, id AS _id, course_code AS code, title, credit_units, grade, 
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
        console.error(err.stack);
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

// B2. POST: UPDATE EXISTING PROFILE (edit department / level / scale / balance)
app.post('/cgpa/profile/update', isAuth, requirePaid, async (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.id) {
        return res.redirect('/login');
    }
    const userId = req.session.user.id;
    const { department, current_level, grading_scale, prev_cgpa, prev_units } = req.body;

    const scale = parseInt(grading_scale) === 4 ? 4 : 5;
    const level = parseInt(current_level) || 300;
    const dept  = department ? String(department).trim() : 'General';

    try {
        // Optional: update the carry-forward balance only when balance fields are submitted
        const wantsBalance = req.body.hasOwnProperty('prev_cgpa') && req.body.hasOwnProperty('prev_units');
        if (wantsBalance) {
            const pUnits = Math.max(0, parseInt(prev_units) || 0);
            const pCGPA  = Math.min(Math.max(parseFloat(prev_cgpa) || 0, 0), scale);
            const pGP    = parseFloat((pCGPA * pUnits).toFixed(2));
            await pool.query(
                `UPDATE public.cgpa_profiles
                 SET department = $1, current_level = $2, grading_scale = $3,
                     prev_units = $4, prev_cgpa = $5, prev_gp = $6, updated_at = NOW()
                 WHERE user_id = $7`,
                [dept, level, scale, pUnits, pCGPA, pGP, userId]
            );
        } else {
            await pool.query(
                `UPDATE public.cgpa_profiles
                 SET department = $1, current_level = $2, grading_scale = $3, updated_at = NOW()
                 WHERE user_id = $4`,
                [dept, level, scale, userId]
            );
        }
        await pool.query('UPDATE users SET current_level = $1 WHERE id = $2', [level, userId]);

        res.redirect('/cgpa?msg=Profile updated successfully!');
    } catch (err) {
        console.error('CGPA Profile Update Error:', err);
        res.redirect('/cgpa?msg=Profile update failed. Please try again.');
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
app.post('/api/cgpa/course/add-ajax', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
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

// 2C. AJAX IMPORT COURSES FROM CSV (bulk add)
app.post('/api/cgpa/course/import-csv', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
    try {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.json({ success: false, error: 'Not authenticated' });
        }
        const userId = req.session.user.id;
        const csv = (req.body && req.body.csv) ? String(req.body.csv) : '';
        if (!csv.trim()) return res.json({ success: false, error: 'No CSV data provided' });

        const profileRes = await pool.query(
            'SELECT current_level, grading_scale FROM public.cgpa_profiles WHERE user_id = $1', [userId]
        );
        const profile = profileRes.rows[0];
        const defaultLevel = profile ? (parseInt(profile.current_level) || 300) : 300;
        const scale = profile ? (parseInt(profile.grading_scale) || 5) : 5;
        const allowedGrades = scale === 5 ? ['A', 'B', 'C', 'D', 'E', 'F'] : ['A', 'B', 'C', 'D', 'F'];

        const seen = new Set();
        const existing = await pool.query(
            'SELECT course_code FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false', [userId]
        );
        existing.rows.forEach(r => seen.add(String(r.course_code).trim().toUpperCase()));

        const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        let imported = 0, skipped = 0;

        for (const raw of lines) {
            const parts = raw.split(',').map(p => p.trim());
            if (!parts[0]) { skipped++; continue; }
            if (/^course[_ ]?code$/i.test(parts[0])) { skipped++; continue; }

            const code = parts[0].toUpperCase();
            const title = parts[1] || 'Course Module';
            const units = parseInt(parts[2]) || 3;
            const grade = (parts[3] || 'A').trim().toUpperCase();
            const level = parseInt(parts[4]) || defaultLevel;
            const semester = parseInt(parts[5]) || 1;

            if (seen.has(code)) { skipped++; continue; }
            if (units < 1 || units > 8) { skipped++; continue; }
            if (!allowedGrades.includes(grade)) { skipped++; continue; }

            await pool.query(
                `INSERT INTO public.cgpa_courses
                 (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)`,
                [userId, code, title, level, semester, units, grade]
            );
            seen.add(code);
            imported++;
        }

        res.json({ success: true, imported, skipped });
    } catch (err) {
        console.error('CSV Import Error:', err);
        res.status(500).json({ success: false, error: 'Error importing courses' });
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

// Background jobs only run on a long-lived server, not on serverless functions.
if (!process.env.VERCEL) {
    // Run the deadline checker every 5 minutes
    const deadlineTimer = setInterval(checkDeadlineNotifications, 5 * 60 * 1000);
    if (deadlineTimer.unref) deadlineTimer.unref();
    // Also run once on startup (after a short delay to let the server fully start)
    const deadlineBoot = setTimeout(checkDeadlineNotifications, 10000);
    if (deadlineBoot.unref) deadlineBoot.unref();
}

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
// Check every 30 minutes (long-running servers only)
if (!process.env.VERCEL) {
    const leaderboardTimer = setInterval(resetWeeklyLeaderboard, 30 * 60 * 1000);
    if (leaderboardTimer.unref) leaderboardTimer.unref();
    const leaderboardBoot = setTimeout(resetWeeklyLeaderboard, 5000);
    if (leaderboardBoot.unref) leaderboardBoot.unref();
}

// ======================== STUDY HUB ROUTES ========================

// Study AI helper — uses OpenRouter
function cleanAiText(t) {
  if (t == null) return '';
  var s = String(t);
  // Protect LaTeX math and code blocks so the markdown cleaners below never strip subscripts/superscripts (e.g. x_{i}, H_{2}O)
  var keep = [];
  s = s.replace(/(```[\s\S]*?```)|(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))|(\$\$[\s\S]*?\$\$)|(\$[^$\n]*?\$)/g, function(m){
    keep.push(m);
    return '\u0000M' + (keep.length - 1) + '\u0000';
  });
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
  s = s.replace(/\u0000M(\d+)\u0000/g, function(m, i){ return keep[parseInt(i)]; });
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
// No insecure defaults: the manager stays disabled unless both are configured.
const DB_PIN = process.env.DB_MANAGER_PIN;
const DB_PASS = process.env.DB_MANAGER_PASS;

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
  if (!DB_PIN || !DB_PASS) {
    return res.status(503).json({ success: false, error: 'DB manager is not configured' });
  }
  const { pin, password } = req.body;
  if (safeEqual(pin, DB_PIN) && safeEqual(password, DB_PASS)) {
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
    const ident = (v) => String(v || '').replace(/[^a-zA-Z0-9_]/g, '');
    const safeTable = ident(table);
    const safePk = ident(pkCol);
    const safeCols = (Array.isArray(columns) ? columns : []).map(ident).filter(c => c && c !== safePk);
    if (!safeTable || !safePk || !safeCols.length) {
      return res.status(400).json({ success: false, error: 'Invalid table, primary key, or columns' });
    }
    const sets = safeCols.map((c, i) => `"${c}" = $${i + 1}`);
    const vals = safeCols.map(c => row[c] === '' ? null : row[c]);
    vals.push(pkVal);
    await pool.query(`UPDATE "${safeTable}" SET ${sets.join(', ')} WHERE "${safePk}" = $${vals.length}`, vals);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/admin/db-manager/query', isAdmin, async (req, res) => {
  try {
    const sql = String(req.body.sql || '').trim().replace(/;\s*$/, '');
    // Only a single read-only statement; block stacking, comments and file/system functions.
    if (!/^\s*(select|show|describe)\b/i.test(sql) || /;/.test(sql) || /--|\/\*/.test(sql) ||
        /\b(pg_read_file|pg_ls_dir|pg_read_binary_file|lo_import|lo_export|copy|dblink)\b/i.test(sql)) {
      return res.status(400).json({ success: false, error: 'Only a single read-only SELECT/SHOW/DESCRIBE query is allowed' });
    }
    const result = await pool.query(sql);
    const columns = result.fields ? result.fields.map(f => f.name) : [];
    res.json({ success: true, rows: result.rows, columns });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== GAMES HUB ====================
const GAME_TYPES = ['sudoku', 'scramble', 'chess', 'crossword'];
const GAME_OUTCOMES = ['win', 'loss', 'draw', 'completed', 'abandoned'];
const GAME_XP = { sudoku: 40, scramble: 30, chess: 60, crossword: 50 };
const XP_DIFF_MULT = { easy: 1, medium: 1.5, hard: 2.25 };

function levelForXp(xp) {
    return Math.floor(Math.sqrt(Math.max(0, xp || 0) / 100)) + 1;
}
function xpForLevel(level) {
    return 100 * Math.pow(Math.max(1, level) - 1, 2);
}

(async function initGameResults() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS game_results (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      game VARCHAR(20) NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      outcome VARCHAR(20) NOT NULL DEFAULT 'completed',
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_results_user ON game_results(user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_results_game ON game_results(user_id, game, score DESC)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER NOT NULL DEFAULT 0`);
    console.log('[Games] Results table ready');
  } catch (e) { console.error('[Games] Init:', e.message); }
})();

async function getGameStats(userId) {
  const stats = await pool.query(
    `SELECT game,
            COUNT(*)::int AS plays,
            COALESCE(MAX(score), 0)::int AS best_score,
            COALESCE(SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END), 0)::int AS wins,
            MAX(created_at) AS last_played
     FROM game_results WHERE user_id = $1 GROUP BY game`,
    [userId]
  );
  const recent = await pool.query(
    `SELECT id, game, score, outcome, duration_seconds, metadata, created_at
     FROM game_results WHERE user_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [userId]
  );
  return { stats: stats.rows, recent: recent.rows };
}

app.get('/api/games/stats', isAuth, async (req, res) => {
  try {
    const me = await pool.query('SELECT COALESCE(xp, 0) AS xp FROM users WHERE id = $1', [req.session.user.id]);
    const xp = me.rows[0] ? me.rows[0].xp : 0;
    const level = levelForXp(xp);
    res.json({ success: true, ...(await getGameStats(req.session.user.id)), xp, level, next_level_xp: xpForLevel(level + 1), current_level_xp: xpForLevel(level) });
  } catch (e) {
    console.error('[Games] Stats error:', e.message);
    res.status(500).json({ success: false, error: 'Could not load game stats' });
  }
});

app.get('/api/games/history', isAuth, async (req, res) => {
  try {
    const game = String(req.query.game || '');
    const params = [req.session.user.id];
    let sql = `SELECT id, game, score, outcome, duration_seconds, metadata, created_at
               FROM game_results WHERE user_id = $1`;
    if (GAME_TYPES.includes(game)) { params.push(game); sql += ' AND game = $2'; }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    const r = await pool.query(sql, params);
    res.json({ success: true, history: r.rows });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Could not load game history' });
  }
});

app.post('/api/games/result', isAuth, async (req, res) => {
  try {
    const { game, score, outcome, duration, metadata } = req.body || {};
    if (!GAME_TYPES.includes(game)) {
      return res.status(400).json({ success: false, error: 'Unknown game' });
    }
    const safeScore = Math.max(0, Math.min(1000000, parseInt(score, 10) || 0));
    const safeDuration = Math.max(0, Math.min(86400, parseInt(duration, 10) || 0));
    const safeOutcome = GAME_OUTCOMES.includes(outcome) ? outcome : 'completed';
    let meta = {};
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      meta = metadata;
    }
    const metaJson = JSON.stringify(meta);
    if (metaJson.length > 4096) {
      return res.status(400).json({ success: false, error: 'Metadata too large' });
    }

    const inserted = await pool.query(
      `INSERT INTO game_results (user_id, game, score, outcome, duration_seconds, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [req.session.user.id, game, safeScore, safeOutcome, safeDuration, metaJson]
    );

    const difficulty = String((meta && meta.difficulty) || '').toLowerCase();
    const mult = XP_DIFF_MULT[difficulty] || 1;
    const base = GAME_XP[game] || 30;
    let xpDelta = 0;
    if (safeOutcome === 'win' || safeOutcome === 'completed') {
      xpDelta = Math.round(base * mult) + Math.floor(safeScore / 100);
    } else if (safeOutcome === 'draw') {
      xpDelta = Math.round(base * mult * 0.4);
    } else {
      xpDelta = -Math.round(base * 0.25);
    }
    const xpRow = await pool.query(
      'UPDATE users SET xp = GREATEST(0, COALESCE(xp, 0) + $1) WHERE id = $2 RETURNING xp',
      [xpDelta, req.session.user.id]
    );
    const totalXp = xpRow.rows[0] ? xpRow.rows[0].xp : 0;

    res.json({
      success: true,
      id: inserted.rows[0].id,
      created_at: inserted.rows[0].created_at,
      score: safeScore,
      xp_gained: xpDelta,
      xp: totalXp,
      level: levelForXp(totalXp)
    });
  } catch (e) {
    console.error('[Games] Save error:', e.message);
    res.status(500).json({ success: false, error: 'Could not save result' });
  }
});

app.get('/games', isAuth, async (req, res) => {
  res.locals.seo.title = 'Prepium | Games Hub';
  res.render('games', { user: req.session.user });
});

app.get('/games/sudoku', isAuth, async (req, res) => { res.render('games-sudoku', { user: req.session.user }); });
app.get('/games/scramble', isAuth, async (req, res) => { res.render('games-scramble', { user: req.session.user }); });
app.get('/games/chess', isAuth, async (req, res) => { res.render('games-chess', { user: req.session.user }); });
app.get('/games/crossword', isAuth, async (req, res) => { res.render('games-crossword', { user: req.session.user }); });

app.get('/study', isAuth, requirePaid, featureLock('study'), async (req, res) => {
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

app.post('/api/study/topics/update', isAuth, requirePaid, async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10);
    const completed = !!req.body.completed;
    if (!id) return res.status(400).json({ success: false, error: 'Invalid topic' });
    const r = await pool.query(
      'UPDATE study_topics SET completed = $1 WHERE id = $2 AND user_id = $3 RETURNING id, completed',
      [completed, id, req.session.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Topic not found' });
    res.json({ success: true, topic: r.rows[0] });
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
app.post('/api/study/subtopics/ai-generate', isAuth, requirePaid, rateLimit(12, 60000), async (req, res) => {
  try {
    const { topicId, courseId, topicTitle, courseName, courseCode } = req.body;
    const prompt = `For the topic "${topicTitle}" in the course "${courseName}"${courseCode ? ' (' + courseCode + ')' : ''}, generate between 8 and 15 RELEVANT subtopics that cover the most important aspects of this topic within this specific course. Only include subtopics that are genuinely relevant to this course and topic — do NOT pad the list, do NOT generate more than 15, and aim for at least 8. Arrange them from foundational concepts first to more advanced aspects later. Return a JSON array of strings. Do NOT wrap in markdown code blocks. ONLY output raw JSON.`;
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
    const seen = {};
    for (const st of subtopics.slice(0, 15)) {
      const cleanName = st.replace(/^["'\s]+|["'\s]+$/g, '').trim();
      const key = cleanName.toLowerCase();
      if (!cleanName || seen[key]) continue;
      seen[key] = true;
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

app.post('/api/study/subtopic/:id/content', isAuth, requirePaid, rateLimit(12, 60000), async (req, res) => {
  try {
    const st = await pool.query('SELECT * FROM study_subtopics WHERE id = $1', [req.params.id]);
    if (!st.rows[0]) return res.json({ success: false, error: 'Not found' });
    const s = st.rows[0];
    const topic = await pool.query('SELECT * FROM study_topics WHERE id = $1', [s.topic_id]).catch(() => ({ rows: [] }));
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [s.course_id || 0]).catch(() => ({ rows: [] }));
    const topicName = topic.rows[0] ? (topic.rows[0].topic_name || topic.rows[0].title) : 'General';
    const courseName = course.rows[0] ? (course.rows[0].course_name || '') : '';
    const courseCode = course.rows[0] ? (course.rows[0].course_code || '') : '';
    const courseCtx = courseName + (courseCode ? ' (' + courseCode + ')' : '');
    const prompt = `You are an expert university professor giving a complete, in-depth lecture on "${s.subtopic_name || s.title}", which is part of the topic "${topicName}" in the course "${courseCtx}". Base EVERYTHING in this lecture strictly on this specific course and topic — stay focused on exactly what students of "${courseCtx}" learn under "${topicName}", and never drift into unrelated or generic material. Your goal is to make the learner truly master this exact topic within this course — full understanding, not surface memorization. Write extensively, with rich detail, explicit explanations, and thorough reasoning in every section.

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
      const shortPrompt = `You are an expert professor giving an in-depth lecture on "${s.subtopic_name || s.title}", which is part of the topic "${topicName}" in the course "${courseCtx}". Base the lecture strictly on this specific course and topic. Write a thorough, comprehensive explanation covering: prerequisites in detail, real-world importance with concrete applications, plain explanation with vivid analogies, key terms with definitions, fully worked step-by-step examples, common mistakes with explicit wrong/right contrasts, edge cases, and practice questions with full worked solutions. Use these section headers exactly: "What You Should Know:", "Why It Matters:", "Plain Explanation:", "Key Terms:", "Step-by-Step Examples:", "Common Mistakes:", "Edge Cases:", "Practice Questions:", "Step-by-Step Solutions:". Use plain text with LaTeX math \\( \\) and \\[ \\]. Include a Mermaid diagram in a mermaid code block if it helps clarify relationships. Be thorough, explicit, and detailed — minimum 6-10 lines per section. Do not summarize.`;
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
    const topic = await pool.query('SELECT * FROM study_topics WHERE id = $1', [s.topic_id]).catch(() => ({ rows: [] }));
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [s.course_id || 0]).catch(() => ({ rows: [] }));
    const topicName = topic.rows[0] ? (topic.rows[0].topic_name || topic.rows[0].title) : 'General';
    const courseName = course.rows[0] ? (course.rows[0].course_name || '') : '';
    const courseCode = course.rows[0] ? (course.rows[0].course_code || '') : '';
    const courseCtx = courseName + (courseCode ? ' (' + courseCode + ')' : '');
    const prompt = `You are a university tutor. The student is studying "${s.subtopic_name || s.title}", which is part of the topic "${topicName}" in the course "${courseCtx}". Base your answer on this specific course and topic and on the explanation the student has just read:\n\n"""\n${content.slice(0, 5000)}\n"""\n\nThe student now asks:\n"${question}"\n\nAnswer their question clearly and concisely, building on the explanation above and staying focused on "${courseCtx}" — "${topicName}". Use PLAIN TEXT only. If they ask for clarification, re-explain simply. If they ask something beyond the explanation, use your knowledge to help but keep it relevant to this course and topic. Separate paragraphs with blank lines. Use LaTeX math delimiters \\( \\) for inline and \\[ \\] for display math when needed.`;
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

app.post('/api/study/session/summarize', isAuth, requirePaid, rateLimit(12, 60000), async (req, res) => {
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
app.post('/api/study/chat', isAuth, requirePaid, rateLimit(20, 60000), async (req, res) => {
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
    try {
      var extracted = extractJsonItems(aiRes.text);
      terms = JSON.parse(extracted);
      if (!Array.isArray(terms)) terms = (terms && (terms.items || terms.terms || terms.queries)) || [searchQuery];
    } catch { terms = [searchQuery]; }
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
app.post('/api/study/quiz/generate', isAuth, requirePaid, rateLimit(12, 60000), async (req, res) => {
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
app.post('/api/study/flashcards/generate', isAuth, requirePaid, rateLimit(12, 60000), async (req, res) => {
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
app.post('/api/cgpa/forecast', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
  try {
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ error: 'No profile' });
    const p = profile.rows[0];
    const scale = cgpaLib.normalizeScale(p.grading_scale);
    const gpMap = cgpaLib.GP_MAPS[scale];
    const visible = await pool.query('SELECT * FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false', [uid]);

    const base = cgpaLib.computeCGPA({ scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: visible.rows });
    const curUnits = base.totalUnits;
    const curPoints = base.totalPoints;
    const currentCGPA = base.cgpaNumber;

    // Generate what-if scenarios (grade improvements on weak courses)
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
          newPoints -= (cgpaLib.gradePoint(c.grade, scale)) * u;
          newPoints += (gpMap[g]||0) * u;
        });
        const newCGPA = newUnits > 0 ? (newPoints / newUnits) : 0;
        scenarios.push({ label: `If all D/E/F → ${g}`, grade: g, cgpa: newCGPA.toFixed(2), change: (newCGPA - currentCGPA).toFixed(3) });
      }
    }

    // What CGPA if add X new courses with all A's (uses the same trusted math)
    const addScenarios = [];
    for (let extra of [3, 5, 10]) {
      const addUnits = extra * 3;
      const forecast = cgpaLib.forecastCGPA({
        scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: visible.rows,
        extraCourses: Array.from({ length: extra }, () => ({ grade: 'A', credit_units: 3 }))
      });
      addScenarios.push({ courses: extra, units: addUnits, cgpa: forecast.cgpa });
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

app.post('/api/cgpa/ai-predict', isAuth, requirePaid, featureLock('cgpa'), rateLimit(12, 60000), async (req, res) => {
  try {
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const courses = await pool.query("SELECT course_code, title, credit_units, grade, level_scope, semester FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false ORDER BY level_scope DESC, semester DESC LIMIT 60", [uid]);
    if (courses.rows.length === 0) return res.json({ success: false, error: 'Log at least one course to get a prediction.' });
    const prompt = `You are an academic advisor. The student has the following academic profile on a ${p.grading_scale || 5}-point scale:
Level: ${p.current_level || 'unknown'} ${p.department || ''}
Authoritative current CGPA (calculated server-side, use as-is): ${cgpaLib.computeCGPA({ scale: p.grading_scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: courses.rows }).cgpa}
Recent courses (code | title | units | grade | level-sem):
${courses.rows.map(c => '- ' + c.course_code + ' | ' + (c.title||'') + ' | ' + c.credit_units + 'u | ' + c.grade + ' | L' + c.level_scope + 'S' + c.semester).join('\n')}

Predict their likely GPA range next semester, identify subjects they are at risk of failing, and give 4 short practical study tips to lift their CGPA. Output PLAIN TEXT only (no markdown, no asterisks, no hashtags, no backticks). Use short paragraphs and numbered points as 1), 2), 3) where useful. Maximum 200 words.`;
    const aiRes = await studyPromptSmart(prompt);
    if (!aiRes.text || aiRes.text.startsWith('AI error')) return res.json({ success: false, error: aiRes.text || 'AI error' });
    res.json({ success: true, prediction: cleanAiText(aiRes.text) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/ai-whatif', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
  try {
    const { courseName, units, anticipatedGrade } = req.body;
    if (!courseName || !units || !anticipatedGrade) return res.json({ success: false, error: 'Fill in all fields.' });
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const scale = cgpaLib.normalizeScale(p.grading_scale);
    const courses = await pool.query("SELECT credit_units, grade FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false", [uid]);
    const base = cgpaLib.computeCGPA({ scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: courses.rows });
    const curCGPA = base.cgpaNumber;
    const forecast = cgpaLib.forecastCGPA({
        scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: courses.rows,
        extraCourses: [{ grade: anticipatedGrade, credit_units: parseInt(units) || 0 }]
    });
    const newCGPA = forecast.cgpaNumber;
    const warn = newCGPA < curCGPA ? 'This would lower your CGPA. Consider aiming higher if possible.' : 'Good — this move improves your cumulative GPA.';
    const advicePrompt = `You are an academic advisor. The student asks: "If I take "${courseName}" (${addU} units) and aim for grade ${anticipatedGrade}, what's the impact?" Their current CGPA is ${curCGPA.toFixed(2)} / ${scale}. New CGPA would be ${newCGPA.toFixed(2)}. Give a 3-sentence plain-text answer about the impact and what to focus on to actually achieve ${anticipatedGrade}. No markdown, no asterisks.`;
    const aiRes = await studyPromptSmart(advicePrompt);
    const advice = (!aiRes.text || aiRes.text.startsWith('AI error')) ? warn : cleanAiText(aiRes.text);
    res.json({ success: true, currentCGPA: curCGPA.toFixed(2), newCGPA: newCGPA.toFixed(2), advice: advice });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/bulk-whatif', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
  try {
    const { courses: whatifCourses } = req.body;
    if (!whatifCourses || !Array.isArray(whatifCourses) || whatifCourses.length === 0)
      return res.json({ success: false, error: 'Add at least one course.' });
    const uid = req.session.user.id;
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up your CGPA profile first.' });
    const p = profile.rows[0];
    const scale = cgpaLib.normalizeScale(p.grading_scale);
    const courses = await pool.query("SELECT credit_units, grade FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false", [uid]);
    const base = cgpaLib.computeCGPA({ scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: courses.rows });
    const curCGPA = base.cgpaNumber;
    let addUnits = 0;
    const detail = [];
    const extraCourses = [];
    for (const c of whatifCourses) {
      const u = parseInt(c.units) || 3;
      const g = String(c.grade || 'A').toUpperCase();
      addUnits += u;
      extraCourses.push({ grade: g, credit_units: u });
      detail.push({ name: c.name || 'Course', units: u, grade: g });
    }
    const forecast = cgpaLib.forecastCGPA({
      scale, prevUnits: p.prev_units, prevPoints: p.prev_gp, courses: courses.rows,
      extraCourses
    });
    const newCGPA = forecast.cgpaNumber;
    res.json({
      success: true,
      currentCGPA: curCGPA.toFixed(2),
      newCGPA: newCGPA.toFixed(2),
      change: (newCGPA - curCGPA).toFixed(3),
      totalUnits: base.totalUnits,
      newTotalUnits: forecast.totalUnits,
      detail
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cgpa/ai-chat', isAuth, requirePaid, featureLock('cgpa'), rateLimit(20, 60000), async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) return res.json({ success: false, error: 'Empty message.' });
    const uid = req.session.user.id;
    const cleanUser = cleanAiText(message);
    await pool.query('INSERT INTO study_chat_messages (user_id, course_id, subtopic_id, role, message) VALUES ($1, 0, 0, $2, $3)', [uid, 'user', cleanUser]).catch(()=>{});
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    const courses = await pool.query("SELECT course_code, credit_units, grade, level_scope, semester FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false ORDER BY id DESC LIMIT 20", [uid]);
    let ctx = '';
    if (profile.rows[0]) {
      const p = profile.rows[0];
      const trusted = cgpaLib.computeCGPA({
        scale: p.grading_scale,
        prevUnits: p.prev_units,
        prevPoints: p.prev_gp,
        courses: courses.rows
      });
      ctx += 'Context: Student academic profile — current level ' + (p.current_level || 'unknown') + ', ' + (p.department || '') + ', scale ' + (p.grading_scale || 5) + '.\n';
      // Trusted server-side calculation — the AI must quote this value, never invent one.
      ctx += 'Authoritative current CGPA (calculated server-side): ' + trusted.cgpa + ' / ' + trusted.scale + ' (' + trusted.degreeClass + '). If asked for their CGPA, use exactly this value.\n';
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
app.get('/api/cgpa/transcript', isAuth, requirePaid, featureLock('cgpa'), async (req, res) => {
  try {
    const uid = req.session.user.id;
    const user = await pool.query('SELECT fullname, email FROM users WHERE id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    const courses = await pool.query('SELECT * FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false ORDER BY level_scope ASC, semester ASC', [uid]);
    const scale = cgpaLib.normalizeScale(profile.rows[0] ? profile.rows[0].grading_scale : 5);
    const breakdown = cgpaLib.buildSemesterBreakdown({
      scale,
      prevUnits: profile.rows[0]?.prev_units,
      prevPoints: profile.rows[0]?.prev_gp,
      courses: courses.rows
    });
    const { semesters, totals, totalPassed } = breakdown;
    const cgpa = totals.cgpaNumber;
    const degreeClass = totals.degreeClass;

    const refNum = 'PPT/' + new Date().getFullYear() + '/' + String(uid).slice(-4) + '/' + String(Date.now()).slice(-6);

    res.json({
      student: user.rows[0] ? { name: user.rows[0].fullname, email: user.rows[0].email } : {},
      department: profile.rows[0]?.department || '',
      currentLevel: profile.rows[0]?.current_level || '',
      gradingScale: scale,
      semesters,
      totalUnits: totals.totalUnits, totalPassed, cgpa: totals.cgpa, degreeClass,
      refNumber: refNum,
      generatedAt: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PDF Transcript download
app.get('/api/cgpa/transcript/pdf', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const user = await pool.query('SELECT fullname, email FROM users WHERE id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    const courses = await pool.query('SELECT * FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false ORDER BY level_scope ASC, semester ASC', [uid]);
    const scale = cgpaLib.normalizeScale(profile.rows[0] ? profile.rows[0].grading_scale : 5);
    const breakdown = cgpaLib.buildSemesterBreakdown({
      scale,
      prevUnits: profile.rows[0]?.prev_units,
      prevPoints: profile.rows[0]?.prev_gp,
      courses: courses.rows
    });
    const semesters = breakdown.semesters;
    const cgpa = breakdown.totals.cgpaNumber;
    const degreeClass = breakdown.totals.degreeClass;
    const refNum = 'PPT/' + new Date().getFullYear() + '/' + String(uid).slice(-4) + '/' + String(Date.now()).slice(-6);
    const studentName = user.rows[0]?.fullname || 'Student';
    const dept = profile.rows[0]?.department || '';
    const currentLevel = profile.rows[0]?.current_level || '';
    const semesterLabel = s => 'Level ' + s.level + ' — ' + (String(s.semester) === '1' ? 'First' : 'Second') + ' Semester';

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
    const fileName = 'Transcript_' + studentName.replace(/[^\w]+/g, '_') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    doc.pipe(res);

    const M = 44;
    const W = doc.page.width - M * 2;
    const INK = '#0f172a', MUTED = '#64748b', BRAND = '#2563eb';
    const NAVY = '#0b1437', INDIGO = '#1e1b4b';

    // ---- Brand header band (page 1) ----
    const bandH = 118;
    const bandGrad = doc.linearGradient(0, 0, 0, bandH);
    bandGrad.stop(0, NAVY).stop(1, INDIGO);
    doc.rect(0, 0, doc.page.width, bandH).fill(bandGrad);
    doc.rect(0, bandH - 4, doc.page.width, 4).fill(BRAND);
    doc.circle(M, 40, 5).fill('#60a5fa');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(21).text('PREPIUM', M + 14, 27);
    doc.fillColor('#93c5fd').font('Helvetica').fontSize(9.5).text('Official Transcript of Academic Record', M + 14, 54);
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7.5);
    doc.text('REF: ' + refNum, M + 14, 76, { align: 'left' });
    doc.text('Issued: ' + new Date().toLocaleString('en-GB'), M + 14, 90, { align: 'left' });
    doc.fillColor('#bfdbfe').font('Helvetica-Bold').fontSize(8).text('STUDENT-OWNED ACADEMIC RECORD', M, 98, { align: 'right', width: doc.page.width - M * 2 });

    doc.y = bandH + 22;

    // ---- Student info card ----
    const infoTop = doc.y;
    const infoH = 96;
    doc.roundedRect(M, infoTop, W, infoH, 10).fill('#f8fafc');
    doc.roundedRect(M, infoTop, W, infoH, 10).strokeColor('#e2e8f0').lineWidth(1).stroke();
    const field = (label, value, x, y, w) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(6.3).text(label.toUpperCase(), x, y);
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.6).text(value || '-', x, y + 11, { width: w, ellipsis: true });
    };
    const col = (W - 36) / 3;
    const pad = 18;
    field('Full Name', studentName, M + pad, infoTop + 14, col);
    field('Department', dept || 'Not specified', M + pad + col, infoTop + 14, col);
    field('Current Level', (currentLevel ? currentLevel + ' Level' : 'Not specified'), M + pad + col * 2, infoTop + 14, col);
    field('Email', user.rows[0]?.email || '', M + pad, infoTop + 52, col * 2 + 8);
    field('Grading Scale', scale + '-Point System', M + pad + col * 2, infoTop + 52, col);

    doc.y = infoTop + infoH + 16;

    // ---- CGPA hero panel ----
    const heroTop = doc.y;
    const heroH = 92;
    const heroGrad = doc.linearGradient(0, heroTop, 0, heroTop + heroH);
    heroGrad.stop(0, BRAND).stop(1, '#4f46e5');
    doc.roundedRect(M, heroTop, W, heroH, 12).fill(heroGrad);
    doc.fillColor('#dbeafe').font('Helvetica').fontSize(7).text('CUMULATIVE GPA (CGPA)', M + 22, heroTop + 16);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(40).text(cgpa.toFixed(2), M + 22, heroTop + 28);
    doc.fillColor('#dbeafe').font('Helvetica').fontSize(10).text('/ ' + scale + '.00', M + 22 + 122, heroTop + 50);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    doc.text(degreeClass || 'Pass', M + W - 190, heroTop + 34, { width: 170, align: 'right', ellipsis: true });
    doc.fillColor('#dbeafe').font('Helvetica').fontSize(7.5).text('TOTAL UNITS: ' + breakdown.totals.totalUnits + '    |    TOTAL POINTS: ' + breakdown.totals.totalPoints.toFixed(1), M + W - 190, heroTop + 54, { width: 170, align: 'right' });

    doc.y = heroTop + heroH + 20;

    // ---- Helper: next page + footer reminder ----
    const ensure = (need) => {
      if (doc.y + need > doc.page.height - 66) { doc.addPage(); }
    };

    // ---- Semester blocks ----
    if (!semesters.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(11).text('No courses have been logged yet. Add courses on the CGPA tracker to build your transcript.', M, doc.y + 8, { width: W });
    }

    const gradeColor = (g) => (g === 'F' ? '#dc2626' : g === 'E' ? '#f59e0b' : INK);

    semesters.forEach(s => {
      const semCgpa = s.units > 0 ? (s.points / s.units).toFixed(2) : '0.00';
      ensure(150);
      // Semester banner
      const sTop = doc.y;
      doc.roundedRect(M, sTop, W, 30, 8).fill('#1e293b');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('LEVEL ' + s.level + '  |  ' + (String(s.semester) === '1' ? 'FIRST' : 'SECOND') + ' SEMESTER', M + 16, sTop + 9);
      doc.fillColor('#93c5fd').font('Helvetica-Bold').fontSize(9).text('SGPA ' + semCgpa, M + W - 96, sTop + 9, { width: 80, align: 'right' });
      doc.y = sTop + 38;

      // Column headers
      const hTop = doc.y;
      doc.rect(M, hTop, W, 20).fill('#eef2ff');
      doc.fillColor('#4f46e5').font('Helvetica-Bold').fontSize(6.8);
      doc.text('CODE', M + 12, hTop + 7);
      doc.text('COURSE TITLE', M + 108, hTop + 7);
      doc.text('UNIT', M + W - 118, hTop + 7, { width: 34, align: 'right' });
      doc.text('GRADE', M + W - 74, hTop + 7, { width: 40, align: 'right' });
      doc.text('GP', M + W - 36, hTop + 7, { width: 30, align: 'right' });
      doc.y = hTop + 20;

      const cx = { code: M + 12, title: M + 108, unit: M + W - 118, grade: M + W - 74, gp: M + W - 36 };
      const cw = { title: (M + W - 118) - (M + 108) - 12, unit: 34, grade: 40, gp: 30 };

      s.courses.forEach((c, i) => {
        if (doc.y > doc.page.height - 70) { doc.addPage(); }
        const rowTop = doc.y;
        const gp = gpMap[c.grade] || 0;
        const titleH = doc.heightOfString(c.title || '', { width: cw.title });
        const rowH = Math.max(20, titleH + 8);
        if (i % 2 === 1) doc.rect(M, rowTop, W, rowH).fill('#fafbff');
        doc.fillColor(c.excluded ? '#cbd5e1' : INK);
        doc.font(c.excluded ? 'Helvetica-Oblique' : 'Helvetica').fontSize(8.8);
        doc.text(c.code || '-', cx.code, rowTop + 6, { width: 88, ellipsis: true });
        doc.text(c.title || '', cx.title, rowTop + 6, { width: cw.title });
        if (c.excluded) doc.fillColor('#94a3b8').font('Helvetica-Oblique').fontSize(6.5).text('(excluded from CGPA)', cx.title + cw.title - 92, rowTop + 6, { width: 92, align: 'right' });
        doc.fillColor(gradeColor(c.grade)).font('Helvetica-Bold').fontSize(9);
        doc.text(String(c.units), cx.unit, rowTop + 6, { width: cw.unit, align: 'right' });
        doc.text(String(c.grade), cx.grade, rowTop + 6, { width: cw.grade, align: 'right' });
        doc.fillColor(MUTED).font('Helvetica').fontSize(8.6).text(gp.toFixed(1), cx.gp, rowTop + 6, { width: cw.gp, align: 'right' });
        doc.y = rowTop + rowH;
      });

      // Semester totals bar
      const tTop = doc.y;
      doc.roundedRect(M, tTop, W, 22, 6).fill('#eef2ff');
      const passed = s.courses.filter(c => c.grade !== 'F' && !c.excluded).length;
      doc.fillColor('#4338ca').font('Helvetica-Bold').fontSize(7.8)
        .text('SEMESTER TOTAL: ' + s.units + ' UNITS  |  ' + passed + ' COURSE(S) PASSED', M + 14, tTop + 7);
      doc.text('GPA ' + semCgpa + ' / ' + scale + '.00', M + W - 120, tTop + 7, { width: 106, align: 'right' });
      doc.y = tTop + 30;
    });

    doc.moveDown(0.6);
    ensure(110);

    // ---- Final footer note ----
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor('#e2e8f0').lineWidth(1).stroke();
    doc.y += 10;
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.6)
      .text('NOTICE: This transcript is auto-generated from records provided by the student in the Prepium CGPA Tracker. It is a personal academic summary and is NOT an official university document.', M, doc.y, { width: W });
    doc.y += 14;
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7)
      .text('Reference: ' + refNum + '   |   Generated: ' + new Date().toLocaleString('en-GB') + '   |   Prepium  |  theprepium.vercel.app', M, doc.y, { width: W });

    // ---- Page footers (all pages) ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const ph = doc.page.height;
      doc.fillColor('#cbd5e1').font('Helvetica').fontSize(7.5);
      doc.text('PREPIUM  |  Official Transcript  |  ' + refNum, M, ph - 34, { width: W * 0.6 });
      doc.text('Page ' + (i + 1) + ' of ' + range.count, M, ph - 34, { width: W, align: 'right' });
    }

    doc.end();
  } catch (err) {
    console.error('PDF transcript error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});
// Export courses as CSV
app.get('/api/cgpa/courses/export', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const courses = await pool.query(
      'SELECT course_code, title, credit_units, grade, level_scope, semester FROM public.cgpa_courses WHERE user_id = $1 AND deleted = false AND is_hidden = false ORDER BY level_scope ASC, semester ASC',
      [uid]
    );

    if (courses.rows.length === 0) {
      return res.status(404).json({ error: 'No courses found' });
    }

    // Generate CSV with proper escaping for Excel
    const escapeCsvValue = (value) => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      // Escape quotes by doubling them
      const escaped = str.replace(/"/g, '""');
      // Wrap in quotes if contains comma, quote, or newline
      if (/[",\n]/.test(escaped)) {
        return `"${escaped}"`;
      }
      return escaped;
    };

    const csvHeaders = ['Course Code', 'Title', 'Units', 'Grade', 'Level', 'Semester'];
    const csvRows = courses.rows.map(course => [
      escapeCsvValue(course.course_code),
      escapeCsvValue(course.title),
      escapeCsvValue(course.credit_units),
      escapeCsvValue(course.grade),
      escapeCsvValue(course.level_scope),
      escapeCsvValue(course.semester)
    ].join(','));

    // Add UTF-8 BOM for Excel compatibility
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const csvContent = Buffer.from([csvHeaders.join(','), ...csvRows].join('\r\n'), 'utf8');
    const finalBuffer = Buffer.concat([bom, csvContent]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="courses.csv"');
    res.send(finalBuffer);
  } catch (err) {
    console.error('Course export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ======================== END STUDY HUB ROUTES ========================

// NOTE: There is intentionally NO global error handler here. All errors —
// including multer upload errors — flow to the single central error handler
// registered at the very end of this file (after every route/middleware), so
// errors from early and late routes are handled identically.

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

let migrationColumnsReady = null;
async function ensureMigrationColumns() {
  if (!migrationColumnsReady) {
    migrationColumnsReady = (async () => {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS migrated_free BOOLEAN DEFAULT false");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMP");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS migrated_locked BOOLEAN DEFAULT false");
      await pool.query(`CREATE TABLE IF NOT EXISTS premium_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )`);
      await pool.query("ALTER TABLE universities ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false");
      await pool.query("ALTER TABLE universities ADD COLUMN IF NOT EXISTS price INTEGER DEFAULT 2000");
      await pool.query("ALTER TABLE universities ADD COLUMN IF NOT EXISTS locked_features JSONB DEFAULT '[]'");
    })().catch(err => { migrationColumnsReady = null; throw err; });
  }
  return migrationColumnsReady;
}

(async function initPremiumMigration() {
  try { await ensureMigrationColumns(); console.log('[Premium Migration] Table ready'); }
  catch(e) { console.error('[Premium Migration] Init:', e.message); }
})();

// Squad Streaks tables
(async function initSquads() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS squads (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      owner_id INTEGER NOT NULL,
      invite_code VARCHAR(10) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS squad_members (
      id SERIAL PRIMARY KEY,
      squad_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (squad_id, user_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS squad_checkins (
      id SERIAL PRIMARY KEY,
      squad_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      checkin_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (squad_id, user_id, checkin_date)
    )`);
    console.log('[Squads] Tables ready');
  } catch(e) { console.error('[Squads] Init:', e.message); }
})();

// Friendships (used by /api/friends endpoints)
(async function initFriendships() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, friend_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id)`);
    console.log('[Friends] Table ready');
  } catch(e) { console.error('[Friends] Init:', e.message); }
})();

// Public forms (NAPS style score collectors — standalone, no login)
(async function initPublicForms() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS pub_forms (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(64) UNIQUE NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      fields JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pub_responses (
      id SERIAL PRIMARY KEY,
      form_id INTEGER NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[PubForms] Tables ready');
  } catch(e) { console.error('[PubForms] Init:', e.message); }
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

// ─── RENAISSANCE MOCK EXAM TABLES ──────────────────────────────────────────
(async function initRenaissance() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS renaissance_exams (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      duration_minutes INTEGER DEFAULT 30,
      opens_at TIMESTAMP,
      closes_at TIMESTAMP,
      show_results_immediately BOOLEAN DEFAULT true,
      results_released BOOLEAN DEFAULT false,
      max_attempts INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'draft',
      created_by INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS renaissance_courses (
      id SERIAL PRIMARY KEY,
      exam_id INTEGER NOT NULL REFERENCES renaissance_exams(id) ON DELETE CASCADE,
      course_name VARCHAR(255) NOT NULL,
      course_code VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS renaissance_questions (
      id SERIAL PRIMARY KEY,
      course_id INTEGER REFERENCES renaissance_courses(id) ON DELETE CASCADE,
      exam_id INTEGER REFERENCES renaissance_exams(id) ON DELETE CASCADE,
      question_type VARCHAR(20) DEFAULT 'mcq',
      question_text TEXT NOT NULL,
      options JSONB DEFAULT '[]',
      correct_answer TEXT DEFAULT '',
      explanation TEXT DEFAULT '',
      ai_generated BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Flattened model: questions attach directly to an exam. Add exam_id column, then backfill from legacy courses.
    await pool.query(`ALTER TABLE renaissance_questions ADD COLUMN IF NOT EXISTS exam_id INTEGER`);
    await pool.query(`ALTER TABLE renaissance_questions ALTER COLUMN course_id DROP NOT NULL`);
    await pool.query(`UPDATE renaissance_questions q SET exam_id = c.exam_id
                      FROM renaissance_courses c WHERE q.course_id = c.id AND q.exam_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_rnz_q_exam ON renaissance_questions(exam_id)`);
    await pool.query(`ALTER TABLE renaissance_exams ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 0`);
    await pool.query(`CREATE TABLE IF NOT EXISTS renaissance_attempts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      exam_id INTEGER NOT NULL,
      score INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      percentage DECIMAL(5,2) DEFAULT 0,
      time_taken INTEGER DEFAULT 0,
      answers JSONB DEFAULT '{}',
      status VARCHAR(20) DEFAULT 'in_progress',
      started_at TIMESTAMP DEFAULT NOW(),
      submitted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS renaissance_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT DEFAULT ''
    )`);
    console.log('[Renaissance] Tables ready');
  } catch(e) { console.error('[Renaissance] Init:', e.message); }
})();

async function getRenaissanceSetting(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM renaissance_settings WHERE key = $1', [key]);
    if (r.rows[0]) return r.rows[0].value;
  } catch (_) {}
  return fallback || '';
}

// AI helper: generate correct answer + explanation for a Renaissance question
async function renaissanceAIAnswer(questionText, options, opts) {
  const optsList = Array.isArray(options) && options.length ? options.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join('\n') : '';
  const prompt = `You are a university examiner. Given this exam question (which may contain LaTeX math and TikZ diagrams), provide the CORRECT answer and a short clear explanation.
Question: ${questionText}
${optsList ? 'Options:\n' + optsList + '\n\nIf one of the options is correct, answer with its LETTER (e.g. "B") AND the option text. If it is a theory/open question, give the full expected answer.' : ''}
Return ONLY raw JSON (no markdown, no code fences) exactly like:
{"answer":"the correct answer here","explanation":"short explanation here"}`;
  const res = await studyPromptSmart(prompt, opts || {});
  if (!res.text || res.text.startsWith('AI error')) return { error: res.text || 'AI could not generate.' };
  let parsed;
  try { parsed = JSON.parse(res.text); }
  catch (_) {
    const m = res.text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_2) {} }
  }
  if (!parsed) return { error: 'AI returned invalid data.' };
  return { answer: (parsed.answer || '').trim(), explanation: (parsed.explanation || '').trim(), provider: res.provider };
}

// ======================== COURSE LIBRARY ========================
// Structured academic resource library: University -> Faculty -> Department -> Level -> Semester -> Course
// Public, searchable, community-contributed with admin verification.

(async function initLibrary() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS library_faculties (
                id SERIAL PRIMARY KEY,
                university_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(university_id, slug)
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS library_departments (
                id SERIAL PRIMARY KEY,
                faculty_id INTEGER NOT NULL REFERENCES library_faculties(id) ON DELETE CASCADE,
                university_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(faculty_id, slug)
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS library_courses (
                id SERIAL PRIMARY KEY,
                department_id INTEGER NOT NULL REFERENCES library_departments(id) ON DELETE CASCADE,
                university_id INTEGER NOT NULL,
                code VARCHAR(50) NOT NULL DEFAULT '',
                title VARCHAR(500) NOT NULL,
                description TEXT DEFAULT '',
                level INTEGER DEFAULT 100,
                semester INTEGER DEFAULT 1,
                added_by INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            )`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS library_resources (
                id SERIAL PRIMARY KEY,
                course_id INTEGER NOT NULL REFERENCES library_courses(id) ON DELETE CASCADE,
                university_id INTEGER NOT NULL,
                title VARCHAR(500) NOT NULL,
                category VARCHAR(50) DEFAULT 'notes',
                url TEXT DEFAULT '',
                description TEXT DEFAULT '',
                contributor_user_id INTEGER,
                contributor_name VARCHAR(255) DEFAULT 'Anonymous',
                is_verified BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_lib_courses_uni ON library_courses(university_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_lib_resources_course ON library_resources(course_id)`);
        console.log('[Library] tables ready');
    } catch (err) {
        console.error('[Library] setup:', err.message);
    }
})();

function libSlug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
}

const LIB_CATEGORIES = ['notes', 'past_question', 'solution', 'textbook', 'summary', 'other'];
function libCategoryLabel(c) {
    return { notes: 'Lecture Notes', past_question: 'Past Question', solution: 'Solution', textbook: 'Textbook', summary: 'Summary', other: 'Other' }[c] || 'Other';
}

// Library hub: university picker + global search
app.get('/library', async (req, res) => {
    try {
        res.locals.seo.title = 'Course Library | Prepium';
        res.locals.seo.description = 'Browse Nigerian university courses, lecture notes, past questions and study resources - organised by faculty, department, level and semester.';
        const q = (req.query.q || '').toString().trim().slice(0, 100);
        let universities = [];
        let results = [];
        try { universities = (await pool.query('SELECT id, name, slug FROM universities ORDER BY name ASC')).rows; } catch (_) {}
        if (q) {
            results = await pool.query(`
                SELECT c.id, c.code, c.title, c.level, c.semester, d.name AS department, f.name AS faculty, u.name AS university, u.slug AS uni_slug,
                (SELECT COUNT(*) FROM library_resources r WHERE r.course_id = c.id) AS resource_count
                FROM library_courses c
                JOIN library_departments d ON d.id = c.department_id
                JOIN library_faculties f ON f.id = d.faculty_id
                JOIN universities u ON u.id = c.university_id
                WHERE c.code ILIKE $1 OR c.title ILIKE $1
                ORDER BY u.name ASC, c.code ASC LIMIT 40`, ['%' + q + '%']);
        }
        const uniCounts = await pool.query(`SELECT university_id, COUNT(*) AS courses FROM library_courses GROUP BY university_id`).catch(() => ({ rows: [] }));
        const countMap = {};
        uniCounts.rows.forEach(r => { countMap[r.university_id] = parseInt(r.courses); });
        res.render('library', {
            user: req.session.user || null,
            universities: universities.map(u => ({ ...u, course_count: countMap[u.id] || 0 })),
            q,
            results: q ? results.rows : []
        });
    } catch (err) {
        console.error('Library error:', err);
        res.status(500).send('Something went wrong.');
    }
});

// University page: faculties
app.get('/library/:uniSlug', async (req, res) => {
    try {
        const uni = await pool.query('SELECT id, name, slug FROM universities WHERE slug = $1', [req.params.uniSlug]);
        if (!uni.rows[0]) return res.status(404).send('Not found');
        const faculties = await pool.query(`
            SELECT f.id, f.name, f.slug,
            (SELECT COUNT(*) FROM library_departments d WHERE d.faculty_id = f.id) AS dept_count,
            (SELECT COUNT(*) FROM library_courses c WHERE c.department_id IN (SELECT id FROM library_departments d2 WHERE d2.faculty_id = f.id)) AS course_count
            FROM library_faculties f
            WHERE f.university_id = $1 ORDER BY f.name ASC`, [uni.rows[0].id]);
        res.locals.seo.title = uni.rows[0].name + ' Courses | Prepium Library';
        res.locals.seo.description = 'Browse ' + uni.rows[0].name + ' courses by faculty and department - notes, past questions and study resources.';
        res.render('library-university', {
            user: req.session.user || null,
            university: uni.rows[0],
            faculties: faculties.rows
        });
    } catch (err) {
        console.error('Library uni error:', err);
        res.status(500).send('Something went wrong.');
    }
});

// Faculty page: departments
app.get('/library/faculty/:id', async (req, res) => {
    try {
        const f = await pool.query(`
            SELECT f.id, f.name, f.slug, u.id AS uni_id, u.name AS uni_name, u.slug AS uni_slug
            FROM library_faculties f JOIN universities u ON u.id = f.university_id WHERE f.id = $1`, [req.params.id]);
        if (!f.rows[0]) return res.status(404).send('Not found');
        const departments = await pool.query(`
            SELECT d.id, d.name, d.slug,
            (SELECT COUNT(*) FROM library_courses c WHERE c.department_id = d.id) AS course_count
            FROM library_departments d WHERE d.faculty_id = $1 ORDER BY d.name ASC`, [f.rows[0].id]);
        res.locals.seo.title = f.rows[0].name + ' - ' + f.rows[0].uni_name + ' | Prepium Library';
        res.locals.seo.description = 'Departments in ' + f.rows[0].name + ', ' + f.rows[0].uni_name + '.';
        res.render('library-department', {
            user: req.session.user || null,
            faculty: f.rows[0],
            departments: departments.rows
        });
    } catch (err) {
        console.error('Library faculty error:', err);
        res.status(500).send('Something went wrong.');
    }
});

// Department page: courses with filters + search
app.get('/library/department/:id', async (req, res) => {
    try {
        const d = await pool.query(`
            SELECT d.id, d.name, f.id AS faculty_id, f.name AS faculty_name, u.id AS uni_id, u.name AS uni_name, u.slug AS uni_slug
            FROM library_departments d JOIN library_faculties f ON f.id = d.faculty_id JOIN universities u ON u.id = d.university_id
            WHERE d.id = $1`, [req.params.id]);
        if (!d.rows[0]) return res.status(404).send('Not found');
        const level = parseInt(req.query.level) || 0;
        const semester = parseInt(req.query.semester) || 0;
        const q = (req.query.q || '').toString().trim().slice(0, 100);
        const clauses = ['c.department_id = $1'];
        const params = [d.rows[0].id];
        if (level) { params.push(level); clauses.push('c.level = $' + params.length); }
        if (semester) { params.push(semester); clauses.push('c.semester = $' + params.length); }
        if (q) { params.push('%' + q + '%'); clauses.push("(c.code ILIKE $" + params.length + " OR c.title ILIKE $" + params.length + ")"); }
        const courses = await pool.query(`
            SELECT c.id, c.code, c.title, c.level, c.semester,
            (SELECT COUNT(*) FROM library_resources r WHERE r.course_id = c.id) AS resource_count
            FROM library_courses c WHERE ` + clauses.join(' AND ') + `
            ORDER BY c.level ASC, c.code ASC LIMIT 100`, params);
        res.locals.seo.title = d.rows[0].name + ' Courses | Prepium Library';
        res.locals.seo.description = 'Courses in ' + d.rows[0].name + ', ' + d.rows[0].uni_name + '.';
        res.render('library-courses', {
            user: req.session.user || null,
            department: d.rows[0],
            courses: courses.rows,
            level, semester, q
        });
    } catch (err) {
        console.error('Library dept error:', err);
        res.status(500).send('Something went wrong.');
    }
});

// Course detail: resources
app.get('/library/course/:id', async (req, res) => {
    try {
        const c = await pool.query(`
            SELECT c.id, c.code, c.title, c.description, c.level, c.semester, d.id AS department_id, d.name AS department, f.id AS faculty_id, f.name AS faculty,
            u.id AS uni_id, u.name AS uni_name, u.slug AS uni_slug
            FROM library_courses c JOIN library_departments d ON d.id = c.department_id
            JOIN library_faculties f ON f.id = d.faculty_id JOIN universities u ON u.id = c.university_id
            WHERE c.id = $1`, [req.params.id]);
        if (!c.rows[0]) return res.status(404).send('Not found');
        const resources = await pool.query(`
            SELECT id, title, category, url, description, contributor_name, is_verified, created_at
            FROM library_resources WHERE course_id = $1 ORDER BY is_verified DESC, created_at DESC LIMIT 50`, [c.rows[0].id]);
        res.locals.seo.title = c.rows[0].code + ' - ' + c.rows[0].title + ' | Prepium Library';
        res.locals.seo.description = 'Study resources for ' + c.rows[0].code + ' (' + c.rows[0].title + ') - notes, past questions and solutions.';
        res.render('library-course', {
            user: req.session.user || null,
            course: c.rows[0],
            resources: resources.rows,
            categories: LIB_CATEGORIES,
            categoryLabel: libCategoryLabel
        });
    } catch (err) {
        console.error('Library course error:', err);
        res.status(500).send('Something went wrong.');
    }
});

// Contribute: add a resource (or a new course) - stored unverified until an admin approves
app.post('/api/library/contribute', isAuth, rateLimit(10, 60000), async (req, res) => {
    try {
        const body = req.body || {};
        const courseId = parseInt(body.courseId) || 0;
        const title = String(body.title || '').trim().slice(0, 500);
        const url = String(body.url || '').trim().slice(0, 2000);
        const description = String(body.description || '').trim().slice(0, 1000);
        const category = LIB_CATEGORIES.includes(body.category) ? body.category : 'other';
        if (!title || !url) return res.status(400).json({ success: false, message: 'Resource title and link are required' });
        if (!/^https:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'Link must start with https://' });

        let courseIdFinal = courseId;
        if (!courseIdFinal) {
            const code = String(body.newCourseCode || '').trim().slice(0, 50);
            const titleC = String(body.newCourseTitle || '').trim().slice(0, 500);
            if (!code || !titleC) return res.status(400).json({ success: false, message: 'Course code and title are required' });
            const uni = await getSchoolForUser(req.session.user.id);
            if (!uni) return res.status(400).json({ success: false, message: 'Set your university in your profile first' });
            const depRow = await pool.query(`
                SELECT d.id, d.university_id FROM library_departments d
                JOIN library_faculties f ON f.id = d.faculty_id
                WHERE f.university_id = $1 ORDER BY d.name ASC LIMIT 1`, [uni.id]);
            if (!depRow.rows[0]) return res.status(400).json({ success: false, message: 'Your university is not in the library yet' });
            const lvl = [100, 200, 300, 400, 500].includes(parseInt(body.newCourseLevel)) ? parseInt(body.newCourseLevel) : 100;
            const sem = [1, 2].includes(parseInt(body.newCourseSemester)) ? parseInt(body.newCourseSemester) : 1;
            const ins = await pool.query(`
                INSERT INTO library_courses (department_id, university_id, code, title, level, semester, added_by)
                VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [depRow.rows[0].id, depRow.rows[0].university_id, code, titleC, lvl, sem, req.session.user.id]);
            courseIdFinal = ins.rows[0].id;
        }
        const course = await pool.query('SELECT university_id FROM library_courses WHERE id = $1', [courseIdFinal]);
        if (!course.rows[0]) return res.status(404).json({ success: false, message: 'Course not found' });
        const contributor = await pool.query('SELECT fullname FROM users WHERE id = $1', [req.session.user.id]);
        await pool.query(`
            INSERT INTO library_resources (course_id, university_id, title, category, url, description, contributor_user_id, contributor_name, is_verified)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
            [courseIdFinal, course.rows[0].university_id, title, category, url, description,
             req.session.user.id, (contributor.rows[0] && contributor.rows[0].fullname) || 'Anonymous']);
        res.json({ success: true, message: 'Thank you! Your resource was submitted and will appear once reviewed.' });
    } catch (err) {
        console.error('Library contribute error:', err);
        res.status(500).json({ success: false, message: 'Could not submit resource' });
    }
});

// Admin: verify/unverify/delete resources
app.get('/admin/library', isAdmin, async (req, res) => {
    try {
        const pending = await pool.query(`
            SELECT r.id, r.title, r.category, r.url, r.contributor_name, r.created_at, c.code AS course_code, c.title AS course_title, u.name AS uni_name
            FROM library_resources r JOIN library_courses c ON c.id = r.course_id JOIN universities u ON u.id = r.university_id
            WHERE r.is_verified = false ORDER BY r.created_at DESC LIMIT 100`);
        const verified = await pool.query(`
            SELECT r.id, r.title, c.code AS course_code, u.name AS uni_name
            FROM library_resources r JOIN library_courses c ON c.id = r.course_id JOIN universities u ON u.id = r.university_id
            WHERE r.is_verified = true ORDER BY r.created_at DESC LIMIT 100`);
        res.render('admin/library', { pending: pending.rows, verified: verified.rows });
    } catch (err) {
        console.error('Admin library error:', err);
        res.status(500).send('Database Error');
    }
});
app.post('/admin/library/verify/:id', isAdmin, async (req, res) => {
    try { await pool.query('UPDATE library_resources SET is_verified = true WHERE id = $1', [req.params.id]); } catch (_) {}
    res.redirect('/admin/library');
});
app.post('/admin/library/unverify/:id', isAdmin, async (req, res) => {
    try { await pool.query('UPDATE library_resources SET is_verified = false WHERE id = $1', [req.params.id]); } catch (_) {}
    res.redirect('/admin/library');
});
app.post('/admin/library/delete/:id', isAdmin, async (req, res) => {
    try { await pool.query('DELETE FROM library_resources WHERE id = $1', [req.params.id]); } catch (_) {}
    res.redirect('/admin/library');
});

// ======================== END COURSE LIBRARY ========================


// ==================== SOCIAL FEATURES ====================
async function acceptFriendship(uid, friendId) {
    await pool.query(
        'UPDATE friendships SET status = $1 WHERE user_id = $2 AND friend_id = $3',
        ['accepted', friendId, uid]
    );
    await pool.query(
        `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status`,
        [uid, friendId, 'accepted']
    );
}

// Send friend request
app.post('/api/friends/request', isAuth, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        const uid = req.session.user.id;
        if (!friendId || friendId === uid) return res.status(400).json({ success: false, error: 'Invalid friend ID' });

        const target = await pool.query('SELECT id FROM users WHERE id = $1', [friendId]);
        if (!target.rows[0]) return res.status(404).json({ success: false, error: 'User not found' });

        // If they already requested us, accept instead of creating a duplicate.
        const reverse = await pool.query(
            'SELECT id FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = $3',
            [friendId, uid, 'pending']
        );
        if (reverse.rows[0]) {
            await acceptFriendship(uid, friendId);
            notifyUser(friendId, 'friend', 'Friend request accepted', req.session.user.fullname + ' accepted your friend request', '/chat?tab=friends');
            return res.json({ success: true, accepted: true });
        }

        await pool.query(
            'INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [uid, friendId, 'pending']
        );
        notifyUser(friendId, 'friend', 'New friend request', req.session.user.fullname + ' sent you a friend request', '/chat?tab=friends');
        res.json({ success: true });
    } catch(e){ res.status(500).json({ success: false, error: 'Could not send request' }); }
});

// Accept friend request
app.post('/api/friends/accept', isAuth, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        const uid = req.session.user.id;
        if (!friendId || friendId === uid) return res.status(400).json({ success: false, error: 'Invalid friend ID' });

        const pending = await pool.query(
            'SELECT id FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = $3',
            [friendId, uid, 'pending']
        );
        if (!pending.rows[0]) return res.status(404).json({ success: false, error: 'No pending request' });

        await acceptFriendship(uid, friendId);
        notifyUser(friendId, 'friend', 'Friend request accepted', req.session.user.fullname + ' accepted your friend request', '/chat?tab=friends');
        res.json({ success: true });
    } catch(e){ res.status(500).json({ success: false, error: 'Could not accept request' }); }
});

// Get friends list
app.get('/api/friends', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT u.id, u.fullname, u.email, COALESCE(u.xp, 0) AS xp
             FROM friendships f
             JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
             WHERE (f.user_id = $1 OR f.friend_id = $1) AND f.status = $2
             ORDER BY u.fullname`,
            [uid, 'accepted']
        );
        const seen = new Set();
        const friends = r.rows.filter(u => (seen.has(u.id) ? false : (seen.add(u.id), true)))
            .map(u => ({ ...u, level: levelForXp(u.xp) }));
        res.json({ friends });
    } catch(e){ res.status(500).json({ error: 'Could not load friends' }); }
});

// ==================== COMMUNITY: XP LEADERBOARD, CHAT, STATUS ====================
let io = null;

async function emitToMembers(conversationId, event, payload, excludeUserId) {
    if (!io) return;
    try {
        const r = await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [conversationId]);
        r.rows.forEach(row => {
            if (excludeUserId && row.user_id === excludeUserId) return;
            io.to('user_' + row.user_id).emit(event, payload);
        });
    } catch (e) { console.error('[Chat] Emit error:', e.message); }
}

(async function initCommunity() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
            id SERIAL PRIMARY KEY,
            type VARCHAR(10) NOT NULL DEFAULT 'direct',
            name VARCHAR(100),
            created_by INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS conversation_members (
            conversation_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role VARCHAR(10) NOT NULL DEFAULT 'member',
            last_read_at TIMESTAMP DEFAULT NOW(),
            last_active_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (conversation_id, user_id)
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            kind VARCHAR(10) NOT NULL DEFAULT 'text',
            body TEXT,
            media BYTEA,
            media_mime VARCHAR(100),
            media_name VARCHAR(200),
            media_duration INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at DESC)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS status_posts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            kind VARCHAR(10) NOT NULL DEFAULT 'text',
            body TEXT,
            bg_color VARCHAR(30) DEFAULT '#2563eb',
            media BYTEA,
            media_mime VARCHAR(100),
            privacy VARCHAR(10) NOT NULL DEFAULT 'friends',
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_status_posts_exp ON status_posts(expires_at)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS status_views (
            status_id INTEGER NOT NULL,
            viewer_id INTEGER NOT NULL,
            viewed_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (status_id, viewer_id)
        )`);
        console.log('[Community] Tables ready');
    } catch (e) { console.error('[Community] Init:', e.message); }
})();

async function conversationRole(cid, uid) {
    const r = await pool.query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [cid, uid]);
    return r.rows[0] ? r.rows[0].role : null;
}

async function areFriends(a, b) {
    const r = await pool.query(
        `SELECT 1 FROM friendships WHERE status = 'accepted' AND ((user_id = $1 AND friend_id = $2) OR (friend_id = $1 AND user_id = $2))`,
        [a, b]
    );
    return !!r.rows[0];
}

// ---- Friend search / requests / remove ----
app.get('/api/friends/search', isAuth, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 60);
        const uid = req.session.user.id;
        if (q.length < 2) return res.json({ success: true, results: [] });
        const r = await pool.query(
            `SELECT id, fullname, email, COALESCE(xp, 0) AS xp
             FROM users
             WHERE id <> $1 AND (fullname ILIKE $2 OR email ILIKE $2 OR unique_code::text = $3)
             ORDER BY fullname LIMIT 12`,
            [uid, '%' + q + '%', q]
        );
        const rel = await pool.query('SELECT user_id, friend_id, status FROM friendships WHERE user_id = $1 OR friend_id = $1', [uid]);
        const map = {};
        rel.rows.forEach(row => {
            const other = row.user_id === uid ? row.friend_id : row.user_id;
            if (row.status === 'accepted') map[other] = 'friends';
            else if (row.status === 'pending') map[other] = row.user_id === uid ? 'request_sent' : 'request_received';
        });
        res.json({
            success: true,
            results: r.rows.map(u => ({
                id: u.id, fullname: u.fullname, email: u.email,
                level: levelForXp(u.xp),
                relationship: map[u.id] || 'none'
            }))
        });
    } catch (e) { res.status(500).json({ success: false, error: 'Search failed' }); }
});

app.get('/api/friends/requests', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const incoming = await pool.query(
            `SELECT u.id, u.fullname, u.email, f.created_at
             FROM friendships f JOIN users u ON u.id = f.user_id
             WHERE f.friend_id = $1 AND f.status = 'pending' ORDER BY f.created_at DESC`,
            [uid]
        );
        const outgoing = await pool.query(
            `SELECT u.id, u.fullname, u.email, f.created_at
             FROM friendships f JOIN users u ON u.id = f.friend_id
             WHERE f.user_id = $1 AND f.status = 'pending' ORDER BY f.created_at DESC`,
            [uid]
        );
        res.json({ success: true, incoming: incoming.rows, outgoing: outgoing.rows });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not load requests' }); }
});

app.post('/api/friends/remove', isAuth, async (req, res) => {
    try {
        const friendId = parseInt(req.body.friendId, 10);
        const uid = req.session.user.id;
        if (!friendId) return res.status(400).json({ success: false, error: 'Invalid friend ID' });
        await pool.query('DELETE FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [uid, friendId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not remove friend' }); }
});

app.get('/api/friends/leaderboard', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT u.id, u.fullname, COALESCE(u.xp, 0) AS xp,
                    (SELECT COUNT(*) FROM game_results g WHERE g.user_id = u.id)::int AS plays
             FROM users u
             WHERE u.id = $1 OR u.id IN (
                 SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
                 FROM friendships f
                 WHERE f.status = 'accepted' AND (f.user_id = $1 OR f.friend_id = $1)
             )
             ORDER BY xp DESC, fullname ASC LIMIT 50`,
            [uid]
        );
        res.json({
            success: true,
            leaderboard: r.rows.map((row, i) => ({
                id: row.id, fullname: row.fullname, xp: row.xp, plays: row.plays,
                level: levelForXp(row.xp), rank: i + 1, is_me: row.id === uid
            }))
        });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not load leaderboard' }); }
});

app.get('/friends', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | Community';
    res.render('chat', {
        user: req.session.user,
        initialTab: 'friends',
        initialSub: req.query.tab === 'leaderboard' ? 'leaderboard' : null
    });
});

// ---- Chat: conversations ----
app.get('/api/chat/conversations', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT c.id, c.type, c.name, c.created_by,
                    cm.last_read_at AS my_last_read,
                    (SELECT COUNT(*) FROM chat_messages m
                      WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.created_at > cm.last_read_at)::int AS unread,
                    lm.kind AS last_kind, lm.body AS last_body, lm.sender_id AS last_sender, lm.created_at AS last_at
             FROM conversation_members cm
             JOIN conversations c ON c.id = cm.conversation_id
             LEFT JOIN LATERAL (
                 SELECT kind, body, sender_id, created_at FROM chat_messages
                 WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
             ) lm ON true
             WHERE cm.user_id = $1
             ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
            [uid]
        );
        const convIds = r.rows.map(c => c.id);
        let others = [];
        let memberTimes = [];
        if (convIds.length) {
            const o = await pool.query(
                `SELECT cm.conversation_id, u.id, u.fullname
                 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                 WHERE cm.conversation_id = ANY($1) AND cm.user_id <> $2`,
                [convIds, uid]
            );
            others = o.rows;
            const t = await pool.query(
                `SELECT conversation_id, user_id, last_read_at, last_active_at
                 FROM conversation_members WHERE conversation_id = ANY($1)`,
                [convIds]
            );
            memberTimes = t.rows;
        }
        const preview = (c) => {
            if (!c.last_at) return 'Say hello 👋';
            if (c.last_kind === 'image') return '📷 Photo';
            if (c.last_kind === 'voice') return '🎤 Voice note';
            return String(c.last_body || '').slice(0, 70);
        };
        res.json({
            success: true,
            conversations: r.rows.map(c => {
                const members = others.filter(o => o.conversation_id === c.id);
                const title = c.type === 'group' ? (c.name || 'Group') : (members[0] ? members[0].fullname : 'Conversation');
                let lastStatus = null;
                if (c.last_sender_me && c.last_at) {
                    const times = memberTimes.filter(m => m.conversation_id === c.id && m.user_id !== uid);
                    const allRead = times.length && times.every(m => m.last_read_at && new Date(m.last_read_at) >= new Date(c.last_at));
                    const allActive = times.length && times.every(m => m.last_active_at && new Date(m.last_active_at) >= new Date(c.last_at));
                    lastStatus = allRead ? 'read' : allActive ? 'delivered' : 'sent';
                }
                return {
                    id: c.id, type: c.type, title,
                    member_count: members.length + 1,
                    unread: c.unread,
                    last_preview: preview(c),
                    last_at: c.last_at,
                    last_sender_me: c.last_sender === uid,
                    last_status: lastStatus
                };
            })
        });
    } catch (e) {
        console.error('[Chat] List error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load chats' });
    }
});

app.post('/api/chat/conversations', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const body = req.body || {};
        if (body.userId) {
            const otherId = parseInt(body.userId, 10);
            if (!otherId || otherId === uid) return res.status(400).json({ success: false, error: 'Invalid user' });
            if (!(await areFriends(uid, otherId))) return res.status(403).json({ success: false, error: 'You can only chat with friends' });
            const existing = await pool.query(
                `SELECT c.id FROM conversations c
                 JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
                 JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
                 WHERE c.type = 'direct' LIMIT 1`,
                [uid, otherId]
            );
            if (existing.rows[0]) return res.json({ success: true, id: existing.rows[0].id, existing: true });
            const created = await pool.query(
                `INSERT INTO conversations (type, created_by) VALUES ('direct', $1) RETURNING id`,
                [uid]
            );
            const cid = created.rows[0].id;
            await pool.query(
                `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
                [cid, uid, otherId]
            );
            return res.json({ success: true, id: cid });
        }
        const name = String(body.name || '').trim().slice(0, 60);
        const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(x => parseInt(x, 10)).filter(Boolean))] : [];
        if (!name) return res.status(400).json({ success: false, error: 'Group name is required' });
        if (!memberIds.length) return res.status(400).json({ success: false, error: 'Add at least one member' });
        if (memberIds.length > 50) return res.status(400).json({ success: false, error: 'Too many members' });
        for (const mid of memberIds) {
            if (!(await areFriends(uid, mid))) return res.status(403).json({ success: false, error: 'All members must be your friends' });
        }
        const created = await pool.query(
            `INSERT INTO conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
            [name, uid]
        );
        const cid = created.rows[0].id;
        const vals = [[cid, uid, 'admin'], ...memberIds.map(mid => [cid, mid, 'member'])];
        for (const v of vals) {
            await pool.query(
                `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                v
            );
        }
        res.json({ success: true, id: cid });
    } catch (e) {
        console.error('[Chat] Create error:', e.message);
        res.status(500).json({ success: false, error: 'Could not create chat' });
    }
});

app.get('/api/chat/conversations/:id/messages', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const role = await conversationRole(cid, uid);
        if (!role) return res.status(403).json({ success: false, error: 'Not a member of this chat' });
        const limit = Math.min(80, Math.max(10, parseInt(req.query.limit, 10) || 50));
        const msgs = await pool.query(
            `SELECT m.id, m.sender_id, m.kind, m.body, m.media_duration, m.created_at, u.fullname AS sender_name
             FROM chat_messages m JOIN users u ON u.id = m.sender_id
             WHERE m.conversation_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
            [cid, limit]
        );
        const members = await pool.query(
            `SELECT user_id, last_read_at, last_active_at FROM conversation_members WHERE conversation_id = $1`,
            [cid]
        );
        await pool.query('UPDATE conversation_members SET last_active_at = NOW() WHERE conversation_id = $1 AND user_id = $2', [cid, uid]);
        if (req.query.read === '1') {
            await pool.query('UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2', [cid, uid]);
        }
        const others = members.rows.filter(m => m.user_id !== uid);
        const allRead = (at) => others.every(o => o.last_read_at && new Date(o.last_read_at) >= at);
        const allActive = (at) => others.every(o => o.last_active_at && new Date(o.last_active_at) >= at);
        const messages = msgs.rows.reverse().map(m => {
            const mine = m.sender_id === uid;
            let status = null;
            if (mine) {
                status = 'sent';
                if (allActive(m.created_at)) status = 'delivered';
                if (allRead(m.created_at)) status = 'read';
            }
            return {
                id: m.id, sender_id: m.sender_id, sender_name: m.sender_name,
                kind: m.kind, body: m.body, media_duration: m.media_duration,
                created_at: m.created_at, mine, status
            };
        });
        res.json({ success: true, messages, my_role: role });
    } catch (e) {
        console.error('[Chat] Messages error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load messages' });
    }
});

app.post('/api/chat/conversations/:id/send', isAuth, uploadMemory.single('media'), async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const role = await conversationRole(cid, uid);
        if (!role) return res.status(403).json({ success: false, error: 'Not a member of this chat' });
        const kind = String(req.body.kind || 'text');
        let body = null, media = null, mediaMime = null, mediaName = null, mediaDuration = null;

        if (kind === 'text') {
            body = String(req.body.body || '').trim().slice(0, 4000);
            if (!body) return res.status(400).json({ success: false, error: 'Message is empty' });
        } else if (kind === 'image' || kind === 'voice') {
            if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
            if (req.file.size > 8 * 1024 * 1024) return res.status(400).json({ success: false, error: 'File too large (max 8MB)' });
            if (kind === 'image' && !/^image\//.test(req.file.mimetype)) return res.status(400).json({ success: false, error: 'Not an image' });
            if (kind === 'voice' && !/^(audio|video)\//.test(req.file.mimetype)) return res.status(400).json({ success: false, error: 'Not an audio file' });
            media = req.file.buffer;
            mediaMime = req.file.mimetype;
            mediaName = String(req.file.originalname || 'media').replace(/[^\w.\- ]/g, '_').slice(0, 100);
            mediaDuration = kind === 'voice' ? Math.max(1, Math.min(600, parseInt(req.body.duration, 10) || 0)) : null;
        } else {
            return res.status(400).json({ success: false, error: 'Unknown message kind' });
        }

        const inserted = await pool.query(
            `INSERT INTO chat_messages (conversation_id, sender_id, kind, body, media, media_mime, media_name, media_duration)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
            [cid, uid, kind, body, media, mediaMime, mediaName, mediaDuration]
        );
        await pool.query(
            'UPDATE conversation_members SET last_read_at = NOW(), last_active_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
            [cid, uid]
        );
        const message = {
            id: inserted.rows[0].id,
            conversation_id: cid,
            sender_id: uid,
            sender_name: req.session.user.fullname,
            kind, body,
            media_duration: mediaDuration,
            created_at: inserted.rows[0].created_at,
            mine: true,
            status: 'sent'
        };
        emitToMembers(cid, 'chat:message', { conversationId: cid, message }, uid);
        const others = await pool.query('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2', [cid, uid]);
        for (const m of others.rows) {
            const dupe = await pool.query(
                `SELECT 1 FROM user_notifications WHERE user_id = $1 AND type = 'chat' AND is_read = false AND link = $2 LIMIT 1`,
                [m.user_id, '/chat/' + cid]
            );
            if (!dupe.rows[0]) {
                notifyUser(m.user_id, 'chat', 'New message', req.session.user.fullname + ' sent you a message', '/chat/' + cid);
            }
        }
        res.json({ success: true, message });
    } catch (e) {
        console.error('[Chat] Send error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send message' });
    }
});

app.get('/api/chat/media/:messageId', isAuth, async (req, res) => {
    try {
        const mid = parseInt(req.params.messageId, 10);
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT m.media, m.media_mime, m.media_name FROM chat_messages m
             JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
             WHERE m.id = $1`,
            [mid, uid]
        );
        if (!r.rows[0] || !r.rows[0].media) return res.status(404).json({ error: 'Media not found' });
        const file = r.rows[0];
        res.setHeader('Content-Type', file.media_mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${file.media_name || 'media'}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(file.media);
    } catch (e) { res.status(500).json({ error: 'Could not load media' }); }
});

app.post('/api/chat/conversations/:id/read', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        if (!(await conversationRole(cid, uid))) return res.status(403).json({ success: false, error: 'Not a member' });
        const at = new Date();
        await pool.query('UPDATE conversation_members SET last_read_at = $1, last_active_at = $1 WHERE conversation_id = $2 AND user_id = $3', [at, cid, uid]);
        emitToMembers(cid, 'chat:read', { conversationId: cid, userId: uid, at: at.toISOString() }, uid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not mark read' }); }
});

app.get('/api/chat/conversations/:id/info', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const myRole = await conversationRole(cid, uid);
        if (!myRole) return res.status(403).json({ success: false, error: 'Not a member' });
        const conv = await pool.query('SELECT id, type, name, created_by FROM conversations WHERE id = $1', [cid]);
        if (!conv.rows[0]) return res.status(404).json({ success: false, error: 'Chat not found' });
        const members = await pool.query(
            `SELECT u.id, u.fullname, COALESCE(u.xp, 0) AS xp, cm.role
             FROM conversation_members cm JOIN users u ON u.id = cm.user_id
             WHERE cm.conversation_id = $1 ORDER BY cm.role DESC, u.fullname`,
            [cid]
        );
        res.json({
            success: true,
            conversation: conv.rows[0],
            my_role: myRole,
            members: members.rows.map(m => ({ ...m, level: levelForXp(m.xp) }))
        });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not load chat info' }); }
});

app.post('/api/chat/conversations/:id/members', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        if ((await conversationRole(cid, uid)) !== 'admin') return res.status(403).json({ success: false, error: 'Only admins can add members' });
        const conv = await pool.query('SELECT type FROM conversations WHERE id = $1', [cid]);
        if (!conv.rows[0] || conv.rows[0].type !== 'group') return res.status(400).json({ success: false, error: 'Not a group' });
        const userIds = Array.isArray(req.body.userIds) ? [...new Set(req.body.userIds.map(x => parseInt(x, 10)).filter(Boolean))] : [];
        if (!userIds.length) return res.status(400).json({ success: false, error: 'No users selected' });
        for (const mid of userIds) {
            if (!(await areFriends(uid, mid))) return res.status(403).json({ success: false, error: 'Members must be your friends' });
        }
        for (const mid of userIds) {
            await pool.query(
                `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
                [cid, mid]
            );
        }
        const convName = await pool.query('SELECT name FROM conversations WHERE id = $1', [cid]);
        for (const mid of userIds) {
            notifyUser(mid, 'group', 'Added to group', 'You were added to ' + ((convName.rows[0] && convName.rows[0].name) || 'a group'), '/chat/' + cid);
        }
        emitToMembers(cid, 'chat:members', { conversationId: cid }, uid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not add members' }); }
});

app.post('/api/chat/conversations/:id/remove-member', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const targetId = parseInt(req.body.userId, 10);
        if ((await conversationRole(cid, uid)) !== 'admin') return res.status(403).json({ success: false, error: 'Only admins can remove members' });
        if (!targetId || targetId === uid) return res.status(400).json({ success: false, error: 'Invalid member' });
        await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [cid, targetId]);
        emitToMembers(cid, 'chat:members', { conversationId: cid }, uid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not remove member' }); }
});

app.post('/api/chat/conversations/:id/rename', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        if ((await conversationRole(cid, uid)) !== 'admin') return res.status(403).json({ success: false, error: 'Only admins can rename' });
        const name = String(req.body.name || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
        await pool.query('UPDATE conversations SET name = $1 WHERE id = $2', [name, cid]);
        emitToMembers(cid, 'chat:members', { conversationId: cid }, uid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not rename' }); }
});

app.post('/api/chat/conversations/:id/leave', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const conv = await pool.query('SELECT type FROM conversations WHERE id = $1', [cid]);
        if (!conv.rows[0]) return res.status(404).json({ success: false, error: 'Chat not found' });
        if (conv.rows[0].type === 'direct') return res.status(400).json({ success: false, error: 'Direct chats cannot be left' });
        await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [cid, uid]);
        emitToMembers(cid, 'chat:members', { conversationId: cid }, uid);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not leave group' }); }
});

app.delete('/api/chat/conversations/:id', isAuth, async (req, res) => {
    try {
        const cid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        if ((await conversationRole(cid, uid)) !== 'admin') return res.status(403).json({ success: false, error: 'Only admins can delete the group' });
        await pool.query('DELETE FROM chat_messages WHERE conversation_id = $1', [cid]);
        await pool.query('DELETE FROM conversation_members WHERE conversation_id = $1', [cid]);
        await pool.query('DELETE FROM conversations WHERE id = $1', [cid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not delete group' }); }
});

// ---- Status (stories) ----
app.post('/api/status', isAuth, uploadMemory.single('media'), async (req, res) => {
    try {
        const uid = req.session.user.id;
        const privacy = ['public', 'friends'].includes(req.body.privacy) ? req.body.privacy : 'friends';
        const kind = String(req.body.kind || 'text');
        if (kind === 'text') {
            const body = String(req.body.body || '').trim().slice(0, 200);
            if (!body) return res.status(400).json({ success: false, error: 'Status text is required' });
            const bg = /^#[0-9a-fA-F]{6}$/.test(req.body.bg_color || '') ? req.body.bg_color : '#2563eb';
            await pool.query(
                `INSERT INTO status_posts (user_id, kind, body, bg_color, privacy, expires_at)
                 VALUES ($1, 'text', $2, $3, $4, NOW() + INTERVAL '24 hours')`,
                [uid, body, bg, privacy]
            );
        } else if (kind === 'image') {
            if (!req.file) return res.status(400).json({ success: false, error: 'No image uploaded' });
            if (req.file.size > 8 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Image too large (max 8MB)' });
            if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ success: false, error: 'Not an image' });
            const caption = String(req.body.body || '').trim().slice(0, 200);
            await pool.query(
                `INSERT INTO status_posts (user_id, kind, body, media, media_mime, privacy, expires_at)
                 VALUES ($1, 'image', $2, $3, $4, $5, NOW() + INTERVAL '24 hours')`,
                [uid, caption, req.file.buffer, req.file.mimetype, privacy]
            );
        } else {
            return res.status(400).json({ success: false, error: 'Unknown status kind' });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[Status] Create error:', e.message);
        res.status(500).json({ success: false, error: 'Could not post status' });
    }
});

app.get('/api/status/feed', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT s.id, s.user_id, s.kind, s.body, s.bg_color, s.privacy, s.created_at,
                    u.fullname,
                    (SELECT COUNT(*) FROM status_views v WHERE v.status_id = s.id)::int AS views,
                    EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) AS viewed
             FROM status_posts s JOIN users u ON u.id = s.user_id
             WHERE s.expires_at > NOW() AND (
                 s.user_id = $1
                 OR s.privacy = 'public'
                 OR (s.privacy = 'friends' AND EXISTS(
                     SELECT 1 FROM friendships f
                     WHERE f.status = 'accepted'
                       AND ((f.user_id = $1 AND f.friend_id = s.user_id) OR (f.friend_id = $1 AND f.user_id = s.user_id))
                 ))
             )
             ORDER BY s.created_at ASC`,
            [uid]
        );
        const groups = {};
        r.rows.forEach(s => {
            if (!groups[s.user_id]) groups[s.user_id] = { user_id: s.user_id, fullname: s.fullname, is_me: s.user_id === uid, all_viewed: true, statuses: [] };
            const g = groups[s.user_id];
            g.statuses.push({
                id: s.id, kind: s.kind, body: s.body, bg_color: s.bg_color,
                privacy: s.privacy, created_at: s.created_at, views: s.views, viewed: s.viewed
            });
            if (!s.viewed) g.all_viewed = false;
        });
        const list = Object.values(groups).sort((a, b) => {
            if (a.is_me !== b.is_me) return a.is_me ? -1 : 1;
            if (a.all_viewed !== b.all_viewed) return a.all_viewed ? 1 : -1;
            return b.statuses[b.statuses.length - 1].created_at - a.statuses[a.statuses.length - 1].created_at;
        });
        res.json({ success: true, groups: list });
    } catch (e) {
        console.error('[Status] Feed error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load status feed' });
    }
});

app.post('/api/status/:id/view', isAuth, async (req, res) => {
    try {
        const sid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        await pool.query('INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sid, uid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not mark viewed' }); }
});

app.delete('/api/status/:id', isAuth, async (req, res) => {
    try {
        const sid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        await pool.query('DELETE FROM status_posts WHERE id = $1 AND user_id = $2', [sid, uid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not delete status' }); }
});

app.get('/api/status/media/:id', isAuth, async (req, res) => {
    try {
        const sid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const r = await pool.query(
            `SELECT s.media, s.media_mime, s.privacy, s.user_id FROM status_posts s WHERE s.id = $1 AND s.expires_at > NOW()`,
            [sid]
        );
        const post = r.rows[0];
        if (!post || !post.media) return res.status(404).json({ error: 'Not found' });
        let allowed = post.user_id === uid || post.privacy === 'public';
        if (!allowed && post.privacy === 'friends') allowed = await areFriends(uid, post.user_id);
        if (!allowed) return res.status(403).json({ error: 'Not allowed' });
        res.setHeader('Content-Type', post.media_mime || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(post.media);
    } catch (e) { res.status(500).json({ error: 'Could not load media' }); }
});

// ---- Per-user notifications ----
(async function initUserNotifications() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS user_notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            type VARCHAR(20) NOT NULL,
            title VARCHAR(140) NOT NULL,
            body VARCHAR(300),
            link VARCHAR(200),
            is_read BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_notifs ON user_notifications(user_id, created_at DESC)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS notification_reads (
            notification_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            read_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (notification_id, user_id)
        )`);
        console.log('[Notifications] Table ready');
    } catch (e) { console.error('[Notifications] Init:', e.message); }
})();

async function notifyUser(userId, type, title, body, link) {
    try {
        await pool.query(
            'INSERT INTO user_notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)',
            [userId, type, title, body || '', link || '']
        );
        if (io) io.to('user_' + userId).emit('notify', { type, title });
    } catch (e) { console.error('[Notify]', e.message); }
}

app.get('/api/notifications/mine', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const r = await pool.query(
            'SELECT id, type, title, body, link, is_read, created_at FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
            [uid]
        );
        const unread = await pool.query('SELECT COUNT(*)::int AS c FROM user_notifications WHERE user_id = $1 AND is_read = false', [uid]);
        res.json({ success: true, notifications: r.rows, unread: unread.rows[0].c });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not load notifications' }); }
});

app.post('/api/notifications/mine/read', isAuth, async (req, res) => {
    try {
        await pool.query('UPDATE user_notifications SET is_read = true WHERE user_id = $1', [req.session.user.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not mark read' }); }
});

// ---- Feed (posts) ----
(async function initFeed() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS feed_posts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            body TEXT,
            image BYTEA,
            image_mime VARCHAR(100),
            created_at TIMESTAMP DEFAULT NOW()
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feed_posts ON feed_posts(user_id, id DESC)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS feed_likes (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (post_id, user_id)
        )`);
        console.log('[Feed] Tables ready');
    } catch (e) { console.error('[Feed] Init:', e.message); }
})();

app.post('/api/feed', isAuth, uploadMemory.single('image'), async (req, res) => {
    try {
        const uid = req.session.user.id;
        const body = String(req.body.body || '').trim().slice(0, 1000);
        const hasImage = !!req.file;
        if (!body && !hasImage) return res.status(400).json({ success: false, error: 'Write a caption or add a photo' });
        if (hasImage) {
            if (req.file.size > 8 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Image too large (max 8MB)' });
            if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ success: false, error: 'Not an image' });
        }
        await pool.query(
            'INSERT INTO feed_posts (user_id, body, image, image_mime) VALUES ($1, $2, $3, $4)',
            [uid, body || null, hasImage ? req.file.buffer : null, hasImage ? req.file.mimetype : null]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('[Feed] Post error:', e.message);
        res.status(500).json({ success: false, error: 'Could not create post' });
    }
});

app.get('/api/feed', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const before = parseInt(req.query.before, 10) || 0;
        const params = [uid];
        let where = `(p.user_id = $1 OR p.user_id IN (
            SELECT CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END
            FROM friendships f WHERE f.status = 'accepted' AND (f.user_id = $1 OR f.friend_id = $1)
        ))`;
        if (before) { params.push(before); where += ' AND p.id < $' + (params.length); }
        const r = await pool.query(
            `SELECT p.id, p.user_id, p.body, (p.image IS NOT NULL) AS has_image, p.created_at,
                    u.fullname, COALESCE(u.xp, 0) AS xp,
                    (SELECT COUNT(*) FROM feed_likes l WHERE l.post_id = p.id)::int AS likes,
                    EXISTS(SELECT 1 FROM feed_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
             FROM feed_posts p JOIN users u ON u.id = p.user_id
             WHERE ${where}
             ORDER BY p.id DESC LIMIT 20`,
            params
        );
        res.json({
            success: true,
            posts: r.rows.map(p => ({
                id: p.id, user_id: p.user_id, fullname: p.fullname, level: levelForXp(p.xp),
                body: p.body, has_image: p.has_image, created_at: p.created_at,
                likes: p.likes, liked: p.liked, mine: p.user_id === uid
            })),
            has_more: r.rows.length === 20
        });
    } catch (e) {
        console.error('[Feed] List error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load feed' });
    }
});

app.post('/api/feed/:id/like', isAuth, async (req, res) => {
    try {
        const pid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const post = await pool.query('SELECT user_id FROM feed_posts WHERE id = $1', [pid]);
        if (!post.rows[0]) return res.status(404).json({ success: false, error: 'Post not found' });
        const authorId = post.rows[0].user_id;
        const canSee = authorId === uid || await areFriends(uid, authorId);
        if (!canSee) return res.status(403).json({ success: false, error: 'Not allowed' });
        const existing = await pool.query('SELECT 1 FROM feed_likes WHERE post_id = $1 AND user_id = $2', [pid, uid]);
        let liked;
        if (existing.rows[0]) {
            await pool.query('DELETE FROM feed_likes WHERE post_id = $1 AND user_id = $2', [pid, uid]);
            liked = false;
        } else {
            await pool.query('INSERT INTO feed_likes (post_id, user_id) VALUES ($1, $2)', [pid, uid]);
            liked = true;
            if (authorId !== uid) notifyUser(authorId, 'like', 'New like', req.session.user.fullname + ' liked your post', '/chat?tab=feed');
        }
        const count = await pool.query('SELECT COUNT(*)::int AS c FROM feed_likes WHERE post_id = $1', [pid]);
        res.json({ success: true, liked, likes: count.rows[0].c });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not like post' }); }
});

app.delete('/api/feed/:id', isAuth, async (req, res) => {
    try {
        const pid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        await pool.query('DELETE FROM feed_posts WHERE id = $1 AND user_id = $2', [pid, uid]);
        await pool.query('DELETE FROM feed_likes WHERE post_id = $1', [pid]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Could not delete post' }); }
});

app.get('/api/feed/media/:id', isAuth, async (req, res) => {
    try {
        const pid = parseInt(req.params.id, 10);
        const uid = req.session.user.id;
        const r = await pool.query('SELECT image, image_mime, user_id FROM feed_posts WHERE id = $1', [pid]);
        const post = r.rows[0];
        if (!post || !post.image) return res.status(404).json({ error: 'Not found' });
        const canSee = post.user_id === uid || await areFriends(uid, post.user_id);
        if (!canSee) return res.status(403).json({ error: 'Not allowed' });
        res.setHeader('Content-Type', post.image_mime || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.send(post.image);
    } catch (e) { res.status(500).json({ error: 'Could not load image' }); }
});

// ---- Public profile (no academic/CGPA data) ----
app.get('/api/users/:id/profile', isAuth, async (req, res) => {
    try {
        const uid = req.session.user.id;
        const targetId = parseInt(req.params.id, 10);
        if (!targetId) return res.status(400).json({ success: false, error: 'Invalid user' });
        const u = await pool.query('SELECT id, fullname, COALESCE(xp, 0) AS xp, created_at FROM users WHERE id = $1', [targetId]);
        if (!u.rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
        const target = u.rows[0];
        const games = await pool.query(
            `SELECT game, COUNT(*)::int AS plays, COALESCE(MAX(score), 0)::int AS best,
                    COALESCE(SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END), 0)::int AS wins
             FROM game_results WHERE user_id = $1 GROUP BY game`,
            [targetId]
        );
        const friendsCount = await pool.query(
            `SELECT COUNT(*)::int AS c FROM friendships WHERE status = 'accepted' AND (user_id = $1 OR friend_id = $1)`,
            [targetId]
        );
        let relationship = 'none';
        if (targetId === uid) {
            relationship = 'self';
        } else {
            const rel = await pool.query(
                `SELECT user_id, status FROM friendships
                 WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
                [uid, targetId]
            );
            if (rel.rows[0]) {
                if (rel.rows[0].status === 'accepted') relationship = 'friends';
                else relationship = rel.rows[0].user_id === uid ? 'request_sent' : 'request_received';
            }
        }
        res.json({
            success: true,
            profile: {
                id: target.id,
                fullname: target.fullname,
                xp: target.xp,
                level: levelForXp(target.xp),
                joined: target.created_at,
                games: games.rows,
                friends_count: friendsCount.rows[0].c,
                relationship
            }
        });
    } catch (e) {
        console.error('[Profile] error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load profile' });
    }
});

app.get('/u/:id', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | Profile';
    res.render('profile-view', { user: req.session.user, profileId: parseInt(req.params.id, 10) || 0 });
});

// ======================== HOLIDAY MODE ========================
// Students activate it manually; Prepium may recommend it when the academic
// calendar supports it. Returning to academic mode never loses progress.
app.get('/holiday', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const [modeRes, goalsRes] = await Promise.all([
        pool.query('SELECT * FROM holiday_mode WHERE user_id = $1', [uid]),
        pool.query('SELECT * FROM holiday_goals WHERE user_id = $1 ORDER BY is_done ASC, created_at DESC', [uid])
    ]);
    const mode = modeRes.rows[0] || { is_active: false };
    res.locals.seo.title = 'Prepium | Holiday Mode';
    res.render('holiday', {
        user: req.session.user,
        active: !!mode.is_active,
        activatedAt: mode.activated_at || null,
        source: mode.source || 'manual',
        goals: goalsRes.rows,
        activeNav: 'holiday'
    });
}));

app.post('/api/holiday/toggle', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const activate = !!(req.body && req.body.activate);
    const source = (req.body && req.body.source === 'recommended') ? 'recommended' : 'manual';
    const r = await pool.query(`
        INSERT INTO holiday_mode (user_id, is_active, activated_at, deactivated_at, source)
        VALUES ($1, $2, CASE WHEN $2 THEN NOW() ELSE NULL END, CASE WHEN $2 THEN NULL ELSE NOW() END, $3)
        ON CONFLICT (user_id) DO UPDATE SET
            is_active = EXCLUDED.is_active,
            activated_at = CASE WHEN EXCLUDED.is_active THEN NOW() ELSE holiday_mode.activated_at END,
            deactivated_at = CASE WHEN EXCLUDED.is_active THEN holiday_mode.deactivated_at ELSE NOW() END,
            source = EXCLUDED.source
        RETURNING is_active`, [uid, activate, source]);
    res.json({ success: true, active: r.rows[0].is_active });
}));

app.post('/api/holiday/goals', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const types = ['revision', 'skills', 'projects', 'reading', 'challenges', 'opportunities', 'community'];
    const { title, goal_type, target_value } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ success: false, error: 'Goal title is required.' });
    if (!types.includes(goal_type)) return res.status(400).json({ success: false, error: 'Invalid goal type.' });
    const tv = Math.max(1, Math.min(1000, parseInt(target_value, 10) || 1));
    const r = await pool.query(
        'INSERT INTO holiday_goals (user_id, goal_type, title, target_value) VALUES ($1, $2, $3, $4) RETURNING *',
        [uid, goal_type, String(title).trim().slice(0, 200), tv]
    );
    res.json({ success: true, goal: r.rows[0] });
}));

app.post('/api/holiday/goals/:id/progress', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const delta = Math.max(-100, Math.min(100, parseInt(req.body && req.body.delta, 10) || 0));
    const g = await pool.query('SELECT * FROM holiday_goals WHERE id = $1 AND user_id = $2', [id, uid]);
    if (!g.rows[0]) return res.status(404).json({ success: false, error: 'Goal not found.' });
    const goal = g.rows[0];
    const newValue = Math.max(0, Math.min(goal.target_value, (parseInt(goal.progress_value, 10) || 0) + delta));
    const done = newValue >= goal.target_value;
    let xpResult = { awarded: false };
    if (done && !goal.is_done) {
        xpResult = await xpLib.awardXP(pool, uid, 50, 'holiday_goal', 'goal_' + id, 'Holiday goal completed: ' + goal.title);
    }
    const u = await pool.query(
        'UPDATE holiday_goals SET progress_value = $1, is_done = $2, completed_at = CASE WHEN $2 THEN COALESCE(completed_at, NOW()) ELSE NULL END WHERE id = $3 AND user_id = $4 RETURNING *',
        [newValue, done, id, uid]
    );
    res.json({ success: true, goal: u.rows[0], xp_awarded: xpResult.awarded ? 50 : 0, xp_balance: xpResult.balance });
}));

app.post('/api/holiday/goals/:id/delete', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    await pool.query('DELETE FROM holiday_goals WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10), uid]);
    res.json({ success: true });
}));

// Holiday Mode link: verified challenge activity (daily challenges completed,
// Prepium Challenges completed) auto-progresses the student's holiday goals of
// type 'challenges' while Holiday Mode is active. Mirrors the manual progress
// endpoint — same +50 XP ledger event key per goal, so no double awards.
async function progressHolidayGoalsByType(uid, goalType, delta) {
    if (!delta) return;
    try {
        const mode = await pool.query('SELECT is_active FROM holiday_mode WHERE user_id = $1', [uid]);
        if (!mode.rows[0] || !mode.rows[0].is_active) return;
        const goals = await pool.query(
            'SELECT id, title, target_value, progress_value FROM holiday_goals WHERE user_id = $1 AND goal_type = $2 AND is_done = false',
            [uid, goalType]
        );
        for (const goal of goals.rows) {
            const current = parseInt(goal.progress_value, 10) || 0;
            const newValue = Math.max(0, Math.min(goal.target_value, current + delta));
            if (newValue === current) continue;
            const done = newValue >= goal.target_value;
            if (done) {
                await xpLib.awardXP(pool, uid, 50, 'holiday_goal', 'goal_' + goal.id, 'Holiday goal completed: ' + goal.title);
            }
            await pool.query(
                'UPDATE holiday_goals SET progress_value = $1, is_done = $2, completed_at = CASE WHEN $2 THEN COALESCE(completed_at, NOW()) ELSE NULL END WHERE id = $3 AND user_id = $4',
                [newValue, done, goal.id, uid]
            );
        }
    } catch (e) { console.error('[Holiday] auto-progress:', e.message); }
}

// ======================== PERSONAL ACADEMIC INTELLIGENCE ========================
// Gate: every new-feature route below depends on migration 001 tables. Await
// the boot migration before serving them so a cold start can never serve a
// request before the tables exist (fixes "something went wrong" on first hit).
app.use(['/insights', '/wrapped', '/skills', '/holiday', '/challenges', '/opportunities'], (req, res, next) => {
    migrationsReady.then(() => next()).catch(next);
});

// Deterministic, server-side analysis of the student's own academic activity.
// Clearly distinguishes "not enough data" from "needs attention" and never
// invents grades or results.
function buildAcademicInsights(rows) {
    const { cgpaRow, results, studyMinutes, streak } = rows;
    const signals = [];
    const dataSources = [];

    // CGPA signal (only when the student maintains a CGPA profile)
    if (cgpaRow && cgpaRow.totalUnits > 0) {
        dataSources.push('cgpa');
        const pct = Math.round((cgpaRow.cgpaNumber / cgpaRow.scale) * 100);
        signals.push({
            key: 'cgpa', title: 'Cumulative standing',
            detail: `CGPA ${cgpaRow.cgpa} / ${cgpaRow.scale} (${cgpaRow.degreeClass})`,
            status: pct >= 60 ? 'good' : (pct >= 45 ? 'watch' : 'attention')
        });
    }

    // Quiz/assessment signal — needs at least 3 attempts before judging
    if (results.length >= 3) {
        dataSources.push('assessments');
        const avg = results.reduce((s, r) => s + (r.total > 0 ? (r.score / r.total) : 0), 0) / results.length;
        const weak = results.filter(r => r.total > 0 && (r.score / r.total) < 0.5);
        const strong = results.filter(r => r.total > 0 && (r.score / r.total) >= 0.75);
        signals.push({
            key: 'assessments', title: 'Assessment performance',
            detail: `Average ${Math.round(avg * 100)}% across ${results.length} attempts`,
            status: avg >= 0.6 ? 'good' : (avg >= 0.45 ? 'watch' : 'attention')
        });
        if (weak.length >= 2) {
            const bySubject = {};
            weak.forEach(r => { const k = r.subject || 'General'; bySubject[k] = (bySubject[k] || 0) + 1; });
            const weakest = Object.entries(bySubject).sort((a, b) => b[1] - a[1])[0][0];
            signals.push({
                key: 'weak_topics', title: 'Area needing attention',
                detail: `${weak.length} low-scoring attempts — most often in ${weakest}. Prioritise revising it.`,
                status: 'attention'
            });
        }
        if (strong.length >= 2) {
            const bySubject = {};
            strong.forEach(r => { const k = r.subject || 'General'; bySubject[k] = (bySubject[k] || 0) + 1; });
            const strongest = Object.entries(bySubject).sort((a, b) => b[1] - a[1])[0][0];
            signals.push({
                key: 'strong_topics', title: 'Topic strength',
                detail: `Consistently strong in ${strongest} — keep it warm with spaced revision.`,
                status: 'good'
            });
        }
    }

    // Study-time signal — needs at least 60 minutes total before judging
    if (studyMinutes >= 60) {
        dataSources.push('study_time');
        const daily = studyMinutes / 14; // last 14 days
        signals.push({
            key: 'study_time', title: 'Study consistency',
            detail: `${studyMinutes} minutes studied in the last 14 days (~${Math.round(daily)} min/day)`,
            status: daily >= 30 ? 'good' : (daily >= 10 ? 'watch' : 'attention')
        });
    } else if (studyMinutes > 0) {
        dataSources.push('study_time');
    }

    // Streak signal
    if (streak >= 3) {
        dataSources.push('streak');
        signals.push({
            key: 'streak', title: 'Momentum',
            detail: `${streak}-day login streak — consistency compounds.`,
            status: 'good'
        });
    }

    const enoughData = dataSources.length >= 2;
    const recommendations = [];
    if (!enoughData) {
        recommendations.push('Prepium needs more academic activity before it can identify strengths and gaps. Take a few quizzes, log study sessions and keep your CGPA record updated — insights appear automatically, and insufficient data is never reported as poor performance.');
    } else {
        if (signals.some(s => s.key === 'weak_topics')) recommendations.push('Schedule focused revision for your weakest subject this week — short daily blocks beat one long cram.');
        if (signals.some(s => s.key === 'study_time' && s.status !== 'good')) recommendations.push('Increase study consistency: aim for at least 30 minutes on most days.');
        if (signals.some(s => s.key === 'assessments' && s.status === 'attention')) recommendations.push('Re-attempt practice quizzes on low-scoring topics and review the explanations for every wrong answer.');
        if (signals.some(s => s.key === 'cgpa' && s.status !== 'good')) recommendations.push('Use the CGPA what-if builder to see exactly which grades would lift your standing.');
        if (recommendations.length === 0) recommendations.push('You are on a solid track. Keep your routine and add one stretch goal this week — a new Skills Centre path is a good start.');
    }

    return { enoughData, dataSources, signals, recommendations };
}

app.get('/insights', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const [profileRes, resultsRes, studyRes, streakRes, planRes] = await Promise.all([
        pool.query('SELECT grading_scale, prev_units, prev_gp FROM public.cgpa_profiles WHERE user_id = $1', [uid]),
        pool.query(`
            SELECT subject, score, total_questions FROM (
                SELECT s.name AS subject, r.score, r.total_questions, r.taken_at AS at FROM results r LEFT JOIN subjects s ON r.subject_id = s.id WHERE r.user_id = $1
                UNION ALL
                SELECT COALESCE(s2.name, q.title, 'Practice') AS subject, q.score, q.total_questions, q.created_at AS at FROM quiz_results q LEFT JOIN subjects s2 ON q.subject_id = s2.id WHERE q.user_id = $1
            ) combined ORDER BY at DESC LIMIT 30`, [uid]),
        pool.query(`SELECT COALESCE(SUM(elapsed_seconds), 0) AS secs FROM study_sessions WHERE user_id = $1 AND status = 'completed' AND created_at > NOW() - INTERVAL '14 days'`, [uid]),
        pool.query('SELECT current_streak FROM login_streaks WHERE user_id = $1', [uid]),
        pool.query('SELECT * FROM study_plans WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [uid])
    ]);

    const cgpaRow = profileRes.rows[0]
        ? cgpaLib.computeCGPA({
            scale: profileRes.rows[0].grading_scale,
            prevUnits: profileRes.rows[0].prev_units,
            prevPoints: profileRes.rows[0].prev_gp,
            courses: []
          })
        : null;

    const insights = buildAcademicInsights({
        cgpaRow,
        results: resultsRes.rows,
        studyMinutes: Math.round(parseInt(studyRes.rows[0].secs, 10) / 60),
        streak: parseInt(streakRes.rows[0]?.current_streak, 10) || 0
    });

    res.locals.seo.title = 'Prepium | Academic Insights';
    res.render('insights', {
        user: req.session.user,
        insights,
        plan: planRes.rows[0] || null,
        activeNav: 'insights'
    });
}));

// Editable daily/weekly study plans (recommendations are suggestions; the
// student can edit everything).
app.post('/api/insights/plan', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const period = (req.body && req.body.period_type === 'daily') ? 'daily' : 'weekly';
    let items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    items = items.slice(0, 20).map(it => ({
        title: String(it && it.title || '').trim().slice(0, 160),
        done: !!(it && it.done)
    })).filter(it => it.title);
    const existing = await pool.query('SELECT id FROM study_plans WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1', [uid]);
    let plan;
    if (existing.rows[0]) {
        plan = await pool.query(
            'UPDATE study_plans SET title = $1, period_type = $2, items = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
            [(req.body && req.body.title) || 'My study plan', period, JSON.stringify(items), existing.rows[0].id]
        );
    } else {
        plan = await pool.query(
            'INSERT INTO study_plans (user_id, title, period_type, items) VALUES ($1, $2, $3, $4) RETURNING *',
            [uid, (req.body && req.body.title) || 'My study plan', period, JSON.stringify(items)]
        );
    }
    res.json({ success: true, plan: plan.rows[0] });
}));

// ======================== PREPIUM WRAPPED ========================
// Weekly / semester / annual learning summaries with shareable cards and
// privacy controls. CGPA and private academic data are NEVER auto-exposed.
async function buildWrapped(uid, periodType) {
    let sinceSql, label;
    if (periodType === 'weekly') { sinceSql = "NOW() - INTERVAL '7 days'"; label = 'This Week'; }
    else if (periodType === 'semester') { sinceSql = "NOW() - INTERVAL '4 months'"; label = 'This Semester'; }
    else { sinceSql = "NOW() - INTERVAL '1 year'"; label = 'This Year'; }

    const [quizzesRes, studyRes, gamesRes, xpRes, streakRes, lessonsRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS c FROM (
            SELECT 1 FROM results WHERE user_id = $1 AND taken_at >= ${sinceSql}
            UNION ALL SELECT 1 FROM quiz_results WHERE user_id = $1 AND created_at >= ${sinceSql}
            UNION ALL SELECT 1 FROM daily_challenge_attempts WHERE user_id = $1 AND created_at >= ${sinceSql} AND completed = true
        ) q`, [uid]),
        pool.query(`SELECT COALESCE(SUM(elapsed_seconds), 0) AS secs, COUNT(*) AS sessions FROM study_sessions WHERE user_id = $1 AND status = 'completed' AND created_at >= ${sinceSql}`, [uid]),
        pool.query(`SELECT COUNT(*) AS plays, COALESCE(SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END), 0) AS wins FROM game_results WHERE user_id = $1 AND created_at >= ${sinceSql}`, [uid]),
        pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM xp_ledger WHERE user_id = $1 AND created_at >= ${sinceSql}`, [uid]),
        pool.query('SELECT current_streak, longest_streak FROM login_streaks WHERE user_id = $1', [uid]),
        pool.query(`SELECT COUNT(*) AS c FROM skill_progress WHERE user_id = $1 AND completed_at >= ${sinceSql}`, [uid])
    ]);

    // Top subjects by attempts (verified activity only)
    const topRes = await pool.query(`
        SELECT subject, COUNT(*) AS c, ROUND(AVG(pct) * 100) AS avg_pct FROM (
            SELECT s.name AS subject, (r.score::float / NULLIF(r.total_questions, 0)) AS pct
            FROM results r LEFT JOIN subjects s ON r.subject_id = s.id
            WHERE r.user_id = $1 AND r.taken_at >= ${sinceSql} AND r.total_questions > 0
            UNION ALL
            SELECT COALESCE(s2.name, q.title, 'Practice') AS subject, (q.score::float / NULLIF(q.total_questions, 0)) AS pct
            FROM quiz_results q LEFT JOIN subjects s2 ON q.subject_id = s2.id
            WHERE q.user_id = $1 AND q.created_at >= ${sinceSql} AND q.total_questions > 0
        ) t GROUP BY subject ORDER BY c DESC LIMIT 5`, [uid]);

    return {
        period: periodType,
        label,
        quizzes: parseInt(quizzesRes.rows[0].c, 10) || 0,
        studyMinutes: Math.round(parseInt(studyRes.rows[0].secs, 10) / 60),
        studySessions: parseInt(studyRes.rows[0].sessions, 10) || 0,
        gamesPlayed: parseInt(gamesRes.rows[0].plays, 10) || 0,
        gamesWon: parseInt(gamesRes.rows[0].wins, 10) || 0,
        xpEarned: parseInt(xpRes.rows[0].total, 10) || 0,
        streak: parseInt(streakRes.rows[0]?.current_streak, 10) || 0,
        longestStreak: parseInt(streakRes.rows[0]?.longest_streak, 10) || 0,
        lessonsCompleted: parseInt(lessonsRes.rows[0].c, 10) || 0,
        topSubjects: topRes.rows.map(r => ({ subject: r.subject, attempts: parseInt(r.c, 10), avg: parseInt(r.avg_pct, 10) || 0 }))
    };
}

app.get('/wrapped', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const periodType = ['weekly', 'semester', 'annual'].includes(req.query.period) ? req.query.period : 'weekly';
    const summary = await buildWrapped(uid, periodType);
    const shares = await pool.query('SELECT id, share_token, period_type, is_public, show_cgpa, created_at FROM wrapped_shares WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [uid]);
    res.locals.seo.title = 'Prepium | Wrapped';
    res.render('wrapped', {
        user: req.session.user,
        summary,
        shares: shares.rows,
        activeNav: 'wrapped'
    });
}));

app.post('/api/wrapped/share', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const periodType = ['weekly', 'semester', 'annual'].includes(req.body && req.body.period) ? req.body.period : 'weekly';
    const summary = await buildWrapped(uid, periodType);
    // Privacy controls: the share payload only ever contains verified
    // activity counts. CGPA is included ONLY if the student explicitly opts in.
    const showCgpa = !!(req.body && req.body.show_cgpa);
    let cgpa = null;
    if (showCgpa) {
        const p = await pool.query('SELECT grading_scale, prev_units, prev_gp FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
        if (p.rows[0]) {
            const t = cgpaLib.computeCGPA({ scale: p.rows[0].grading_scale, prevUnits: p.rows[0].prev_units, prevPoints: p.rows[0].prev_gp, courses: [] });
            if (t.totalUnits > 0) cgpa = { cgpa: t.cgpa, scale: t.scale, degreeClass: t.degreeClass };
        }
    }
    const payload = { ...summary, cgpa };
    const token = crypto.randomBytes(24).toString('hex');
    const r = await pool.query(
        'INSERT INTO wrapped_shares (user_id, share_token, period_type, payload, is_public, show_cgpa) VALUES ($1, $2, $3, $4, true, $5) RETURNING share_token',
        [uid, token, periodType, JSON.stringify(payload), showCgpa]
    );
    res.json({ success: true, token: r.rows[0].share_token, url: '/wrapped/' + r.rows[0].share_token });
}));

app.post('/api/wrapped/share/:token/visibility', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const isPublic = !!(req.body && req.body.is_public);
    const r = await pool.query('UPDATE wrapped_shares SET is_public = $1 WHERE share_token = $2 AND user_id = $3 RETURNING share_token, is_public',
        [isPublic, req.params.token, uid]);
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Share not found.' });
    res.json({ success: true, is_public: r.rows[0].is_public });
}));

app.get('/wrapped/:token', asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT * FROM wrapped_shares WHERE share_token = $1 AND is_public = true', [req.params.token]);
    if (!r.rows[0]) return res.status(404).render('public-form-notfound', { user: null });
    const owner = await pool.query('SELECT fullname FROM users WHERE id = $1', [r.rows[0].user_id]);
    res.locals.seo.title = 'Prepium | Wrapped';
    res.render('wrapped-card', {
        user: req.session.user || null,
        payload: r.rows[0].payload,
        ownerName: owner.rows[0] ? owner.rows[0].fullname : 'A student',
        periodType: r.rows[0].period_type
    });
}));

// ======================== SKILLS CENTRE ========================
const SKILL_SEED = [
    { slug: 'programming', title: 'Programming Foundations', icon: 'fa-code', tone: 'blue', description: 'Think like a programmer: variables, logic, functions and problem solving.', lessons: [
        { title: 'What is programming?', summary: 'How instructions become software.', content: 'Programming is writing precise instructions a computer can execute. Start by breaking problems into small steps (input → process → output). Every language shares these building blocks: variables store data, conditionals make decisions, loops repeat work, and functions package reusable logic. Practice: write the steps for making jollof rice as pseudocode — you are already programming.', est: 20, resource: 'https://www.freecodecamp.org/learn/', resourceLabel: 'freeCodeCamp curriculum' },
        { title: 'Variables & data types', summary: 'Numbers, strings, booleans and why types matter.', content: 'A variable is a labelled box for a value. Common types: numbers (age = 20), strings ("Prepium"), booleans (true/false) and lists. Strong typing prevents bugs: "5" + 3 can be "53" or 8 depending on the language — always know your types. Practice: create variables for your name, level and CGPA target, then print a sentence using them.', est: 25, resource: 'https://javascript.info/variables', resourceLabel: 'JavaScript.info — Variables' },
        { title: 'Conditionals & loops', summary: 'Make decisions and repeat work efficiently.', content: 'Conditionals (if/else) let code choose paths: if score >= 50 then "Pass" else "Retake". Loops repeat work: for-loops when you know the count, while-loops when you do not. Combine them to grade 100 students automatically. Practice: write a loop that prints 1–20 but replaces multiples of 3 with "Prep".', est: 30, resource: 'https://javascript.info/while-for', resourceLabel: 'JavaScript.info — Loops' },
        { title: 'Functions & problem decomposition', summary: 'Break big problems into small named steps.', content: 'A function takes inputs, does work, and returns an output. Decomposition — splitting a big problem into small functions — is the core engineering skill. Write calculateGPA(courses) once and reuse it everywhere instead of copy-pasting logic. Practice: write a function that takes a score and returns the Nigerian letter grade.', est: 30, resource: 'https://javascript.info/function-basics', resourceLabel: 'JavaScript.info — Functions' },
        { title: 'Mini project: CGPA calculator', summary: 'Apply everything in one small build.', content: 'Build a console program that asks for course codes, units and grades, then prints the CGPA and class of degree. Use variables for storage, a loop for input, conditionals for the degree class, and one function per responsibility. This mirrors exactly how the Prepium CGPA tracker works internally.', est: 60, resource: '', resourceLabel: '' }
    ]},
    { slug: 'web-development', title: 'Web Development', icon: 'fa-laptop-code', tone: 'green', description: 'Build real websites: HTML, CSS, JavaScript and deployment.', lessons: [
        { title: 'HTML: the skeleton', summary: 'Structure content with semantic tags.', content: 'HTML describes structure: headings (h1–h6), paragraphs, lists, links, images and forms. Semantic tags (header, nav, main, footer) describe meaning, which helps accessibility and SEO. Every Prepium page you use is HTML underneath. Practice: write a profile card for yourself with a photo, name, department and a list of skills.', est: 25, resource: 'https://developer.mozilla.org/en-US/docs/Learn/HTML', resourceLabel: 'MDN — Learn HTML' },
        { title: 'CSS: the skin', summary: 'Style, layout, flexbox and responsive design.', content: 'CSS controls appearance: colours, fonts, spacing and layout. The box model wraps every element (content → padding → border → margin). Flexbox aligns items in rows/columns; media queries adapt layouts to phone screens — essential since most Prepium students browse on phones. Practice: style your profile card with a gradient header and centred layout.', est: 35, resource: 'https://developer.mozilla.org/en-US/docs/Learn/CSS', resourceLabel: 'MDN — Learn CSS' },
        { title: 'JavaScript: the brain', summary: 'Interactivity, events and DOM manipulation.', content: 'JavaScript makes pages respond: click handlers, form validation, live updates. The DOM is the page as a tree of objects you can read and change: document.querySelector(".btn").addEventListener("click", ...). Practice: add a button to your card that toggles dark mode.', est: 40, resource: 'https://javascript.info/document', resourceLabel: 'JavaScript.info — DOM' },
        { title: 'Mini project: personal portfolio', summary: 'Ship a one-page site about yourself.', content: 'Combine HTML, CSS and JS into a portfolio: hero section, skills grid, contact form with validation. Deploy it free on GitHub Pages or Netlify. A live link is stronger than a certificate — share it in your Prepium profile and with recruiters.', est: 90, resource: 'https://pages.github.com/', resourceLabel: 'GitHub Pages guide' }
    ]},
    { slug: 'ui-ux', title: 'UI/UX Design', icon: 'fa-pencil-ruler', tone: 'purple', description: 'Design interfaces people love: research, wireframes, prototypes.', lessons: [
        { title: 'UX fundamentals', summary: 'Users, goals, journeys and friction.', content: 'UX is how a product works; UI is how it looks. Start with user goals: a student opening Prepium wants today\u2019s task in one tap. Map the journey, remove every unnecessary step, and make the next action obvious. Good UX is invisible — frustration is the only thing users notice. Practice: list 5 friction points in an app you use daily and propose fixes.', est: 25, resource: 'https://www.nngroup.com/articles/ux-basics/', resourceLabel: 'NN Group — UX Basics' },
        { title: 'Visual hierarchy & layout', summary: 'Guide the eye with size, contrast and spacing.', content: 'Users scan, not read. Establish hierarchy: one primary action per screen, larger/contrastier for what matters first, generous whitespace to group related items. Use a consistent 8px spacing scale and at most 2 font families. Practice: redesign a cluttered screen by ranking its elements and demoting the bottom half.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Wireframing & prototyping', summary: 'Sketch fast, test early, iterate cheaply.', content: 'Wireframes are low-fidelity sketches of layout; prototypes link screens to simulate flow. Test with 5 real users — most usability problems surface by the fifth person. Fix the biggest issue, retest, repeat. Practice: wireframe a "holiday study planner" screen on paper, then test it with two coursemates.', est: 40, resource: 'https://www.figma.com/resource-library/design-basics/', resourceLabel: 'Figma — Design basics' },
        { title: 'Mini project: redesign a Prepium screen', summary: 'Apply the full process to a real screen.', content: 'Pick any Prepium screen. Document the current flow, identify 3 problems, sketch alternatives, build a clickable Figma prototype and write a short rationale. This becomes a portfolio piece that demonstrates process, not just pixels.', est: 90, resource: '', resourceLabel: '' }
    ]},
    { slug: 'graphic-design', title: 'Graphic Design', icon: 'fa-palette', tone: 'orange', description: 'Colour, typography, layout and brand-quality flyers.', lessons: [
        { title: 'Design principles', summary: 'Balance, contrast, alignment, repetition, proximity.', content: 'Strong design is principles applied deliberately: contrast makes headlines pop, alignment creates order, proximity groups related items, repetition builds identity. Break a rule only when you can say why. Practice: find two flyers — one effective, one messy — and annotate which principles each follows or breaks.', est: 25, resource: '', resourceLabel: '' },
        { title: 'Colour & typography', summary: 'Palettes with purpose; fonts that speak.', content: 'Use a limited palette: one dominant, one accent, neutrals for the rest. Check contrast for readability (WCAG). Pair fonts carefully — a display font for headlines, a clean sans for body; never two decorative fonts. Practice: build a 5-colour palette for a campus event and justify each choice.', est: 30, resource: 'https://fonts.google.com/', resourceLabel: 'Google Fonts' },
        { title: 'Tools of the trade', summary: 'Canva, Figma and Photopea workflows.', content: 'Canva templates teach layout fast; Figma gives precise control; Photopea is a free Photoshop alternative in the browser. Learn layers, masks and export settings (PNG for graphics, SVG for logos, PDF for print). Practice: recreate a movie poster layout using only free assets.', est: 35, resource: 'https://www.photopea.com/', resourceLabel: 'Photopea' },
        { title: 'Mini project: event flyer set', summary: 'Design a complete flyer + status-size variant.', content: 'Design a flyer for a fictional campus event: strong hierarchy (event name → date/venue → CTA), consistent palette, readable type at phone size. Then adapt it to a 9:16 story format. Deliver both — real clients always need multiple sizes.', est: 60, resource: '', resourceLabel: '' }
    ]},
    { slug: 'digital-marketing', title: 'Digital Marketing', icon: 'fa-bullhorn', tone: 'red', description: 'Grow audiences: content, social, analytics and funnels.', lessons: [
        { title: 'Marketing fundamentals', summary: 'Audience, value proposition and channels.', content: 'Marketing starts with a clear answer to: who is this for, what problem does it solve, and why you over alternatives? Define one target audience narrowly (e.g. "200L engineering students preparing for finals"), craft the message for them, then pick channels they actually use. Practice: write a one-sentence value proposition for a product you love.', est: 25, resource: '', resourceLabel: '' },
        { title: 'Content & social media', summary: 'Posts that earn attention and action.', content: 'Content marketing earns attention by being useful or entertaining before asking for anything. Hooks in the first line, one idea per post, a clear call to action. Consistency beats virality: 3 good posts weekly for 3 months outperforms one lucky hit. Practice: draft a 7-post series teaching one study skill.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Analytics & iteration', summary: 'Measure what matters, then improve.', content: 'Track reach (who saw), engagement (who cared: likes, saves, replies) and conversion (who acted: signups, sales). One metric per campaign — the number that decides success. Review weekly, keep what works, cut what does not. Practice: audit a public account\u2019s last 10 posts and identify its best-performing pattern.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Mini project: 2-week campaign', summary: 'Plan, run and measure a real campaign.', content: 'Pick a goal (grow a WhatsApp group, sell a service, promote an event). Define audience, message, channel and one success metric. Post on schedule for two weeks, log numbers every 3 days, and write a short report: what worked, what flopped, what you would change. This is interview-ready experience.', est: 90, resource: '', resourceLabel: '' }
    ]},
    { slug: 'entrepreneurship', title: 'Entrepreneurship', icon: 'fa-lightbulb', tone: 'amber', description: 'From idea to income: validation, money and small business basics.', lessons: [
        { title: 'Finding real problems', summary: 'Ideas are cheap; validated problems are gold.', content: 'Great businesses solve painful, frequent problems people already pay to fix. Interview 10 potential customers about their workflow before building anything. If they say "that would be nice", keep looking; if they show you their workaround spreadsheet, you have found gold. Practice: list 5 daily frustrations on campus and interview 3 people about one.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Validating cheaply', summary: 'Test demand before building the full thing.', content: 'Run the smallest possible test: a landing page with a signup button, a WhatsApp pre-order list, a manual service you deliver by hand. The goal is evidence of demand — real money or real commitments — not compliments. Practice: design a one-week validation test for your best idea with a clear success threshold.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Money basics for founders', summary: 'Pricing, costs, margins and break-even.', content: 'Know your unit economics: what one sale costs you (COGS) versus what you charge. Gross margin = (price − cost) / price. Break-even units = fixed costs / margin per unit. Price on value, not just cost — and always keep records from day one. Practice: price a product you could sell on campus and compute your break-even.', est: 35, resource: '', resourceLabel: '' },
        { title: 'Mini project: one-page business plan', summary: 'A plan that fits one page and drives action.', content: 'Write: problem, customer, solution, channel, revenue model, costs, first milestone and first experiment. Show it to two experienced people and refine. A plan you can update weekly beats a 40-page document nobody reads.', est: 60, resource: '', resourceLabel: '' }
    ]},
    { slug: 'public-speaking', title: 'Public Speaking', icon: 'fa-microphone', tone: 'teal', description: 'Speak with confidence: structure, delivery and handling nerves.', lessons: [
        { title: 'Structuring a talk', summary: 'Open strong, one core message, close with action.', content: 'Every effective talk has: a hook (question, story, startling fact), a clear single message, 2–3 supporting points with examples, and a close that tells the audience what to do. Write the close first — if you do not know where you are going, no structure will save you. Practice: outline a 3-minute talk on any topic you know well.', est: 25, resource: '', resourceLabel: '' },
        { title: 'Delivery: voice & body', summary: 'Pace, pauses, posture and eye contact.', content: 'Nervous speakers rush. Slow down 20%, use deliberate pauses after key points, and land eye contact with individuals for full sentences. Gesture from the elbow, keep feet planted. Record yourself once — the gap between how you feel and how you look is smaller than you fear. Practice: record a 60-second intro and watch it back.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Handling nerves & Q&A', summary: 'Reframe anxiety; buy thinking time gracefully.', content: 'Nerves are energy — channel them into emphasis. Prepare the first 30 seconds word-for-word. For tough questions: pause, restate the question ("So the question is..."), answer in one sentence, then expand. "I do not know, but I will find out" is a strong answer. Practice: have a friend ask 3 hard questions about your talk.', est: 25, resource: '', resourceLabel: '' },
        { title: 'Mini project: 5-minute recorded talk', summary: 'Deliver, review, refine, redeliver.', content: 'Prepare and record a 5-minute talk on something you care about. Watch it once noting only what to improve, adjust, and record again. Compare takes — the second will surprise you. Share the final version for feedback.', est: 60, resource: '', resourceLabel: '' }
    ]},
    { slug: 'research-writing', title: 'Research & Writing', icon: 'fa-pen-fancy', tone: 'indigo', description: 'Academic writing, sources, citations and clear arguments.', lessons: [
        { title: 'The research process', summary: 'Question → sources → evidence → synthesis.', content: 'Start with a narrow, answerable question. Gather sources from Google Scholar and your library databases, prioritising peer-reviewed work. Read abstracts first, take notes in your own words (prevents plagiarism), and track every source as you go — retroactive citation hunting wastes days. Practice: turn a broad topic ("AI in education") into a researchable question.', est: 30, resource: 'https://scholar.google.com/', resourceLabel: 'Google Scholar' },
        { title: 'Argument structure', summary: 'Claim, evidence, reasoning — repeat.', content: 'Strong academic paragraphs follow PEEL: Point, Evidence, Explanation, Link. Your claim is only as good as its evidence, and your explanation is where you add value — do not let quotations speak for themselves. Practice: rewrite a weak paragraph ("Many students fail exams") with a claim, a statistic and reasoning.', est: 30, resource: '', resourceLabel: '' },
        { title: 'Citations & academic integrity', summary: 'APA style and why plagiarism ends careers.', content: 'Cite every idea that is not yours, including paraphrases. APA format: (Author, Year) in text; full reference list alphabetically at the end. Use reference managers — Zotero is free. Plagiarism can void your degree; when unsure, over-cite. Practice: convert three facts you learned this week into proper APA citations.', est: 30, resource: 'https://www.zotero.org/', resourceLabel: 'Zotero' },
        { title: 'Mini project: 1000-word mini paper', summary: 'A complete short paper with real sources.', content: 'Write a 1000-word paper answering your research question: intro with thesis, 3 PEEL body sections, conclusion with limitations. Include at least 5 credible sources in APA. Edit twice: once for structure, once for sentence-level clarity.', est: 90, resource: '', resourceLabel: '' }
    ]},
    { slug: 'video-editing', title: 'Video Editing', icon: 'fa-film', tone: 'rose', description: 'Cut, pace and polish videos people finish watching.', lessons: [
        { title: 'Editing fundamentals', summary: 'Cuts, pacing and the story spine.', content: 'Editing is storytelling: every cut should have a reason (new idea, new angle, emphasis). Learn J-cuts and L-cuts (audio leads or trails video) for smooth flow. Pace to attention — cut anything that does not advance the story; when in doubt, cut it. Practice: edit a 60-second vlog from raw phone clips.', est: 35, resource: '', resourceLabel: '' },
        { title: 'Tools: CapCut to Premiere', summary: 'Pick the right tool for each stage.', content: 'CapCut (free, phone) handles social content end-to-end; DaVinci Resolve (free, desktop) is professional-grade colour and editing; Premiere Pro is the industry standard. Learn one deeply before adding another — skills transfer. Practice: build the same 30-second edit in two tools and note the differences.', est: 30, resource: 'https://www.blackmagicdesign.com/products/davinciresolve', resourceLabel: 'DaVinci Resolve (free)' },
        { title: 'Sound & colour', summary: 'Audio is half the video; colour is the mood.', content: 'Viewers forgive mediocre visuals, never bad audio: normalise levels, cut hums, add music at -20dB under dialogue. Colour grade for consistency first (white balance), mood second (teal-orange is a cliché for a reason). Practice: fix the audio on a noisy clip, then apply one consistent LUT across three clips.', est: 40, resource: '', resourceLabel: '' },
        { title: 'Mini project: 90-second story', summary: 'A complete short with music, grade and titles.', content: 'Produce a 90-second piece: plan shots, film on your phone (stabilise, light the subject), edit with intentional cuts, mix audio, grade, add minimal titles. Export at the right specs for your target platform. This is your showreel opener.', est: 90, resource: '', resourceLabel: '' }
    ]}
];

(async function seedSkillPaths() {
    try {
        await migrationsReady; // skill tables must exist first
        for (let i = 0; i < SKILL_SEED.length; i++) {
            const p = SKILL_SEED[i];
            const r = await pool.query(
                `INSERT INTO skill_paths (slug, title, description, icon, tone, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, icon = EXCLUDED.icon, tone = EXCLUDED.tone, sort_order = EXCLUDED.sort_order
                 RETURNING id`,
                [p.slug, p.title, p.description, p.icon, p.tone, i]
            );
            const pathId = r.rows[0].id;
            for (let j = 0; j < p.lessons.length; j++) {
                const l = p.lessons[j];
                await pool.query(
                    `INSERT INTO skill_lessons (path_id, title, summary, content, resource_url, resource_label, est_minutes, sort_order)
                     SELECT $1::int, $2::varchar, $3::text, $4::text, $5::text, $6::varchar, $7::int, $8::int
                     WHERE NOT EXISTS (SELECT 1 FROM skill_lessons WHERE path_id = $1 AND title = $2)`,
                    [pathId, l.title, l.summary, l.content, l.resource || '', l.resourceLabel || '', l.est || 20, j]
                );
            }
        }
        console.log('[Skills] Paths seeded');
    } catch (e) { console.error('[Skills] Seed:', e.message); }
})();

app.get('/skills', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const [pathsRes, xpRes] = await Promise.all([
        pool.query(`
            SELECT p.*,
                (SELECT COUNT(*) FROM skill_lessons l WHERE l.path_id = p.id) AS lesson_count,
                (SELECT COUNT(*) FROM skill_progress sp JOIN skill_lessons l2 ON sp.lesson_id = l2.id WHERE l2.path_id = p.id AND sp.user_id = $1) AS done_count,
                (SELECT COUNT(*) FROM skill_projects pr WHERE pr.path_id = p.id AND pr.user_id = $1) AS project_count,
                (SELECT COUNT(*) FROM skill_enrollments e WHERE e.path_id = p.id AND e.user_id = $1) > 0 AS enrolled
            FROM skill_paths p ORDER BY p.sort_order ASC`, [uid]),
        pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM xp_ledger WHERE user_id = $1 AND (source_type LIKE 'skill%')`, [uid])
    ]);
    const paths = pathsRes.rows;
    const summary = {
        paths: paths.length,
        enrolled: paths.filter(p => p.enrolled).length,
        lessonsDone: paths.reduce((n, p) => n + (parseInt(p.done_count, 10) || 0), 0),
        lessonsTotal: paths.reduce((n, p) => n + (parseInt(p.lesson_count, 10) || 0), 0),
        projects: paths.reduce((n, p) => n + (parseInt(p.project_count, 10) || 0), 0),
        xp: parseInt(xpRes.rows[0].total, 10) || 0
    };
    res.locals.seo.title = 'Prepium | Skills Centre';
    res.render('skills', { user: req.session.user, paths, summary, activeNav: 'skills' });
}));

app.get('/skills/:slug', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const pathRes = await pool.query('SELECT * FROM skill_paths WHERE slug = $1', [req.params.slug]);
    if (!pathRes.rows[0]) return res.status(404).render('public-form-notfound', { user: req.session.user });
    const skillPath = pathRes.rows[0];
    await pool.query('INSERT INTO skill_enrollments (user_id, path_id) VALUES ($1, $2) ON CONFLICT (user_id, path_id) DO NOTHING', [uid, skillPath.id]);
    const [lessonsRes, doneRes, projectsRes] = await Promise.all([
        pool.query('SELECT * FROM skill_lessons WHERE path_id = $1 ORDER BY sort_order ASC', [skillPath.id]),
        pool.query('SELECT lesson_id FROM skill_progress WHERE user_id = $1', [uid]),
        pool.query('SELECT * FROM skill_projects WHERE user_id = $1 AND path_id = $2 ORDER BY created_at DESC', [uid, skillPath.id])
    ]);
    const doneIds = new Set(doneRes.rows.map(r => r.lesson_id));
    const lessons = lessonsRes.rows.map(l => ({ ...l, done: doneIds.has(l.id) }));
    res.locals.seo.title = 'Prepium | ' + skillPath.title;
    res.render('skill-path', {
        user: req.session.user,
        skillPath,
        lessons,
        projects: projectsRes.rows,
        activeNav: 'skills'
    });
}));

app.post('/api/skills/:slug/lessons/:lessonId/complete', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const lesson = await pool.query(
        'SELECT l.id, l.title, p.slug FROM skill_lessons l JOIN skill_paths p ON l.path_id = p.id WHERE l.id = $1 AND p.slug = $2',
        [parseInt(req.params.lessonId, 10), req.params.slug]
    );
    if (!lesson.rows[0]) return res.status(404).json({ success: false, error: 'Lesson not found.' });
    const ins = await pool.query(
        'INSERT INTO skill_progress (user_id, lesson_id) VALUES ($1, $2) ON CONFLICT (user_id, lesson_id) DO NOTHING RETURNING id',
        [uid, lesson.rows[0].id]
    );
    let xpResult = { awarded: false };
    if (ins.rows[0]) {
        xpResult = await xpLib.awardXP(pool, uid, 15, 'skill_lesson', 'lesson_' + lesson.rows[0].id, 'Completed lesson: ' + lesson.rows[0].title);
    }
    res.json({ success: true, xp_awarded: xpResult.awarded ? 15 : 0, xp_balance: xpResult.balance });
}));

app.post('/api/skills/:slug/projects', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
    const notes = String((req.body && req.body.notes) || '').slice(0, 2000);
    if (!title) return res.status(400).json({ success: false, error: 'Project title is required.' });
    const p = await pool.query('SELECT id FROM skill_paths WHERE slug = $1', [req.params.slug]);
    if (!p.rows[0]) return res.status(404).json({ success: false, error: 'Path not found.' });
    // Submitting a project marks it done; lesson completion alone never
    // implies mastery — the project is the practical evidence.
    const r = await pool.query(
        "INSERT INTO skill_projects (user_id, path_id, title, notes, status, submitted_at) VALUES ($1, $2, $3, $4, 'submitted', NOW()) RETURNING *",
        [uid, p.rows[0].id, title, notes]
    );
    const xpResult = await xpLib.awardXP(pool, uid, 100, 'skill_project', 'project_' + r.rows[0].id, 'Submitted project: ' + title);
    res.json({ success: true, project: r.rows[0], xp_awarded: xpResult.awarded ? 100 : 0, xp_balance: xpResult.balance });
}));

// ======================== PREPIUM CHALLENGES ========================
// Extends the existing Daily Challenge + Games systems — not a separate
// platform. Progress is computed from verified activity in existing tables,
// and XP rewards flow through the shared ledger (no duplicates possible).
// Each query returns a single aliased column `progress`. The alias must live
// inside the query (before FROM/WHERE) — appending it at the call site would
// produce `... WHERE ... AS progress`, a syntax error, which previously broke
// the whole Challenges page for every metric except `quizzes`.
function challengeProgressSql(metric) {
    if (metric === 'study_minutes') return `SELECT (COALESCE(SUM(elapsed_seconds), 0) / 60)::int AS progress FROM study_sessions WHERE user_id = $1 AND status = 'completed' AND created_at >= $2`;
    if (metric === 'xp') return `SELECT COALESCE(SUM(amount), 0)::int AS progress FROM xp_ledger WHERE user_id = $1 AND created_at >= $2`;
    if (metric === 'challenge_score') return `SELECT COALESCE(SUM(score), 0)::int AS progress FROM daily_challenge_attempts WHERE user_id = $1 AND completed = true AND created_at >= $2`;
    return `SELECT (
        SELECT COUNT(*) FROM results WHERE user_id = $1 AND taken_at >= $2
      ) + (
        SELECT COUNT(*) FROM quiz_results WHERE user_id = $1 AND created_at >= $2
      ) + (
        SELECT COUNT(*) FROM daily_challenge_attempts WHERE user_id = $1 AND completed = true AND created_at >= $2
      ) + (
        SELECT COUNT(*) FROM game_results WHERE user_id = $1 AND created_at >= $2
      ) AS progress`;
}

// Rolling window per cadence — weekly/7day/30day/seasonal challenges reset
// automatically (same NOW()-relative approach as Insights and Wrapped), so a
// fixed boot-time starts_at can never freeze a challenge's window.
function cadenceSince(d) {
    const now = new Date();
    if (d.cadence === 'weekly') {
        const dt = new Date(now);
        dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
        dt.setUTCHours(0, 0, 0, 0);
        return dt;
    }
    if (d.cadence === '7day') return new Date(now.getTime() - 7 * 86400000);
    if (d.cadence === '30day') return new Date(now.getTime() - 30 * 86400000);
    if (d.cadence === 'seasonal') {
        const dt = new Date(now);
        dt.setUTCMonth(Math.floor(dt.getUTCMonth() / 3) * 3, 1);
        dt.setUTCHours(0, 0, 0, 0);
        return dt;
    }
    return d.starts_at || new Date(0);
}

async function getActiveChallenges(uid) {
    const defs = await pool.query('SELECT * FROM challenge_defs WHERE is_active = true ORDER BY id ASC');
    const out = [];
    for (const d of defs.rows) {
        const since = cadenceSince(d);
        const progressRes = await pool.query(challengeProgressSql(d.metric), [uid, since]);
        const progress = parseInt(progressRes.rows[0].progress, 10) || 0;
        const part = await pool.query('SELECT * FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2', [d.id, uid]);
        const joined = !!part.rows[0];
        const target = parseInt(d.target, 10) || 1;
        const alreadyCompleted = joined && part.rows[0].completed_at;
        const done = !!(joined && (alreadyCompleted || progress >= target));
        // Completed challenges stay pinned at 100% even after their window
        // rolls over (progress is computed from the current window).
        const shownProgress = done ? target : Math.min(progress, target);
        // Auto-complete + award XP exactly once (ledger unique index guards it)
        if (joined && !alreadyCompleted && progress >= target) {
            await pool.query('UPDATE challenge_participants SET progress = $1, completed_at = NOW() WHERE challenge_id = $2 AND user_id = $3', [progress, d.id, uid]);
            await xpLib.awardXP(pool, uid, parseInt(d.xp_reward, 10) || 100, 'challenge', 'challenge_' + d.id + '_user_' + uid, 'Completed challenge: ' + d.title);
            // Holiday Mode: a completed challenge counts toward 'challenges'
            // holiday goals (no-op unless Holiday Mode is active).
            await progressHolidayGoalsByType(uid, 'challenges', 1);
        } else if (joined) {
            await pool.query('UPDATE challenge_participants SET progress = $1 WHERE challenge_id = $2 AND user_id = $3 AND completed_at IS NULL', [shownProgress, d.id, uid]);
        }
        // Leaderboard within scope: rank the student against relevant peers
        // (friends / squad-mates / same department / same university).
        let leaders = [{ name: 'You', progress: shownProgress, is_me: true }];
        if (d.scope !== 'individual') {
            try {
                let peerIds = [];
                if (d.scope === 'friends') {
                    const r = await pool.query(
                        `SELECT CASE WHEN user_id = $1 THEN friend_id ELSE user_id END AS id
                         FROM friendships WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted'`, [uid]);
                    peerIds = r.rows.map(x => x.id);
                } else if (d.scope === 'squad') {
                    const r = await pool.query(
                        `SELECT DISTINCT sm2.user_id AS id
                         FROM squad_members sm1
                         JOIN squad_members sm2 ON sm1.squad_id = sm2.squad_id
                         WHERE sm1.user_id = $1 AND sm2.user_id <> $1`, [uid]);
                    peerIds = r.rows.map(x => x.id);
                } else if (d.scope === 'department') {
                    // Department is tracked on cgpa_profiles, not users.
                    const r = await pool.query(
                        `SELECT p2.user_id AS id FROM cgpa_profiles p1
                         JOIN cgpa_profiles p2 ON p2.department = p1.department
                         WHERE p1.user_id = $1 AND p2.user_id <> $1 LIMIT 50`, [uid]);
                    peerIds = r.rows.map(x => x.id);
                } else { // faculty — grouped by university (closest tracked scope)
                    const r = await pool.query(
                        'SELECT id FROM users WHERE university_id = (SELECT university_id FROM users WHERE id = $1) AND id <> $1 LIMIT 50', [uid]);
                    peerIds = r.rows.map(x => x.id);
                }
                peerIds = peerIds.slice(0, 50);
                const peerRows = [];
                for (const pid of peerIds) {
                    const pr = await pool.query(challengeProgressSql(d.metric), [pid, since]);
                    const pv = Math.min(parseInt(pr.rows[0].progress, 10) || 0, target);
                    if (pv > 0) peerRows.push({ progress: pv, id: pid });
                }
                peerRows.sort((a, b) => b.progress - a.progress);
                const topPeers = peerRows.slice(0, 4);
                if (topPeers.length) {
                    const names = await pool.query('SELECT id, fullname FROM users WHERE id = ANY($1)', [topPeers.map(p => p.id)]);
                    const nameMap = {};
                    names.rows.forEach(n => { nameMap[n.id] = n.fullname.split(' ')[0]; });
                    leaders = topPeers.map(p => ({ name: nameMap[p.id] || 'Student', progress: p.progress, is_me: false }))
                        .concat([{ name: 'You', progress: shownProgress, is_me: true }])
                        .sort((a, b) => b.progress - a.progress);
                }
            } catch (e) { console.error('[Challenges] leaderboard:', e.message); }
        }
        out.push({
            ...d,
            joined,
            progress: shownProgress,
            completed: done,
            pct: done ? 100 : Math.min(100, Math.round((progress / target) * 100)),
            leaders
        });
    }
    return out;
}

app.get('/challenges', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const challenges = await getActiveChallenges(uid);
    const [todayRes, xpRes, holidayRes] = await Promise.all([
        pool.query('SELECT id FROM daily_challenge_attempts WHERE user_id = $1 AND date = CURRENT_DATE AND completed = true', [uid]),
        pool.query('SELECT COALESCE(xp, 0) AS xp FROM users WHERE id = $1', [uid]),
        pool.query('SELECT is_active FROM holiday_mode WHERE user_id = $1', [uid])
    ]);
    res.locals.seo.title = 'Prepium | Challenges';
    res.render('challenges', {
        user: req.session.user,
        challenges,
        dailyDone: todayRes.rows.length > 0,
        xp: parseInt(xpRes.rows[0].xp, 10) || 0,
        holidayActive: !!(holidayRes.rows[0] && holidayRes.rows[0].is_active),
        activeNav: 'challenges'
    });
}));

app.post('/api/challenges/:id/join', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const d = await pool.query('SELECT * FROM challenge_defs WHERE id = $1 AND is_active = true', [parseInt(req.params.id, 10)]);
    if (!d.rows[0]) return res.status(404).json({ success: false, error: 'Challenge not found.' });
    await pool.query('INSERT INTO challenge_participants (challenge_id, user_id) VALUES ($1, $2) ON CONFLICT (challenge_id, user_id) DO NOTHING', [d.rows[0].id, uid]);
    res.json({ success: true });
}));

(async function seedChallenges() {
    try {
        await migrationsReady; // challenge tables must exist first
        const seeds = [
            { slug: 'weekly-quiz-5', title: 'Weekly Warm-up', description: 'Complete 5 quizzes or challenges this week.', cadence: 'weekly', scope: 'individual', metric: 'quizzes', target: 5, xp_reward: 150 },
            { slug: 'weekly-study-120', title: 'Deep Work Week', description: 'Log 120 minutes of focused study this week.', cadence: 'weekly', scope: 'individual', metric: 'study_minutes', target: 120, xp_reward: 150 },
            { slug: '30day-xp-1000', title: '30-Day Momentum', description: 'Earn 1000 XP in 30 days across all activities.', cadence: '30day', scope: 'individual', metric: 'xp', target: 1000, xp_reward: 500 },
            { slug: '7day-challenge-score', title: 'Challenge Streak', description: 'Score 30 total points in Daily Challenges within 7 days.', cadence: '7day', scope: 'friends', metric: 'challenge_score', target: 30, xp_reward: 200 },
            { slug: 'seasonal-faculty-50', title: 'Faculty Showdown', description: 'Be among the top in your faculty: 50 quizzes this season.', cadence: 'seasonal', scope: 'faculty', metric: 'quizzes', target: 50, xp_reward: 800 }
        ];
        for (const s of seeds) {
            await pool.query(
                `INSERT INTO challenge_defs (slug, title, description, cadence, scope, metric, target, xp_reward, starts_at, ends_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, DATE_TRUNC('week', NOW()), DATE_TRUNC('week', NOW()) + INTERVAL '7 days')
                 ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, is_active = true`,
                [s.slug, s.title, s.description, s.cadence, s.scope, s.metric, s.target, s.xp_reward]
            );
        }
        console.log('[Challenges] Seeded');
    } catch (e) { console.error('[Challenges] Seed:', e.message); }
})();

// Daily Challenge completion now awards XP through the shared ledger.
// (Hooked into the existing submit route below via awardDailyChallengeXP.)
async function awardDailyChallengeXP(uid, attemptId, score, total) {
    if (!total || total <= 0) return;
    const pct = score / total;
    const amount = pct >= 0.8 ? 60 : pct >= 0.5 ? 40 : 20;
    return xpLib.awardXP(pool, uid, amount, 'daily_challenge', 'attempt_' + attemptId, 'Daily Challenge: ' + score + '/' + total);
}

// ======================== OPPORTUNITIES CENTRE ========================
const OPP_CATEGORIES = ['scholarship', 'bursary', 'internship', 'fellowship', 'competition', 'hackathon', 'graduate', 'volunteering', 'leadership'];
const OPP_STATUSES = ['saved', 'applied', 'submitted', 'rejected', 'accepted'];

app.get('/opportunities', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const category = OPP_CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const [opsRes, savesRes] = await Promise.all([
        pool.query(
            category
                ? 'SELECT * FROM opportunities WHERE is_active = true AND category = $1 ORDER BY (closing_date IS NULL), closing_date ASC, created_at DESC'
                : 'SELECT * FROM opportunities WHERE is_active = true ORDER BY (closing_date IS NULL), closing_date ASC, created_at DESC',
            category ? [category] : []
        ),
        pool.query('SELECT opportunity_id, status, reminder_at, note FROM opportunity_saves WHERE user_id = $1', [uid])
    ]);
    const saveMap = {};
    savesRes.rows.forEach(s => { saveMap[s.opportunity_id] = s; });
    const today = new Date().toISOString().slice(0, 10);
    const ops = opsRes.rows.map(o => ({
        ...o,
        save: saveMap[o.id] || null,
        // Expired or unverified opportunities are never presented as confirmed
        expired: o.closing_date && o.closing_date < today
    }));
    res.locals.seo.title = 'Prepium | Opportunities';
    res.render('opportunities', {
        user: req.session.user,
        ops,
        categories: OPP_CATEGORIES,
        activeCategory: category,
        activeNav: 'opportunities'
    });
}));

app.post('/api/opportunities/:id/save', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    const status = OPP_STATUSES.includes(req.body && req.body.status) ? req.body.status : 'saved';
    const reminderAt = (req.body && req.body.reminder_at) ? new Date(req.body.reminder_at) : null;
    const r = await pool.query(`
        INSERT INTO opportunity_saves (user_id, opportunity_id, status, reminder_at, note)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, opportunity_id) DO UPDATE SET
            status = EXCLUDED.status, reminder_at = EXCLUDED.reminder_at, note = EXCLUDED.note, updated_at = NOW()
        RETURNING *`,
        [uid, id, status, reminderAt && !isNaN(reminderAt) ? reminderAt : null, String((req.body && req.body.note) || '').slice(0, 1000)]);
    res.json({ success: true, save: r.rows[0] });
}));

app.post('/api/opportunities/:id/unsave', isAuth, asyncRoute(async (req, res) => {
    const uid = req.session.user.id;
    await pool.query('DELETE FROM opportunity_saves WHERE user_id = $1 AND opportunity_id = $2', [uid, parseInt(req.params.id, 10)]);
    res.json({ success: true });
}));

(async function seedOpportunities() {
    try {
        await migrationsReady; // opportunity tables must exist first
        const existing = await pool.query('SELECT COUNT(*) AS c FROM opportunities');
        if (parseInt(existing.rows[0].c, 10) > 0) return;
        const year = new Date().getFullYear();
        const seeds = [
            { title: 'NNPC/SNEPCo National University Scholarship', category: 'scholarship', organisation: 'NNPC & SNEPCo', description: 'Annual scholarship for full-time Nigerian university undergraduates in relevant disciplines. Covers tuition and stipend.', eligibility: 'Full-time 200L undergraduates with strong grades; specific courses apply.', verification_status: 'unverified' },
            { title: 'MTN Foundation Scholarship Scheme', category: 'scholarship', organisation: 'MTN Foundation', description: 'Scholarship for high-performing students in public universities and polytechnics.', eligibility: '300L students with CGPA 3.5+/5.0 or equivalent; must not hold another scholarship.', verification_status: 'unverified' },
            { title: 'Federal Government BEA Scholarship', category: 'scholarship', organisation: 'Federal Ministry of Education', description: 'Bilateral Education Agreement awards for undergraduate study abroad.', eligibility: 'At least 5 distinctions in WAEC/NECO including Mathematics and English.', verification_status: 'unverified' },
            { title: 'Google Developer Student Clubs Lead', category: 'leadership', organisation: 'Google', description: 'Lead a campus community of peer developers, run workshops and build projects with Google support.', eligibility: 'Enrolled university student; leadership experience helps.', verification_status: 'unverified' },
            { title: 'She Code Africa Mentorship Program', category: 'fellowship', organisation: 'She Code Africa', description: 'Structured mentorship in tech for African women across coding, design and data tracks.', eligibility: 'Women in African universities; all levels.', verification_status: 'unverified' },
            { title: 'Hult Prize On-Campus Program', category: 'competition', organisation: 'Hult Prize Foundation', description: 'World\u2019s largest student startup competition with $1M grand prize and campus rounds.', eligibility: 'Teams of university students.', verification_status: 'unverified' },
            { title: 'Industrial Training Fund (ITF) SIWES Placement', category: 'internship', organisation: 'ITF', description: 'Mandatory industrial training placement for science, engineering and allied students.', eligibility: 'Students enrolled in courses requiring SIWES.', verification_status: 'unverified' }
        ];
        for (const s of seeds) {
            await pool.query(
                'INSERT INTO opportunities (title, category, organisation, description, eligibility, source_url, closing_date, verification_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [s.title, s.category, s.organisation, s.description, s.eligibility, s.source_url || '', null, s.verification_status]
            );
        }
        console.log('[Opportunities] Seeded');
    } catch (e) { console.error('[Opportunities] Seed:', e.message); }
})();

app.get('/status', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | Community';
    res.render('chat', { user: req.session.user, initialTab: 'status' });
});

app.get('/chat', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | Community';
    res.render('chat', { user: req.session.user, initialTab: 'chats' });
});

app.get('/chat/:id', isAuth, (req, res) => {
    res.locals.seo.title = 'Prepium | Chat';
    res.render('chat-thread', { user: req.session.user, convId: parseInt(req.params.id, 10) || 0 });
});


// Resolve the Socket.IO browser client without relying on package "exports"
// (socket.io no longer exposes ./client-dist/* via require.resolve).
function resolveSocketIoClient() {
    const candidates = [];
    try {
        candidates.push(path.join(path.dirname(require.resolve('socket.io/package.json')), 'client-dist', 'socket.io.min.js'));
    } catch (e) {}
    try {
        candidates.push(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'));
    } catch (e) {}
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
    return null;
}
const SOCKET_IO_CLIENT_PATH = resolveSocketIoClient();

// Serve the Socket.IO client explicitly so it also works on serverless
// deployments where the exported Express app is not attached to an HTTP server.
app.get('/socket.io/socket.io.js', (req, res, next) => {
    if (!SOCKET_IO_CLIENT_PATH) { console.error('[Socket.IO] client bundle not found'); return next(); }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(SOCKET_IO_CLIENT_PATH);
});

// Mount the Socket.IO engine on Express as well. On serverless hosts (Vercel)
// the exported app is not served by our own httpServer, so the polling
// handshake would otherwise 404 and the client could never connect.
app.use((req, res, next) => {
    if (req.url && req.url.indexOf('/socket.io/') === 0 && io) {
        try { return io.engine.handleRequest(req, res); } catch (e) { return next(e); }
    }
    next();
});

// 404 handler (must be registered after all routes)
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.status(404).type('text/plain').send('Not found');
});

// ======================== CENTRAL ERROR HANDLER ========================
// Single, intentional global error-handling flow. This MUST be the last
// middleware registered: every route/middleware above it (early or late)
// forwards errors here via next(err), including:
//   - multer upload errors (file size / count limits, bad multipart)
//   - body-parser "entity.too.large" (payload limit)
//   - async route errors (async handlers are wrapped by asyncRoute below)
//   - unexpected exceptions thrown synchronously in handlers
// API routes receive consistent JSON; page routes receive a safe HTML/text
// response. Diagnostics are logged server-side only — no stack traces or
// internals are exposed to students.
app.use((err, req, res, next) => {
    // Log full diagnostics server-side (message + stack), never to the client.
    console.error('[Error]', req.method, req.originalUrl, '-', err && err.stack ? err.stack : err);

    if (res.headersSent) return next(err);

    // Multer upload errors -> 413/400 with a safe message
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'File too large. Maximum size is 25MB.' });
        }
        return res.status(400).json({ success: false, message: 'Upload error: ' + err.message });
    }

    // Body-parser payload limit -> 413 with a safe message
    if (err && (err.type === 'entity.too.large' || err.statusCode === 413)) {
        return res.status(413).json({ success: false, message: 'File too large. Maximum size is 25MB.' });
    }

    // Errors that already carry an intended HTTP status (e.g. session store)
    const status = (err && err.status >= 400 && err.status <= 599) ? err.status : 500;

    if (req.path.startsWith('/api/')) {
        return res.status(status).json({ success: false, error: 'Something went wrong. Please try again later.' });
    }
    res.status(status).send('Something went wrong. Please try again later.');
});

const httpServer = http.createServer(app);
try {
    const { Server } = require('socket.io');
    const cookieSignature = require('cookie-signature');
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    io.use((socket, next) => {
        try {
            const raw = socket.handshake.headers.cookie || '';
            let sid = null;
            raw.split(';').forEach(part => {
                const eq = part.indexOf('=');
                if (eq !== -1 && part.slice(0, eq).trim() === 'connect.sid') {
                    sid = decodeURIComponent(part.slice(eq + 1).trim());
                }
            });
            if (!sid) return next(new Error('no session'));
            if (sid.startsWith('s:')) sid = sid.slice(2);
            const unsigned = cookieSignature.unsign(sid, SESSION_SECRET);
            if (!unsigned) return next(new Error('bad signature'));
            sessionStore.get(unsigned, (err, sess) => {
                if (err || !sess || !sess.user) return next(new Error('unauthorized'));
                socket.userId = sess.user.id;
                next();
            });
        } catch (e) { next(new Error('unauthorized')); }
    });

    // ---- Call state tracking (accurate busy/ended states + history) ----
    // Maps userId -> peerId while a call is being set up or is active.
    const activeCalls = new Map();
    const callStarts = new Map(); // userId -> timestamp when call connected
    function clearActiveCall(a, b) {
        const startedAt = callStarts.get(a) || callStarts.get(b);
        callStarts.delete(a); callStarts.delete(b);
        if (activeCalls.get(a) === b) activeCalls.delete(a);
        if (activeCalls.get(b) === a) activeCalls.delete(b);
        const dur = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
        return dur;
    }
    async function recordCall(callerId, calleeId, callType, status, startedAt, durationSeconds) {
        await pool.query(
            'INSERT INTO call_history (caller_id, callee_id, call_type, status, started_at, ended_at, duration_seconds) VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = \'ended\' THEN NOW() ELSE NULL END, $6)',
            [callerId, calleeId, callType === 'video' ? 'video' : 'audio', status, startedAt, parseInt(durationSeconds, 10) || 0]
        );
    }
    async function notifyMissedCall(callerId, calleeId, callType) {
        const u = await pool.query('SELECT fullname FROM users WHERE id = $1', [callerId]);
        const name = u.rows[0] ? u.rows[0].fullname : 'Someone';
        await pool.query(
            'INSERT INTO user_notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)',
            [calleeId, 'call', 'Missed call', name + ' tried to call you (' + (callType === 'video' ? 'video' : 'audio') + ') but you were offline.', '/chat']
        );
    }

    io.on('connection', (socket) => {
        const uid = socket.userId;
        socket.join('user_' + uid);
        pool.query('UPDATE conversation_members SET last_active_at = NOW() WHERE user_id = $1', [uid]).catch(() => {});
        socket.on('chat:typing', (data) => {
            const cid = parseInt(data && data.conversationId, 10);
            if (!cid) return;
            const now = Date.now();
            if (socket.lastTyping && now - socket.lastTyping < 2000) return;
            socket.lastTyping = now;
            emitToMembers(cid, 'chat:typing', { conversationId: cid, userId: uid }, uid);
        });
        socket.on('chat:delivered', async (data) => {
            const cid = parseInt(data && data.conversationId, 10);
            if (!cid) return;
            const mid = parseInt(data && data.messageId, 10) || null;
            try {
                await pool.query(
                    'UPDATE conversation_members SET last_active_at = NOW() WHERE conversation_id = $1 AND user_id = $2',
                    [cid, uid]
                );
                emitToMembers(cid, 'chat:delivered', { conversationId: cid, userId: uid, messageId: mid }, uid);
            } catch (e) { console.error('[Chat] delivered:', e.message); }
        });
        socket.on('call:offer', async (data) => {
            try {
                const toUserId = parseInt(data && data.toUserId, 10);
                if (!toUserId || !data.offer) return;
                if (!(await areFriends(uid, toUserId))) return;
                // Accurate call states: never pretend a call is ringing when the
                // recipient is offline or already busy on another call.
                const recipientRoom = io.sockets.adapter.rooms.get('user_' + toUserId);
                const online = !!(recipientRoom && recipientRoom.size > 0);
                if (!online) {
                    socket.emit('call:unavailable', { toUserId: toUserId, reason: 'offline' });
                    await recordCall(uid, toUserId, data.callType, 'missed', null, 0).catch(() => {});
                    await notifyMissedCall(uid, toUserId, data.callType).catch(() => {});
                    return;
                }
                if (activeCalls.has(toUserId)) {
                    socket.emit('call:busy', { toUserId: toUserId });
                    await recordCall(uid, toUserId, data.callType, 'busy', null, 0).catch(() => {});
                    return;
                }
                activeCalls.set(uid, toUserId);
                activeCalls.set(toUserId, uid);
                const u = await pool.query('SELECT fullname FROM users WHERE id = $1', [uid]);
                io.to('user_' + toUserId).emit('call:offer', {
                    fromUserId: uid,
                    fromName: u.rows[0] ? u.rows[0].fullname : 'Someone',
                    callType: data.callType === 'video' ? 'video' : 'audio',
                    offer: { type: data.offer.type, sdp: data.offer.sdp }
                });
            } catch (e) { console.error('[Call] offer:', e.message); }
        });
        socket.on('call:answer', (data) => {
            const toUserId = parseInt(data && data.toUserId, 10);
            if (!toUserId || !data.answer) return;
            // Call actually connected — record the start time for duration tracking.
            callStarts.set(uid, Date.now());
            callStarts.set(toUserId, Date.now());
            io.to('user_' + toUserId).emit('call:answer', { fromUserId: uid, answer: { type: data.answer.type, sdp: data.answer.sdp } });
        });
        socket.on('call:ice', (data) => {
            const toUserId = parseInt(data && data.toUserId, 10);
            if (!toUserId || !data.candidate) return;
            io.to('user_' + toUserId).emit('call:ice', { fromUserId: uid, candidate: data.candidate });
        });
        // Callee explicitly declines — caller sees an accurate "declined" state.
        socket.on('call:decline', (data) => {
            const toUserId = parseInt(data && data.toUserId, 10);
            if (!toUserId) return;
            clearActiveCall(uid, toUserId);
            recordCall(toUserId, uid, data && data.callType, 'declined', null, 0).catch(() => {});
            io.to('user_' + toUserId).emit('call:decline', { fromUserId: uid });
        });
        // Callee reports it is busy (e.g. UI was mid-call when the offer arrived).
        socket.on('call:busy-signal', (data) => {
            const toUserId = parseInt(data && data.toUserId, 10);
            if (!toUserId) return;
            clearActiveCall(toUserId, uid);
            recordCall(toUserId, uid, data && data.callType, 'busy', null, 0).catch(() => {});
            io.to('user_' + toUserId).emit('call:busy', { fromUserId: uid });
        });
        socket.on('call:end', (data) => {
            const toUserId = parseInt(data && data.toUserId, 10);
            if (!toUserId) return;
            const dur = clearActiveCall(uid, toUserId);
            recordCall(uid, toUserId, data && data.callType, 'ended', new Date(), dur).catch(() => {});
            io.to('user_' + toUserId).emit('call:end', { fromUserId: uid });
        });
        socket.on('disconnect', () => {
            // If the socket was mid-call, free the busy state and inform the peer.
            const peerId = activeCalls.get(uid);
            if (peerId) {
                clearActiveCall(uid, peerId);
                io.to('user_' + peerId).emit('call:end', { fromUserId: uid });
            }
        });
    });
    console.log('[Socket.IO] Ready');
} catch (e) {
    console.error('[Socket.IO] Failed to initialize:', e.message);
}

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    httpServer.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
