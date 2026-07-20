const express = require('express');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();
try { require('./key-rotator.cjs'); } catch(_) {}
const app = express();
const multer = require('multer');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const { GoogleGenerativeAI } = require('@google/generative-ai');

const apiKeys = [process.env.GEMINI_API_KEY_PRIMARY, process.env.GEMINI_API_KEY_SECONDARY].filter(Boolean);
const ai = new GoogleGenerativeAI(apiKeys[0] || '');
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
    limits: { fileSize: 50 * 1024 * 1024 }
});

// Memory storage for timetable extraction (need buffer)
const uploadMemory = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
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
  idleTimeoutMillis: 30000
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Add this line directly ABOVE your app.use(session({...})) middleware declaration
app.set('trust proxy', 1);

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
    if (req.session.user && req.session.user.has_paid === true) return next();
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json')) || req.path.startsWith('/api/')) {
        return res.status(402).json({ success: false, message: 'Premium required', premium_required: true });
    }
    return res.redirect('/dashboard?msg=Premium+feature.+Tap+%22Unlock+Premium%22+to+continue');
};

const isAdmin = (req, res, next) => {
    // Check if the session user exists AND the is_admin flag is true
    if (req.session.user && req.session.user.is_admin === true) {
        return next();
    }

    // If they aren't an admin, they stay out
    res.status(403).send("Access Denied: Admins Only");
};

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

        // Ensure the array [fullname, email, ..., university_id, ...] 
        // matches the $1, $2, $3, $4 order
        await pool.query(
            'INSERT INTO users (fullname, email, password, university_id, unique_code, has_paid) VALUES ($1, $2, $3, $4, $5, $6)',
            [
                fullname, 
                email.toLowerCase(), 
                hashedPassword, 
                university_id, // FIXED: removed the 's'
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

// Add this to your app.js / server file
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
        const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        const paystackData = await paystackRes.json();

        if (!paystackData.status || paystackData.data.status !== 'success') {
            return res.redirect('/dashboard?payment=failed&reason=transaction_not_successful');
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
        await pool.query('UPDATE users SET has_paid = true WHERE id = $1', [userId]);
        console.log(`[Paystack] Success: User ID ${userId} marked as paid.`);

        // 4. Update the logged-in session right away
        req.session.user.has_paid = true;

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
                console.log(`[Referral Match] Adding ₦150 to Ambassador: ${ambassador.name}`);

                // Direct mathematical calculation targeting the ambassador ID
                await pool.query(
                    `UPDATE ambassadors 
                     SET total_earned = CAST(COALESCE(total_earned, 0) AS INTEGER) + 150, 
                         total_referrals = CAST(COALESCE(total_referrals, 0) AS INTEGER) + 1 
                     WHERE id = $1`,
                    [ambassador.id]
                );
                console.log(`[Success] ₦150 credited to Ambassador ID ${ambassador.id}.`);
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
app.get('/admin/subjects', isAdmin, async (req, res) => {
    try {
        // Ensure drive_link is included in the SELECT statement
        const result = await pool.query(`
            SELECT subjects.*, universities.name as university_name 
            FROM subjects 
            LEFT JOIN universities ON subjects.university_id = universities.id 
            ORDER BY subjects.id DESC`);
        
        const universities = await pool.query('SELECT * FROM universities ORDER BY name ASC');
        
        res.render('admin/subjects', { 
            subjects: result.rows, 
            universities: universities.rows 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading subjects");
    }
});

// ADD NEW SUBJECT (Added drive_link)
app.post('/admin/subjects/add', isAdmin, async (req, res) => {
    // Added drive_link to the destructuring
    const { name, category, university_id, drive_link } = req.body; 
    try {
        await pool.query(
            'INSERT INTO subjects (name, category, university_id, drive_link) VALUES ($1, $2, $3, $4)', 
            [name, category, university_id, drive_link]
        );
        res.redirect('/admin/subjects');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding subject");
    }
});

// EDIT SUBJECT (GET THE DATA)
app.get('/admin/subjects/edit/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subjects WHERE id = $1', [req.params.id]);
        const universities = await pool.query('SELECT * FROM universities ORDER BY name ASC');
        res.render('admin/edit-subject', { 
            subject: result.rows[0], 
            universities: universities.rows 
        });
    } catch (err) {
        res.redirect('/admin/subjects');
    }
});

// UPDATE SUBJECT (SAVE CHANGES - Added drive_link)
app.post('/admin/subjects/update/:id', isAdmin, async (req, res) => {
    // Added drive_link to the destructuring
    const { name, category, university_id, drive_link } = req.body; 
    try {
        await pool.query(
            'UPDATE subjects SET name = $1, category = $2, university_id = $3, drive_link = $4 WHERE id = $5', 
            [name, category, university_id, drive_link, req.params.id]
        );
        res.redirect('/admin/subjects');
    } catch (err) {
        console.error(err);
        res.status(500).send("Update failed");
    }
});

// DELETE SUBJECT
app.post('/admin/subjects/delete/:id', isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
        res.redirect('/admin/subjects');
    } catch (err) {
        res.status(500).send("Delete failed");
    }
});

// ==========================================
// 3. QUESTION MANAGEMENT (RETAINED & LINKED)
// ==========================================

// Add a Question with a Hint
app.post('/admin/questions/add', isAdmin, async (req, res) => {
    const { subject_id, question_text, option_a, option_b, option_c, option_d, correct_option, hint } = req.body;
    try {
        await pool.query(
            `INSERT INTO questions (subject_id, question_text, option_a, option_b, option_c, option_d, correct_option, hint) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [subject_id, question_text, option_a, option_b, option_c, option_d, correct_option, hint]
        );
        res.redirect(`/admin/questions/manage/${subject_id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error saving question.");
    }
});

// This route MUST exist to handle the page request
app.get('/admin/questions/manage/:id', isAdmin, async (req, res) => {
    const subjectId = req.params.id;
    try {
        // Fetch the subject details
        const subjectRes = await pool.query('SELECT * FROM subjects WHERE id = $1', [subjectId]);
        
        // Fetch all questions for this subject
        const questionsRes = await pool.query('SELECT * FROM questions WHERE subject_id = $1 ORDER BY id DESC', [subjectId]);

        res.render('admin/manage-questions', {
            subjects: subjectRes.rows, // The EJS expects an array based on your code
            questions: questionsRes.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// BULK IMPORT (TEXTAREA JSON)
app.post('/admin/questions/bulk-import', isAdmin, async (req, res) => {
    const { subject_id, university_id, json_data } = req.body;
    try {
        const questions = JSON.parse(json_data);
        
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.redirect(`/admin/questions/manage/${subject_id}?error=No questions provided`);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            for (const q of questions) {
                await client.query(
                    `INSERT INTO questions 
                    (subject_id, university_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, hint) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        subject_id, 
                        university_id || 1,
                        q.question_text, 
                        q.option_a, 
                        q.option_b, 
                        q.option_c, 
                        q.option_d, 
                        q.correct_option, 
                        q.explanation || null,
                        q.hint || null
                    ]
                );
            }
            
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        
        res.redirect(`/admin/questions/manage/${subject_id}`);
    } catch (err) {
        console.error("JSON Import Error:", err);
        res.status(400).send("Invalid JSON Format. Please check the structure.");
    }
});

// DELETE QUESTION
app.post('/admin/questions/delete/:id/:subject_id', isAdmin, async (req, res) => {
    await pool.query('DELETE FROM questions WHERE id = $1', [req.params.id]);
    res.redirect(`/admin/questions/manage/${req.params.subject_id}`);
});

// GET EDIT PAGE
app.get('/admin/questions/edit/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const question = await pool.query('SELECT * FROM questions WHERE id = $1', [id]);
        const subject = await pool.query('SELECT * FROM subjects WHERE id = $1', [question.rows[0].subject_id]);
        res.render('admin/edit-question', { q: question.rows[0], subject: subject.rows[0] });
    } catch (err) {
        res.redirect('/admin/subjects');
    }
});

// POST UPDATE
app.post('/admin/questions/update', isAdmin, async (req, res) => {
    const { id, subject_id, question_text, option_a, option_b, option_c, option_d, correct_option, hint } = req.body;
    try {
        await pool.query(
            `UPDATE questions SET question_text=$1, option_a=$2, option_b=$3, option_c=$4, option_d=$5, correct_option=$6, hint=$7 
             WHERE id=$8`,
            [question_text, option_a, option_b, option_c, option_d, correct_option, hint, id]
        );
        res.redirect(`/admin/questions/manage/${subject_id}`);
    } catch (err) {
        res.status(500).send("Error updating question");
    }
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
            pool.query('SELECT current_streak FROM users WHERE id = $1', [userId])
        ]);
        const streak = streakRes.rows[0]?.current_streak || 0;
        const studySessions = parseInt(studyStatsRes.rows[0].s) || 0;
        const quizCount = parseInt(quizCountRes.rows[0].c) || 0;
        const avgScore = Math.round(parseFloat(avgScoreRes.rows[0].avg) || 0);

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
            recentQuiz: recentQuizRes.rows[0] || null,
            paystack_key: process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_your_key',
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
        const subjectId = quizData[0]?.subject_id || null;
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
    try {
        const query = `
            SELECT qr.*, s.name as subject_name 
            FROM quiz_results qr
            LEFT JOIN subjects s ON qr.subject_id = s.id
            WHERE qr.user_id = $1
            ORDER BY qr.created_at DESC
        `;
        const historyData = await pool.query(query, [req.session.user.id]);

        // Also fetch study quiz attempts
        const studyQuizQuery = `
            SELECT sqa.id, sqa.score, sqa.total_questions as total, sqa.question_type,
                   sqa.status, sqa.created_at, sc.course_name as subject_name,
                   'study_quiz' as source
            FROM study_quiz_attempts sqa
            LEFT JOIN study_courses sc ON sqa.course_id = sc.id
            WHERE sqa.user_id = $1 AND sqa.status = 'completed'
            ORDER BY sqa.created_at DESC
        `;
        const studyQuizData = await pool.query(studyQuizQuery, [req.session.user.id]);

        res.render('history', {
            user: req.session.user,
            history: historyData.rows,
            studyHistory: studyQuizData.rows
        });
    } catch (err) {
        console.error("History Page Error:", err);
        res.render('history', { user: req.session.user, history: [], studyHistory: [] });
    }
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
        // Fetch existing total_earned to move it to total_withdrawn
        const ambCheck = await pool.query('SELECT total_earned FROM ambassadors WHERE id = $1', [req.params.id]);
        
        if (ambCheck.rows.length > 0) {
            const earned = ambCheck.rows[0].total_earned;

            // Set total_withdrawn to match total_earned (clearing current balance to 0)
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
                res.redirect('/admin/ambassadors');
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
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard?msg=Upgrade to use deadlines');
    }

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
            deadlines: result.rows 
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

// GET: Render the Pomodoro Timer page
app.get('/pomodoro', isAuth, (req, res) => {
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard?msg=Upgrade to access the Pomodoro Timer');
    }

    res.render('pomodoro', { 
        user: req.session.user,
        hasNewNotifs: req.session.hasNewNotifs || false 
    });
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
                        { text: textContent }
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
            console.error('Gemini text call failed:', e.message);
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
// AMBASSADOR HELPER & CONTROLLER LOGIC
// =========================================================

/**
 * 1. GET ROUTE: Serve the registration page
 */
app.get('/be-ambassador', (req, res) => {
    res.render('be-ambassador'); 
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
        // Use 'pool' instead of 'db'
        const leaderboard = await pool.query(
            'SELECT * FROM daily_leaderboard ORDER BY monthly_score DESC LIMIT 30'
        );
        
        // Count total upcoming questions
        const counts = await pool.query(
            'SELECT COUNT(*) as total FROM daily_questions WHERE date_scheduled >= CURRENT_DATE'
        );
        
        // Convert string count to number
        const totalCount = parseInt(counts.rows[0].total) || 0;
        const daysLeft = Math.floor(totalCount / 10);

        res.render('admin/daily-manage', { 
            leaderboard: leaderboard.rows, 
            daysLeft: daysLeft 
        });
    } catch (err) {
        console.error("ARENA_ERROR:", err);
        res.status(500).send("Error loading admin daily: " + err.message);
    }
});

app.post('/admin/add-daily-batch', isAdmin, async (req, res) => {
    const questions = req.body.questions;

    try {
        const lastDateRes = await pool.query('SELECT MAX(date_scheduled) as max_date FROM daily_questions');
        
        let nextDate;
        if (lastDateRes.rows[0].max_date) {
            nextDate = new Date(lastDateRes.rows[0].max_date);
            nextDate.setDate(nextDate.getDate() + 1);
        } else {
            nextDate = new Date();
        }
        
        const dateStr = nextDate.toISOString().split('T')[0];

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            for (const q of questions) {
                await client.query(
                    `INSERT INTO daily_questions 
                    (question_text, option_a, option_b, option_c, option_d, correct_option, explanation, date_scheduled) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [q.text, q.a, q.b, q.c, q.d, q.correct, q.explanation || '', dateStr]
                );
            }
            
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        res.redirect('/admin/daily?success=true');
    } catch (err) {
        console.error("BATCH_INSERT_ERROR:", err);
        res.status(500).send("Database Error: " + err.message);
    }
});

app.post('/admin/bulk-daily', isAdmin, async (req, res) => {
    try {
        const rawData = JSON.parse(req.body.jsonData);
        if (!Array.isArray(rawData)) throw new Error("Data must be an array");

        const lastDateRes = await pool.query('SELECT MAX(date_scheduled) as max_date FROM daily_questions');
        let nextDate = lastDateRes.rows[0].max_date ? new Date(lastDateRes.rows[0].max_date) : new Date();
        
        const lastDateCount = await pool.query('SELECT COUNT(*) FROM daily_questions WHERE date_scheduled = $1', [nextDate]);
        let currentDayCount = parseInt(lastDateCount.rows[0].count) || 0;

        if (currentDayCount >= 10 || nextDate < new Date().setHours(0,0,0,0)) {
            nextDate.setDate(nextDate.getDate() + 1);
            currentDayCount = 0;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            for (let i = 0; i < rawData.length; i++) {
                const q = rawData[i];
                const dateStr = nextDate.toISOString().split('T')[0];

                await client.query(
                    `INSERT INTO daily_questions 
                    (question_text, option_a, option_b, option_c, option_d, correct_option, explanation, date_scheduled) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [q.text, q.a, q.b, q.c, q.d, q.correct, q.explanation || '', dateStr]
                );

                currentDayCount++;

                if (currentDayCount >= 10) {
                    nextDate.setDate(nextDate.getDate() + 1);
                    currentDayCount = 0;
                }
            }
            
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        res.redirect('/admin/daily?bulkSuccess=true');
    } catch (err) {
        console.error("BULK_ERROR:", err);
        res.status(500).send("Invalid JSON format or Database Error: " + err.message);
    }
});

app.get('/daily-challenge', isAuth, async (req, res) => {
    const sessionUser = req.session.user;

    const userId = sessionUser.id; 
    try {
        const questionsRes = await pool.query(
            'SELECT * FROM daily_questions WHERE date_scheduled = CURRENT_DATE ORDER BY id ASC LIMIT 10'
        );

        const statusRes = await pool.query(
            'SELECT last_played FROM daily_leaderboard WHERE user_id = $1',
            [userId]
        );

        let hasPlayed = false;
        if (statusRes.rows.length > 0 && statusRes.rows[0].last_played) {
            const lastPlayed = new Date(statusRes.rows[0].last_played).toDateString();
            const today = new Date().toDateString();
            if (lastPlayed === today) hasPlayed = true;
        }

        // --- UPDATED LEADERBOARD QUERY ---
        const leaderboardRes = await pool.query(`
            SELECT 
                dl.username, 
                dl.monthly_score, 
                univ.slug AS university_slug
            FROM daily_leaderboard dl
            INNER JOIN users u ON dl.user_id = u.id
            INNER JOIN universities univ ON u.university_id = univ.id
            ORDER BY dl.monthly_score DESC 
            LIMIT 10
        `);

        res.render('daily-challenge', {
            questions: questionsRes.rows,
            hasPlayed,
            leaderboard: leaderboardRes.rows,
            user: sessionUser
        });
    } catch (err) {
        console.error("ARENA_GET_ERROR:", err);
        res.status(500).send("Arena maintenance.");
    }
});
app.post('/api/submit-arena', isAuth, async (req, res) => {
    const sessionUser = req.session.user;

    const { score } = req.body;
    const userId = sessionUser.id;
    const username = sessionUser.fullname; // matches 'fullname' in your users.json

    try {
        const check = await pool.query('SELECT last_played FROM daily_leaderboard WHERE user_id = $1', [userId]);
        if (check.rows.length > 0) {
            const lastPlayed = new Date(check.rows[0].last_played).toDateString();
            if (lastPlayed === new Date().toDateString()) {
                return res.status(403).json({ error: "Already played today" });
            }
        }

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

        res.json({ success: true });
    } catch (err) {
        console.error("ARENA_SUBMIT_ERROR:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/admin/analytics', isAdmin, async (req, res) => {
    try {
        const [totals, signupTrend, popularPages] = await Promise.all([
            // 1. Core Metrics for the top cards
            pool.query(`SELECT 
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as daily_signups,
                (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as weekly_signups,
                (SELECT COUNT(*) FROM users WHERE has_paid = true) as premium_users,
                (SELECT SUM(quiz_attempts) FROM users) as total_quizzes,
                (SELECT COUNT(*) FROM daily_leaderboard) as active_battlers`),

            // 2. Signup Trend for the Line Chart
            pool.query(`SELECT TO_CHAR(created_at, 'DD Mon') as date, COUNT(*) as count 
                        FROM users 
                        WHERE created_at > NOW() - INTERVAL '14 days'
                        GROUP BY date ORDER BY MIN(created_at) ASC`),

            // 3. Most Visited Pages for the Bar Chart/List
            pool.query(`SELECT page_path, COUNT(*) as views 
                        FROM page_views 
                        GROUP BY page_path ORDER BY views DESC LIMIT 6`).catch(() => ({ rows: [] }))
        ]);

        const statsData = totals.rows[0];

        res.render('admin/analytics', {
            // Fixes the "signups is not defined" error
            signups: {
                daily: statsData.daily_signups || 0,
                weekly: statsData.weekly_signups || 0
            },
            // Fixes the "stats is not defined" error
            stats: {
                total_users: statsData.total_users || 0,
                premium_users: statsData.premium_users || 0,
                total_quizzes: statsData.total_quizzes || 0,
                active_battlers: statsData.active_battlers || 0
            },
            // Data for the Graphics
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


app.post('/upload-pdf', upload.single('lecture_note'), async (req, res) => {
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

// POST: Process and Generate Contextual Quizzes from PDFs with Gemini and OpenRouter Backup
app.post('/generate-ai-quiz', isStudent, upload.single('lecture_note'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded." });
        }

        const numQuestions = parseInt(req.body.num_questions) || 5;
        const quizDuration = parseInt(req.body.quiz_duration) || 5; 
        const questionType = req.body.question_type || 'obj'; 
        const originalFileName = req.file.originalname;
        const pdfBase64 = req.file.buffer.toString("base64");

        console.log(`[AI ENGINE] Compiling exactly ${numQuestions} [Format: ${questionType.toUpperCase()}] questions for "${originalFileName}"`);

        // Strict style guidelines to prevent format bleeding and mixed questions
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

        const promptText = `You are an expert academic examiner. Analyze the attached PDF file context carefully.
        Generate exactly ${numQuestions} unique, highly relevant academic questions based strictly on its contents.
        
        CRITICAL STYLE RULE: ${styleInstruction}

        You MUST respond with a raw JSON array matching this structure format:
        [
          {
            "type": "${questionType === 'mixed' ? 'obj' : questionType}",
            "question": "Question text here...",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correct": "Correct option text or keyword answer definition",
            "keywords": ["key1", "key2"],
            "explanation": "Detailed explanation context..."
          }
        ]`;

        // Native Gemini payload format
        const geminiPayload = {
            contents: [{
                parts: [
                    { text: promptText },
                    { inlineData: { mimeType: "application/pdf", data: pdfBase64 } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "ARRAY",
                    description: `A list of exactly ${numQuestions} questions matching the configurations specified.`,
                    items: {
                        type: "OBJECT",
                        properties: {
                            type: { type: "STRING", enum: questionType === 'mixed' ? ["obj", "german", "theory"] : [questionType] },
                            question: { type: "STRING" },
                            options: { type: "ARRAY", items: { type: "STRING" } },
                            correct: { type: "STRING" },
                            keywords: { type: "ARRAY", items: { type: "STRING" } },
                            explanation: { type: "STRING" }
                        },
                        required: ["type", "question", "options", "correct", "keywords", "explanation"]
                    }
                },
                temperature: 0.15, 
                maxOutputTokens: 8192 
            }
        };

        // OpenRouter chat completions format
        const openRouterPayload = {
            model: "openrouter/free", 
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: promptText },
                        {
                            type: "image_url",
                            image_url: { url: `data:application/pdf;base64,${pdfBase64}` }
                        }
                    ]
                }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.15
        };

        // The Router Queue Array (Ordered by your preference: Native first, OpenRouter last)
        const activeEndpoints = [
            { 
                provider: 'gemini',
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 
                key: process.env.GEMINI_API_KEY_PRIMARY 
            },
            { 
                provider: 'gemini',
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 
                key: process.env.GEMINI_API_KEY_SECONDARY 
            },
            { 
                provider: 'openrouter',
                url: 'https://openrouter.ai/api/v1/chat/completions', 
                key: process.env.OPENROUTER_API_KEY 
            }
        ].filter(endpoint => endpoint.key); // Drops any slots missing keys from env

        let response;
        let data;
        let transmissionSuccess = false;
        let connectionErrors = [];
        let responseText = "";

        // Core Fallback Processing Loop
        for (let i = 0; i < activeEndpoints.length; i++) {
            try {
                const currentTarget = activeEndpoints[i];
                console.log(`[AI ROUTER] Trying Route #${i + 1} (${currentTarget.provider.toUpperCase()})...`);

                let requestUrl = "";
                let requestBody = {};
                let headers = { 'Content-Type': 'application/json' };

                if (currentTarget.provider === 'gemini') {
                    requestUrl = `${currentTarget.url}?key=${currentTarget.key}`;
                    requestBody = geminiPayload;
                } else if (currentTarget.provider === 'openrouter') {
                    requestUrl = currentTarget.url;
                    headers['Authorization'] = `Bearer ${currentTarget.key}`;
                    headers['HTTP-Referer'] = 'https://theprepium.vercel.app'; 
                    headers['X-Title'] = 'Prepium CBT';
                    requestBody = openRouterPayload;
                }

                response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestBody),
                    signal: AbortSignal.timeout(50000) // 50s timeout limit before moving to next engine
                });

                if (response.ok) {
                    data = await response.json();
                    transmissionSuccess = true;
                    console.log(`[AI ROUTER] Route #${i + 1} (${currentTarget.provider.toUpperCase()}) Succeeded!`);
                    
                    if (currentTarget.provider === 'gemini') {
                        responseText = data.candidates[0].content.parts[0].text.trim();
                    } else if (currentTarget.provider === 'openrouter') {
                        responseText = data.choices[0].message.content.trim();
                    }
                    break; // Exit loop on successful execution
                } else {
                    const statusText = await response.text();
                    connectionErrors.push(`Route #${i + 1} failed (${response.status}): ${statusText}`);
                }
            } catch (err) {
                connectionErrors.push(`Route #${i + 1} encountered an exception: ${err.message}`);
            }
        }

        if (!transmissionSuccess) {
            console.error("[AI ROUTER TOTAL SYSTEM FAILURE]", connectionErrors.join("\n"));
            return res.status(500).json({ success: false, message: "All generation channels are busy. Please try again." });
        }

        // Standard sanitization clean up for Markdown blocks if returned
        if (responseText.startsWith("```json")) responseText = responseText.replace(/^```json/, "").replace(/```$/, "");
        if (responseText.startsWith("```")) responseText = responseText.replace(/^```/, "").replace(/```$/, "");

        let parsedData = JSON.parse(responseText.trim());
        let structuredQuiz = Array.isArray(parsedData) ? parsedData : (parsedData.questions || parsedData.quiz || []);

        // Strict mapping sanitization layout formatting
        structuredQuiz = structuredQuiz.map(q => {
            if (questionType !== 'mixed') q.type = questionType;
            if (!q.options) q.options = [];
            if (!q.keywords) q.keywords = [];
            
            if (questionType === 'obj' && q.options.length === 0) {
                q.options = ["Option A", "Option B", "Option C", "Option D"];
            }
            return q;
        });

        res.json({ 
            success: true, 
            questions: structuredQuiz,
            quizTitle: `AI-Test (${originalFileName.replace(/\.[^/.]+$/, "")})`,
            durationSeconds: quizDuration * 60
        });

    } catch (error) {
        console.error("Critical Hybrid Routing Failure:", error);
        res.status(500).json({ success: false, message: "Error compiling quiz matrix." });
    }
});

// POST: Save and Persist Graded Flexible Score Results
app.post('/save-ai-quiz-results', isStudent, async (req, res) => {
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

// ======================== STUDY HUB ROUTES ========================

// Study AI helper - rotates between PRIMARY and SECONDARY keys on quota / failure
const studyKeys = [process.env.GEMINI_API_KEY_PRIMARY, process.env.GEMINI_API_KEY_SECONDARY].filter(Boolean);
let studyKeyIdx = 0;
function nextStudyKey() {
  if (studyKeys.length === 0) return null;
  const k = studyKeys[studyKeyIdx % studyKeys.length];
  studyKeyIdx++;
  return k;
}
async function studyPromptAI(prompt) {
  if (studyKeys.length === 0) return { text: 'AI not configured' };
  let lastErr = null;
  const totalKeys = studyKeys.length;
  for (let i = 0; i < totalKeys; i++) {
    const key = nextStudyKey();
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
      console.warn(`[StudyAI] key ${i + 1}/${totalKeys} failed: ${msg.slice(0, 120)}`);
      if (!isQuota) break;
    }
  }
  return { text: 'AI error: ' + ((lastErr && lastErr.message) || 'all keys exhausted') };
}

// Ensure study tables exist
(async function initStudyDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS study_courses (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_name VARCHAR(255) NOT NULL, course_code VARCHAR(50) DEFAULT '', unit INTEGER DEFAULT 3, source VARCHAR(20) DEFAULT 'manual', created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_topics (id SERIAL PRIMARY KEY, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL, topic_name VARCHAR(500) NOT NULL, title VARCHAR(500), completed BOOLEAN DEFAULT false, order_index INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_subtopics (id SERIAL PRIMARY KEY, topic_id INTEGER NOT NULL, course_id INTEGER NOT NULL, user_id INTEGER NOT NULL, subtopic_name VARCHAR(500) NOT NULL, title VARCHAR(500), status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, course_name VARCHAR(255) DEFAULT '', elapsed_seconds INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'active', notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_progress (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, course_name VARCHAR(255) NOT NULL, total_sessions INTEGER DEFAULT 0, total_minutes INTEGER DEFAULT 0, last_studied TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_chat_messages (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, role VARCHAR(20) DEFAULT 'user', message TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_flashcards (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, front TEXT NOT NULL, back TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_quiz_attempts (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, course_id INTEGER DEFAULT 0, subtopic_id INTEGER DEFAULT 0, question_type VARCHAR(50) DEFAULT 'multiple_choice', question_count INTEGER DEFAULT 10, time_limit INTEGER DEFAULT 0, score INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'in_progress', created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS study_quiz_questions (id SERIAL PRIMARY KEY, attempt_id INTEGER NOT NULL, question TEXT NOT NULL, options JSONB, correct_answer TEXT, user_answer TEXT, is_correct BOOLEAN, explanation TEXT, order_index INTEGER DEFAULT 0)`);
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
      ['study_sessions', 'subtopic_id', 'INTEGER DEFAULT 0'],
      ['study_sessions', 'subject_id', 'INTEGER DEFAULT 0'],
      ['study_flashcards', 'course_id', 'INTEGER DEFAULT 0'],
      ['study_quiz_attempts', 'course_id', 'INTEGER DEFAULT 0'],
    ];
    for (const [t, c, d] of adds) { try { await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${d}`); } catch(_){} }
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

// Study Dashboard
app.get('/study', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [coursesRes, progressRes, sessionsRes] = await Promise.all([
      pool.query('SELECT * FROM study_courses WHERE user_id = $1 ORDER BY course_name ASC', [uid]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 ORDER BY last_studied DESC', [uid]),
      pool.query('SELECT * FROM study_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [uid])
    ]);
    res.render('study', { user: req.session.user, courses: coursesRes.rows, progress: progressRes.rows, recentSessions: sessionsRes.rows, subjects: [] });
  } catch (err) { console.error(err); res.status(500).send('Error loading study page'); }
});

// Course Detail
app.get('/study/course/:id', isAuth, requirePaid, async (req, res) => {
  try {
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (!course.rows[0]) return res.status(404).send('Course not found');
    const [topicsRes, progressRes] = await Promise.all([
      pool.query('SELECT t.*, (SELECT json_agg(json_build_object(\'id\', s.id, \'subtopic_name\', s.subtopic_name, \'status\', s.status)) FROM study_subtopics s WHERE s.topic_id = t.id) as subtopics FROM study_topics t WHERE t.course_id = $1 ORDER BY t.id ASC', [req.params.id]),
      pool.query('SELECT * FROM study_progress WHERE user_id = $1 AND course_id = $2', [req.session.user.id, req.params.id])
    ]);
    res.render('study-course', { user: req.session.user, course: course.rows[0], topics: topicsRes.rows, progress: progressRes.rows[0] || null });
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
    const questions = await pool.query('SELECT id, question, options, order_index FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC', [req.params.attemptId]);
    res.render('study-quiz', { user: req.session.user, attempt: attempt.rows[0], questions: questions.rows });
  } catch (err) { res.status(500).send('Error loading quiz'); }
});

// Flashcards Page
app.get('/study/flashcards/:courseId', isAuth, requirePaid, async (req, res) => {
  res.render('study-flashcards', { user: req.session.user, courseId: parseInt(req.params.courseId) });
});

// API: Import from timetable
app.post('/api/study/import-timetable', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const tt = await pool.query('SELECT DISTINCT course, course_code, unit FROM timetables WHERE user_id = $1', [uid]);
    let count = 0;
    for (const row of tt.rows) {
      const exists = await pool.query('SELECT id FROM study_courses WHERE user_id = $1 AND course_name = $2', [uid, row.course]);
      if (!exists.rows[0]) {
        await pool.query('INSERT INTO study_courses (user_id, course_name, course_code, unit, source) VALUES ($1, $2, $3, $4, $5)', [uid, row.course, row.course_code || '', row.unit || 3, 'timetable']);
        count++;
      }
    }
    res.json({ success: true, imported: count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Add topic
app.post('/api/study/topics', isAuth, requirePaid, async (req, res) => {
  try {
    const { course_id, topic_name } = req.body;
    const name = (topic_name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Topic name required' });
    const max = await pool.query('SELECT COALESCE(MAX(order_index), 0) as n FROM study_topics WHERE course_id = $1', [course_id]);
    const orderIdx = parseInt(max.rows[0]?.n || 0, 10) + 1;
    const r = await pool.query(
      'INSERT INTO study_topics (course_id, user_id, topic_name, title, order_index) VALUES ($1, $2, $3, $3, $4) RETURNING *',
      [course_id, req.session.user.id, name, orderIdx]
    );
    res.json({ success: true, topic: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Delete topic
app.delete('/api/study/topics/:id', isAuth, requirePaid, async (req, res) => {
  try {
    await pool.query('DELETE FROM study_subtopics WHERE topic_id = $1', [req.params.id]);
    await pool.query('DELETE FROM study_topics WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Generate topics with AI
app.post('/api/study/generate-topics', isAuth, requirePaid, async (req, res) => {
  try {
    const { course_id } = req.body;
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [course_id]);
    if (!course.rows[0]) return res.json({ success: false, error: 'Course not found' });
    const prompt = `Generate a list of 8-12 important topics for the university course "${course.rows[0].course_name} ${course.rows[0].course_code}". Return ONLY a JSON array of strings. Example: ["Topic 1", "Topic 2"]`;
    const aiRes = await studyPromptAI(prompt);
    let topics = [];
    try { topics = JSON.parse(aiRes.text.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { topics = aiRes.text.split('\n').filter(l => l.trim()).map(l => l.replace(/^[\d.\s-]+/,'').trim()).filter(Boolean); }
    let count = 0;
    for (const t of topics.slice(0, 15)) {
      const exists = await pool.query('SELECT id FROM study_topics WHERE course_id = $1 AND (topic_name = $2 OR title = $2)', [course_id, t]);
      if (!exists.rows[0]) { await pool.query('INSERT INTO study_topics (course_id, user_id, topic_name, title) VALUES ($1, $2, $3, $3)', [course_id, req.session.user.id, t]); count++; }
    }
    res.json({ success: true, count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Generate subtopics with AI
app.post('/api/study/generate-subtopics', isAuth, requirePaid, async (req, res) => {
  try {
    const { topic_id } = req.body;
    const topic = await pool.query('SELECT * FROM study_topics WHERE id = $1', [topic_id]);
    if (!topic.rows[0]) return res.json({ success: false, error: 'Topic not found' });
    const topicName = topic.rows[0].topic_name || topic.rows[0].title;
    const prompt = `For the topic "${topicName}", generate 5-7 specific subtopics. Return ONLY a JSON array of strings. Example: ["Subtopic 1", "Subtopic 2"]`;
    const aiRes = await studyPromptAI(prompt);
    let subtopics = [];
    try { subtopics = JSON.parse(aiRes.text.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { subtopics = aiRes.text.split('\n').filter(l => l.trim()).map(l => l.replace(/^[\d.\s-]+/,'').trim()).filter(Boolean); }
    let count = 0;
    const uid = req.session.user.id;
    for (const st of subtopics.slice(0, 10)) {
      const clean = (st || '').replace(/^["'\s]+|["'\s]+$/g,'').trim();
      if (!clean) continue;
      const exists = await pool.query('SELECT id FROM study_subtopics WHERE topic_id = $1 AND (subtopic_name = $2 OR title = $2)', [topic_id, clean]);
      if (!exists.rows[0]) { await pool.query('INSERT INTO study_subtopics (topic_id, course_id, user_id, subtopic_name, title, status) VALUES ($1, $2, $3, $4, $4, $5)', [topic_id, topic.rows[0].course_id, uid, clean, 'ai-generated']); count++; }
    }
    res.json({ success: true, count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Accept subtopic
app.put('/api/study/subtopics/:id/accept', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('UPDATE study_subtopics SET status = $1 WHERE id = $2', ['accepted', req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Update subtopic
app.put('/api/study/subtopics/:id', isAuth, requirePaid, async (req, res) => {
  try {
    const name = (req.body.subtopic_name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Name required' });
    await pool.query('UPDATE study_subtopics SET subtopic_name = $1, title = $1 WHERE id = $2', [name, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Delete subtopic
app.delete('/api/study/subtopics/:id', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('DELETE FROM study_subtopics WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Create study session
app.post('/api/study/sessions', isAuth, requirePaid, async (req, res) => {
  try {
    const { course_id } = req.body;
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [course_id]);
    const r = await pool.query('INSERT INTO study_sessions (user_id, course_id, course_name, status) VALUES ($1, $2, $3, $4) RETURNING *', [req.session.user.id, course_id, course.rows[0] ? course.rows[0].course_name : 'Study', 'active']);
    res.json({ success: true, session_id: r.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: End session
app.put('/api/study/sessions/:id/end', isAuth, requirePaid, async (req, res) => {
  try {
    const { elapsed_seconds } = req.body;
    const sid = req.params.id;
    const uid = req.session.user.id;
    await pool.query('UPDATE study_sessions SET status = $1, elapsed_seconds = $2, completed_at = NOW() WHERE id = $3 AND user_id = $4', ['completed', elapsed_seconds || 0, sid, uid]);
    const s = (await pool.query('SELECT * FROM study_sessions WHERE id = $1', [sid])).rows[0];
    if (s) {
      const mins = Math.ceil((elapsed_seconds || 0) / 60);
      await pool.query('INSERT INTO study_progress (user_id, course_id, course_name, total_sessions, total_minutes, last_studied) VALUES ($1, $2, $3, 1, $4, NOW()) ON CONFLICT (user_id, course_name) DO UPDATE SET total_sessions = study_progress.total_sessions + 1, total_minutes = study_progress.total_minutes + $4, last_studied = NOW()', [uid, s.course_id, s.course_name, mins]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Get session
app.get('/api/study/sessions/:id', isAuth, async (req, res) => {
  try {
    const s = await pool.query('SELECT * FROM study_sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    res.json(s.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Save notes
app.put('/api/study/sessions/:id/notes', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('UPDATE study_sessions SET notes = $1 WHERE id = $2 AND user_id = $3', [req.body.notes, req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: AI Chat
app.post('/api/study/chat', isAuth, requirePaid, async (req, res) => {
  try {
    const { message, session_id, course_name } = req.body;
    const uid = req.session.user.id;
    await pool.query('INSERT INTO study_chat_messages (user_id, course_id, role, message) VALUES ($1, $2, $3, $4)', [uid, 0, 'user', message]);
    const ctx = course_name ? `Context: Student is studying "${course_name}". ` : '';
    const prompt = `${ctx}You are a helpful university study assistant. Answer clearly with examples. Student: ${message}`;
    const aiRes = await studyPromptAI(prompt);
    await pool.query('INSERT INTO study_chat_messages (user_id, course_id, role, message) VALUES ($1, $2, $3, $4)', [uid, 0, 'ai', aiRes.text]);
    res.json({ success: true, reply: aiRes.text });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: YouTube search (AI-generated search links)
app.get('/api/study/youtube', isAuth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const prompt = `Generate 5 YouTube search queries for learning: "${q}". Return ONLY a JSON array of objects with "id" (a placeholder like "vid1"), "title" (descriptive title), "channel" (fictional channel name). Example: [{"id":"vid1","title":"...","channel":"..."}]`;
    const aiRes = await studyPromptAI(prompt);
    let videos = [];
    try { videos = JSON.parse(aiRes.text.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { videos = [{ id: 'vid1', title: 'Search YouTube for: ' + q, channel: 'YouTube' }]; }
    res.json({ success: true, videos });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Generate quiz
app.post('/api/study/quiz/generate', isAuth, requirePaid, async (req, res) => {
  try {
    const { course_id, subtopic_id, question_type, question_count, timed_minutes } = req.body;
    const count = parseInt(question_count) || 5;
    const uid = req.session.user.id;
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [course_id || 0]);
    const courseName = course.rows[0] ? course.rows[0].course_name : 'General Study';
    const prompt = `Generate ${count} ${question_type || 'mixed'} questions about "${courseName}" for university exam prep. For each: question, 4 options (for multiple choice) or answer (for theory), correctAnswer, explanation. Return JSON array: [{ "question": "...", "options": ["A...","B...","C...","D..."], "correctAnswer": "A", "explanation": "..." }]. For theory, use options: [].`;
    const aiRes = await studyPromptAI(prompt);
    let questions = [];
    try { questions = JSON.parse(aiRes.text.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { throw new Error('Failed to parse AI response'); }
    const attempt = await pool.query('INSERT INTO study_quiz_attempts (user_id, course_id, subtopic_id, question_type, question_count, time_limit, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *', [uid, course_id || 0, subtopic_id || 0, question_type || 'mixed', questions.length, timed_minutes || 0, 'in_progress']);
    const attemptId = attempt.rows[0].id;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await pool.query('INSERT INTO study_quiz_questions (attempt_id, question, options, correct_answer, explanation, order_index) VALUES ($1, $2, $3, $4, $5, $6)', [attemptId, q.question, JSON.stringify(q.options || []), q.correctAnswer, q.explanation || '', i]);
    }
    res.json({ success: true, quiz_id: attemptId, questions });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Submit quiz
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
    await pool.query('UPDATE study_quiz_attempts SET score = $1, total_questions = $2, status = $3, completed_at = NOW() WHERE id = $4', [score, total, 'completed', attemptId]);

    // Sync quiz results to study progress
    try {
      const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1', [attemptId]);
      if (attempt.rows[0] && attempt.rows[0].course_id > 0) {
        const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [attempt.rows[0].course_id]);
        if (course.rows[0]) {
          const cname = course.rows[0].course_name;
          await pool.query('INSERT INTO study_progress (user_id, course_id, course_name, total_sessions, total_minutes, last_studied) VALUES ($1, $2, $3, 1, 5, NOW()) ON CONFLICT (user_id, course_name) DO UPDATE SET total_sessions = study_progress.total_sessions + 1, total_minutes = study_progress.total_minutes + 5, last_studied = NOW()', [attempt.rows[0].user_id, attempt.rows[0].course_id, cname]);
        }
      }
    } catch (syncErr) { console.error('Quiz-study sync error:', syncErr.message); }

    res.json({ success: true, score, total });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Quiz results
app.get('/api/study/quiz/result/:attemptId', isAuth, async (req, res) => {
  try {
    const attempt = await pool.query('SELECT * FROM study_quiz_attempts WHERE id = $1 AND user_id = $2', [req.params.attemptId, req.session.user.id]);
    const questions = await pool.query('SELECT * FROM study_quiz_questions WHERE attempt_id = $1 ORDER BY order_index ASC', [req.params.attemptId]);
    res.json({ attempt: attempt.rows[0], questions: questions.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Generate flashcards
app.post('/api/study/flashcards/generate', isAuth, requirePaid, async (req, res) => {
  try {
    const { courseId, subtopicId, course_name } = req.body;
    const uid = req.session.user.id;
    const course = await pool.query('SELECT * FROM study_courses WHERE id = $1', [courseId || 0]);
    const name = course_name || (course.rows[0] ? course.rows[0].course_name : 'General');
    const prompt = `Generate 10 flashcards for "${name}". Each: front (question/term), back (answer/definition). Return JSON array: [{ "front": "...", "back": "..." }]`;
    const aiRes = await studyPromptAI(prompt);
    let cards = [];
    try { cards = JSON.parse(aiRes.text.replace(/```json/g,'').replace(/```/g,'').trim()); } catch { throw new Error('Failed to generate flashcards'); }
    for (const c of cards) {
      await pool.query('INSERT INTO study_flashcards (user_id, course_id, subtopic_id, front, back) VALUES ($1, $2, $3, $4, $5)', [uid, courseId || 0, subtopicId || 0, c.front, c.back]);
    }
    res.json({ success: true, count: cards.length, cards });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: Get flashcards
app.get('/api/study/flashcards', isAuth, async (req, res) => {
  try {
    const { courseId } = req.query;
    let q = 'SELECT * FROM study_flashcards WHERE user_id = $1';
    const p = [req.session.user.id];
    if (courseId) { q += ' AND course_id = $2'; p.push(courseId); }
    q += ' ORDER BY created_at DESC';
    const r = await pool.query(q, p);
    res.json({ flashcards: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Delete flashcard
app.post('/api/study/flashcards/delete/:id', isAuth, requirePaid, async (req, res) => {
  try { await pool.query('DELETE FROM study_flashcards WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// API: CGPA sync - import study courses into CGPA
app.post('/api/study/cgpa-sync', isAuth, requirePaid, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const courses = await pool.query('SELECT * FROM study_courses WHERE user_id = $1', [uid]);
    const profile = await pool.query('SELECT * FROM public.cgpa_profiles WHERE user_id = $1', [uid]);
    if (!profile.rows[0]) return res.json({ success: false, error: 'Set up CGPA profile first' });
    let synced = 0;
    for (const c of courses.rows) {
      const exists = await pool.query('SELECT id FROM public.cgpa_courses WHERE user_id = $1 AND course_code = $2 AND deleted = false', [uid, c.course_code || c.course_name]);
      if (!exists.rows[0]) {
        const level = profile.rows[0].current_level || 300;
        await pool.query('INSERT INTO public.cgpa_courses (user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)', [uid, c.course_code || c.course_name, c.course_name, level, 1, c.unit || 3, 'A']);
        synced++;
      }
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

    res.json({ success: true, currentCGPA: currentCGPA.toFixed(2), scenarios, addScenarios, targetData });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    res.json({
      student: user.rows[0] ? { name: user.rows[0].fullname, email: user.rows[0].email } : {},
      department: profile.rows[0]?.department || '',
      gradingScale: scale,
      semesters: Object.values(semesterData).sort((a,b) => a.level - b.level || a.semester - b.semester),
      totalUnits, cgpa: cgpa.toFixed(2), degreeClass,
      generatedAt: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Study stats
app.get('/api/study/stats', isAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [ts, tm, tc, fc] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM study_sessions WHERE user_id = $1 AND status = $2', [uid, 'completed']),
      pool.query('SELECT COALESCE(SUM(elapsed_seconds), 0) as t FROM study_sessions WHERE user_id = $1 AND status = $2', [uid, 'completed']),
      pool.query('SELECT COUNT(*) as c FROM study_courses WHERE user_id = $1', [uid]),
      pool.query('SELECT COUNT(*) as c FROM study_flashcards WHERE user_id = $1', [uid])
    ]);
    res.json({ totalSessions: parseInt(ts.rows[0].c), totalMinutes: Math.floor(parseInt(tm.rows[0].t) / 60), totalCourses: parseInt(tc.rows[0].c), totalFlashcards: parseInt(fc.rows[0].c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================== END STUDY HUB ROUTES ========================

// Global error handler - catches multer and other errors, returns JSON
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, message: 'File too large. Maximum size is 50MB.' });
        }
        return res.status(400).json({ success: false, message: err.message });
    }
    if (err.type === 'entity.too.large') {
        return res.status(400).json({ success: false, message: 'File too large. Maximum size is 50MB.' });
    }
    res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
});

const config = {
    maxDuration: 60,
};

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;