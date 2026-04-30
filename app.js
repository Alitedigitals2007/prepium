const express = require('express');

const bcrypt = require('bcryptjs');
const session = require('express-session');
require('dotenv').config();
const app = express();
const { Pool } = require('pg');
require('dotenv').config();

// Initialize the connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Export it if your routes are in a different file, 
// or just use it directly if they are in app.js

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: 'prepium_secret', resave: false, saveUninitialized: true }));

// Middleware to check if user is logged in
const isAuth = (req, res, next) => {
    if (req.session.user) return next();
    res.redirect('/login');
};

// Middleware to check payment status
const hasPaid = (req, res, next) => {
    if (req.session.user.has_paid) return next();
    res.redirect('/payment');
};
const isAdmin = (req, res, next) => {
    // 1. Check if user is logged in
    if (!req.session.user) {
        return res.redirect('/login');
    }

    // 2. Check for admin status (Boolean check)
    if (req.session.user.is_admin === true) {
        return next();
    }

    // 3. If they are a regular user trying to access /admin
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
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('index');
});

// Auth Routes
app.get('/signup', (req, res) => res.render('signup'));
app.get('/login', (req, res) => res.render('login'));

// Sign Up Page
app.get('/signup', (req, res) => {
    res.render('signup');
});

// Process Sign Up with Ambassador Referral Logic
app.post('/auth/signup', async (req, res) => {
    // added referred_by and is_premium to the request body
    const { fullname, email, password, referred_by, is_premium } = req.body; 
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 1. Insert the new user into the database
        // We store the referred_by code so we know who brought them in
        await pool.query(
            'INSERT INTO users (full_name, email, password, referred_by_code, is_premium) VALUES ($1, $2, $3, $4, $5)',
            [fullname, email, hashedPassword, referred_by || null, is_premium === 'true']
        );

        // 2. Logic for Ambassador Payment (₦150)
        // Only trigger if a code was used AND the user is Premium
        if (referred_by && is_premium === 'true') {
            const ambCheck = await pool.query(
                'SELECT id FROM ambassadors WHERE unique_code = $1',
                [referred_by]
            );

            if (ambCheck.rows.length > 0) {
                // Update Ambassador's earnings and referral count
                await pool.query(
                    `UPDATE ambassadors 
                     SET total_earned = total_earned + 150, 
                         total_referrals = total_referrals + 1 
                     WHERE unique_code = $1`,
                    [referred_by]
                );
                console.log(`Referral credited to Ambassador: ${referred_by}`);
            }
        }

        res.redirect('/login?msg=Account created! Please login.');
        
    } catch (err) {
        console.error("Signup Error:", err);
        res.send("Error: Email might already exist or database connection failed.");
    }
});

// Login Page GET route
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// GET Login Page
app.get('/login', (req, res) => {
    // Check if already logged in
    if (req.session.user) {
        return res.redirect(req.session.user.is_admin ? '/admin/dashboard' : '/dashboard');
    }
    res.render('login', { error: null });
});

// POST Login Handler
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Find user by email
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            
            // 2. Compare hashed password (ayomide2007)
            const isMatch = await bcrypt.compare(password, user.password);

            if (isMatch) {
                // 3. Define Admin Status
                // Logic: Admin if DB says so OR if it's your specific email
                const isAdminAccount = (user.email === 'michaelbrainny842@gmail.com');

                // 4. Construct Session Object
                req.session.user = { 
                    id: user.id, 
                    fullname: user.fullname, 
                    email: user.email,
                    is_admin: user.is_admin || isAdminAccount, // Forced admin override
                    has_paid: user.has_paid,
                    current_streak: user.current_streak || 0
                };

                // 5. Explicitly save session before redirecting
                return req.session.save((err) => {
                    if (err) {
                        console.error("Session Save Error:", err);
                        return res.status(500).send("Login failed during session setup");
                    }

                    // 6. Direct to correct dashboard
                    if (req.session.user.is_admin) {
                        return res.redirect('/admin/dashboard');
                    } else {
                        return res.redirect('/dashboard');
                    }
                });
            }
        }

        // If credentials don't match
        return res.render('login', { error: "Invalid email or password" });
        
    } catch (err) {
        console.error("Critical Login Error:", err);
        res.status(500).send("A server error occurred. Please try again.");
    }
});

// Add this to your app.js / server file
app.get('/verify-payment', async (req, res) => {
    const { reference } = req.query;

    try {
        // 1. Verify with Paystack (Optional but recommended for security)
        // 2. Update the Database
        await pool.query(
            'UPDATE users SET has_paid = true WHERE id = $1', 
            [req.session.user.id]
        );

        // 3. CRITICAL: Update the session data so the UI changes immediately
        req.session.user.has_paid = true;

        // 4. Send them back to the dashboard
        res.redirect('/dashboard?payment=success');

    } catch (err) {
        console.error(err);
        res.redirect('/dashboard?payment=failed');
    }
});

app.get('/profile', isAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // 1. Get user info
        const userRes = await pool.query(
            'SELECT fullname, email, has_paid FROM users WHERE id = $1', 
            [userId]
        );
        const user = userRes.rows[0];

        // 2. Get Stats from quiz_results (using percentage for average)
        const statsRes = await pool.query(
            'SELECT COUNT(*) as total_tests, AVG(percentage) as avg_score FROM quiz_results WHERE user_id = $1',
            [userId]
        );
        const statsRow = statsRes.rows[0];

        res.render('profile', { 
            user, 
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
        // 1. Run all counts in parallel for speed
        const [userCount, premiumCount, subjectCount, questionCount] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) FROM users WHERE has_paid = true'),
            pool.query('SELECT COUNT(*) FROM subjects'),
            pool.query('SELECT COUNT(*) FROM questions')
        ]);

        // 2. Get the 5 most recently registered students
        const recentUsers = await pool.query(
            'SELECT fullname, email, has_paid, created_at FROM users ORDER BY id DESC LIMIT 5'
        );

        res.render('admin/dashboard', {
            stats: {
                students: userCount.rows[0].count,
                premium: premiumCount.rows[0].count,
                subjects: subjectCount.rows[0].count,
                questions: questionCount.rows[0].count
            },
            recentUsers: recentUsers.rows
        });
    } catch (err) {
        console.error("Admin Dashboard Error:", err);
        res.status(500).send("Could not load Admin Dashboard. Check your database tables.");
    }
});

// 1. VIEW ALL SUBJECTS
app.get('/admin/subjects', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subjects ORDER BY id DESC');
        res.render('admin/subjects', { subjects: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading subjects");
    }
});

// 2. ADD NEW SUBJECT
app.post('/admin/subjects/add', isAdmin, async (req, res) => {
    const { name, category } = req.body;
    try {
        await pool.query('INSERT INTO subjects (name, category) VALUES ($1, $2)', [name, category]);
        res.redirect('/admin/subjects');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding subject");
    }
});

// 3. EDIT SUBJECT (GET THE DATA)
app.get('/admin/subjects/edit/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subjects WHERE id = $1', [req.params.id]);
        res.render('admin/edit-subject', { subject: result.rows[0] });
    } catch (err) {
        res.redirect('/admin/subjects');
    }
});

// 4. UPDATE SUBJECT (SAVE CHANGES)
app.post('/admin/subjects/update/:id', isAdmin, async (req, res) => {
    const { name, category } = req.body;
    try {
        await pool.query('UPDATE subjects SET name = $1, category = $2 WHERE id = $3', [name, category, req.params.id]);
        res.redirect('/admin/subjects');
    } catch (err) {
        res.status(500).send("Update failed");
    }
});

// 5. DELETE SUBJECT
app.get('/admin/subjects/delete/:id', isAdmin, async (req, res) => {
    try {
        // This will also delete questions if you set up ON DELETE CASCADE in SQL
        await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
        res.redirect('/admin/subjects');
    } catch (err) {
        res.status(500).send("Delete failed");
    }
});

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

// JSON API for the App (To get questions for a subject)
app.get('/api/questions/:subject_id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM questions WHERE subject_id = $1', [req.params.subject_id]);
        res.json(result.rows); // This sends the data as JSON for your frontend
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch questions" });
    }
});

// 1. VIEW QUESTIONS PAGE
app.get('/admin/questions/manage/:subject_id', isAdmin, async (req, res) => {
    const { subject_id } = req.params;
    try {
        const subject = await pool.query('SELECT * FROM subjects WHERE id = $1', [subject_id]);
        const questions = await pool.query('SELECT * FROM questions WHERE subject_id = $1 ORDER BY id DESC', [subject_id]);
        res.render('admin/manage-questions', { subject: subject.rows[0], questions: questions.rows });
    } catch (err) {
        res.redirect('/admin/subjects');
    }
});

// 2. BULK IMPORT (JSON)
app.post('/admin/questions/bulk-import', isAdmin, async (req, res) => {
    const { subject_id, json_data } = req.body;
    try {
        const data = JSON.parse(json_data); 
        // We use a loop to insert all questions from the array
        for (let q of data) {
            await pool.query(
                `INSERT INTO questions (subject_id, question_text, option_a, option_b, option_c, option_d, correct_option, hint) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [subject_id, q.question, q.a, q.b, q.c, q.d, q.answer, q.hint || null]
            );
        }
        res.redirect(`/admin/questions/manage/${subject_id}`);
    } catch (err) {
        console.error(err);
        res.status(400).send("Invalid JSON Format. Ensure it matches the required template.");
    }
});

// 3. DELETE QUESTION
app.get('/admin/questions/delete/:id/:subject_id', isAdmin, async (req, res) => {
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

        // 1. Fetch Fresh User Data (Payment, Streak)
        const userRes = await pool.query(
            'SELECT has_paid, current_streak FROM users WHERE id = $1', 
            [userId]
        );
        const userData = userRes.rows[0];

        // 2. Notification Check (For the Red Dot)
        const notifCheck = await pool.query('SELECT COUNT(*) FROM notifications');
        const hasNewNotifs = parseInt(notifCheck.rows[0].count) > 0;

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

        res.render('dashboard', { 
            // Combines session info with database status
            user: { ...req.session.user, ...userData }, 
            competition: compRes.rows[0],
            subjects: subjectsRes.rows,
            history: historyRes.rows,
            hasNewNotifs: hasNewNotifs, // This triggers your red dot
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

// 1. View Subjects & Question counts
app.get('/subjects', isStudent, async (req, res) => {
    try {
        // We JOIN the questions table with the subjects table to get the name
        const result = await pool.query(`
            SELECT s.name AS subject, COUNT(q.id) as question_count 
            FROM questions q
            JOIN subjects s ON q.subject_id = s.id
            GROUP BY s.name
            ORDER BY s.name ASC
        `);

        res.render('subjects-library', {
            user: req.session.user,
            subjects: result.rows
        });
    } catch (err) {
        console.error("Database Error details:", err.message);
        res.status(500).send("Database Error: Check your table relationships.");
    }
});

// 2. Setup Test Page
app.get('/setup-test', isStudent, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.name, COUNT(q.id) as total_questions 
            FROM subjects s
            LEFT JOIN questions q ON s.id = q.subject_id
            GROUP BY s.id, s.name
            ORDER BY s.name ASC
        `);
        
        res.render('setup-test', {
            user: req.session.user,
            subjects: result.rows
        });
    } catch (err) {
        console.error("Setup Error:", err.message);
        res.redirect('/dashboard');
    }
});

app.post('/start-quiz', isStudent, async (req, res) => {
    try {
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

        // Store temp setup in session (but don't fetch all questions yet to save memory)
        req.session.tempQuiz = {
            summary,
            duration,
            totalQs
        };

        res.render('quiz-lobby', {
            user: req.session.user,
            setup: req.session.tempQuiz
        });
    } catch (err) {
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
        if (!req.session.activeQuiz || !req.session.activeQuiz.questions) {
            console.error("Submission Error: No active quiz found in session.");
            return res.redirect('/dashboard');
        }

        const userAnswers = JSON.parse(req.body.answers || "[]");
        const quizData = req.session.activeQuiz.questions;
        const timeUsed = req.body.timeUsed || "00:00"; 
        
        // We need the subject_id from the first question to categorize the result
        const subjectId = quizData[0]?.subject_id || null;
        const userId = req.session.user.id;

        let score = 0;
        let subjectStats = {}; 

        const results = quizData.map((q, index) => {
            const dbAnswer = q.correct_option || ""; 
            const userChoice = userAnswers[index] || "";
            const isCorrect = userChoice.toString().toLowerCase() === dbAnswer.toString().toLowerCase();
            
            if (isCorrect) score++;

            const sName = q.subject_name || `Subject ${q.subject_id}`;
            if (!subjectStats[sName]) {
                subjectStats[sName] = { correct: 0, total: 0 };
            }
            subjectStats[sName].total++;
            if (isCorrect) subjectStats[sName].correct++;

            return {
                ...q,
                userChoice: userChoice,
                isCorrect: isCorrect,
                hint: q.hint,
                explanation: q.explanation,
                correctAnswer: dbAnswer 
            };
        });

        const totalQuestions = quizData.length;
        const percentage = totalQuestions > 0 ? Math.round((score / totalQuestions) * 100) : 0;

        // --- NEW: SAVE TO DATABASE ---
        // This ensures the record exists when you visit /history
        try {
            await pool.query(
                `INSERT INTO quiz_results (user_id, subject_id, score, total_questions, percentage, time_taken, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [userId, subjectId, score, totalQuestions, percentage, timeUsed]
            );
        } catch (dbErr) {
            console.error("Database Save Error:", dbErr);
            // We continue to render results even if saving fails, so the user sees their score
        }

        res.render('quiz-result', {
            user: req.session.user,
            score,
            total: totalQuestions,
            percentage,
            subjectStats,
            results,
            timeUsed 
        });

        // Clean up the session so they can't refresh and re-submit
        delete req.session.activeQuiz;

    } catch (err) {
        console.error("Full Submission Error:", err);
        res.redirect('/dashboard');
    }
});

app.get('/history', isStudent, async (req, res) => {
    try {
        const query = `
            SELECT qr.*, s.name as subject_name 
            FROM quiz_results qr
            LEFT JOIN subjects s ON qr.subject_id = s.id
            WHERE qr.user_id = $1
            ORDER BY qr.created_at DESC
        `;
        const historyData = await pool.query(query, [req.session.user.id]);

        res.render('history', {
            user: req.session.user,
            history: historyData.rows
        });
    } catch (err) {
        console.error("History Page Error:", err);
        res.render('history', { user: req.session.user, history: [] });
    }
});

app.post('/ambassador/login', async (req, res) => {
    const { unique_code } = req.body;
    try {
        const result = await pool.query('SELECT * FROM ambassadors WHERE unique_code = $1', [unique_code]);
        if (result.rows.length > 0) {
            req.session.ambassador = result.rows[0]; // Store ambassador info in session
            res.redirect('/ambassador/dashboard');
        } else {
            res.send("Invalid Ambassador ID.");
        }
    } catch (err) {
        res.status(500).send("Login error.");
    }
});

app.get('/ambassador/dashboard', async (req, res) => {
    if (!req.session.ambassador) return res.redirect('/ambassador/login');
    
    try {
        // Refresh ambassador data from DB (to see new earnings)
        const ambResult = await pool.query(
            'SELECT * FROM ambassadors WHERE unique_code = $1', 
            [req.session.ambassador.unique_code]
        );
        
        // Fetch the list of people they referred
        const referrals = await pool.query(
            'SELECT full_name, email, created_at FROM users WHERE referred_by_code = $1',
            [req.session.ambassador.unique_code]
        );

        res.render('ambassador-dashboard', {
            ambassador: ambResult.rows[0],
            referrals: referrals.rows
        });
    } catch (err) {
        res.send("Error loading dashboard.");
    }
});
// GET Admin Dashboard - See all Ambassadors
app.get('/admin/ambassadors', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ambassadors ORDER BY created_at DESC');
        res.render('admin-dashboard', { 
            ambassadors: result.rows,
            title: "Admin | Manage Ambassadors" 
        });
    } catch (err) {
        console.error("Admin Dashboard Error:", err);
        res.status(500).send("Error fetching ambassadors.");
    }
});

// POST Create Ambassador
app.post('/admin/add-ambassador', async (req, res) => {
    const { name, unique_code } = req.body;

    try {
        // Insert name and the code (which is their login/pass)
        await pool.query(
            'INSERT INTO ambassadors (name, unique_code) VALUES ($1, $2)',
            [name, unique_code]
        );
        
        console.log(`New Ambassador Created: ${name} (${unique_code})`);
        res.redirect('/admin/ambassadors?success=Ambassador added');
    } catch (err) {
        console.error("Error creating ambassador:", err);
        res.send("Error: That Unique Code might already be taken.");
    }
});

// POST Reset Payout after paying them
app.post('/admin/payout-complete/:id', async (req, res) => {
    const ambId = req.params.id;

    try {
        // Reset earned balance to 0 after payout
        await pool.query(
            'UPDATE ambassadors SET total_earned = 0 WHERE id = $1',
            [ambId]
        );
        
        res.redirect('/admin/ambassadors?msg=Payout recorded');
    } catch (err) {
        res.status(500).send("Error updating payout status.");
    }
});


app.listen(3000, () => console.log('Prepium running on http://localhost:3000'));
