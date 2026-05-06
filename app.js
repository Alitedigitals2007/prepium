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
app.use(express.json());
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
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
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
app.get('/login', (req, res) => res.render('login'));


app.post('/auth/signup', async (req, res) => {
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


app.post('/dashboard/verify-payment', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const userEmail = req.session.user.email;

    try {
        // 1. Fetch user status and their ambassador code
        const userQuery = await pool.query(
            'SELECT unique_code, has_paid FROM users WHERE email = $1', 
            [userEmail]
        );

        if (userQuery.rows.length === 0) {
            return res.send("User profile not found.");
        }

        const user = userQuery.rows[0];

        // Exit if user has already activated to prevent double charging/crediting
        if (user.has_paid === true) {
            return res.send("Your account has already been activated.");
        }

        // 2. Activate the user's account status
        await pool.query('UPDATE users SET has_paid = true WHERE email = $1', [userEmail]);
        console.log(`[Database] Success: User ${userEmail} marked as paid.`);

        // 3. Process Ambassador credit if a code exists
        if (user.unique_code) {
            const codeClean = user.unique_code.trim().toLowerCase();
            console.log(`[Lookup] Attempting to match code: "${codeClean}"`);

            const ambCheck = await pool.query(
                'SELECT id, name FROM ambassadors WHERE LOWER(TRIM(unique_code)) = $1',
                [codeClean]
            );

            if (ambCheck.rows.length > 0) {
                const ambassador = ambCheck.rows[0];
                console.log(`[Match Found] Adding ₦150 to Ambassador: ${ambassador.name}`);

                // Force casting inside the SQL math operation
                const updateResult = await pool.query(
                    `UPDATE ambassadors 
                     SET total_earned = CAST(COALESCE(total_earned, 0) AS INTEGER) + 150, 
                         total_referrals = CAST(COALESCE(total_referrals, 0) AS INTEGER) + 1 
                     WHERE id = $1 
                     RETURNING total_earned, total_referrals`,
                    [ambassador.id]
                );

                console.log('[System Output] New Dashboard Stats:', updateResult.rows[0]);
            } else {
                console.log(`[No Ambassador Found] The code "${codeClean}" did not match any unique_code.`);
            }
        }

        req.session.user.has_paid = true;
        res.redirect('/dashboard?msg=Account activated successfully!');

    } catch (err) {
        console.error("Payment Processing Error:", err);
        res.status(500).send("Database error occurred.");
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

    if (!req.session.user) {
        return res.redirect('/login');
    }

    const userId = req.session.user.id;

    try {
        // 1. Fetch user data to see their unique code and current status before updating
        const userQuery = await pool.query(
            'SELECT unique_code, has_paid FROM users WHERE id = $1', 
            [userId]
        );

        if (userQuery.rows.length === 0) {
            return res.redirect('/dashboard?payment=failed&reason=user_not_found');
        }

        const user = userQuery.rows[0];

        // 2. Prevent double-crediting if they are already activated
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
        const userId = req.session.user.id;
        
        // 1. Updated: Get user info JOINED with university data
        const userRes = await pool.query(
            `SELECT u.fullname, u.email, u.has_paid, uni.name as university_name 
             FROM users u 
             LEFT JOIN universities uni ON u.university_id = uni.id 
             WHERE u.id = $1`, 
            [userId]
        );
        const user = userRes.rows[0];

        // 2. Get Stats from quiz_results
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
app.get('/admin/subjects/delete/:id', isAdmin, async (req, res) => {
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

// VIEW QUESTIONS PAGE (Now identifies the school in the header)
app.get('/admin/questions/manage/:subject_id', isAdmin, async (req, res) => {
    const { subject_id } = req.params;
    try {
        const subject = await pool.query(`
            SELECT subjects.*, universities.name as university_name 
            FROM subjects 
            JOIN universities ON subjects.university_id = universities.id 
            WHERE subjects.id = $1`, [subject_id]);
            
        const questions = await pool.query('SELECT * FROM questions WHERE subject_id = $1 ORDER BY id DESC', [subject_id]);
        res.render('admin/manage-questions', { subject: subject.rows[0], questions: questions.rows });
    } catch (err) {
        res.redirect('/admin/subjects');
    }
});

// BULK IMPORT (JSON)
app.post('/admin/questions/bulk-import', isAdmin, async (req, res) => {
    const { subject_id, json_data } = req.body;
    try {
        const data = JSON.parse(json_data); 
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
        res.status(400).send("Invalid JSON Format.");
    }
});

// DELETE QUESTION
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

// ==========================================
// 4. API FOR THE STUDENT APP
// ==========================================

// JSON API for getting subjects based on student's university
app.get('/api/subjects', async (req, res) => {
    try {
        // Assume user object has university_id from signup
        const userUni = req.user.university_id; 
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
            // Combines session info with database status including quiz_attempts
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

app.get('/subjects', isStudent, async (req, res) => {
    try {
        const universityId = req.session.user.university_id;

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

        res.render('subjects-library', {
            user: req.session.user,
            subjects: result.rows
        });
    } catch (err) {
        console.error("Subjects Library Error:", err.message);
        res.status(500).send("Error loading study library.");
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
                message: "You've used up your 2 free quiz attempts. Upgrade to Prepium Pro for unlimited practice tests!"
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
                message: "You've used up your 2 free quiz attempts. Upgrade to Prepium Pro for unlimited practice tests!"
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

        // --- SAVE TO DATABASE & INCREMENT TRIAL ATTEMPT COUNTER ---
        try {
            // 1. Insert the exam history record
            await pool.query(
                `INSERT INTO quiz_results (user_id, subject_id, score, total_questions, percentage, time_taken, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [userId, subjectId, score, totalQuestions, percentage, timeUsed]
            );

            // 2. Increment quiz_attempts ONLY for users who have not paid
            await pool.query(
                `UPDATE users 
                 SET quiz_attempts = quiz_attempts + 1 
                 WHERE id = $1 AND has_paid = false`,
                [userId]
            );

        } catch (dbErr) {
            console.error("Database Save Error:", dbErr);
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
    if (!req.session.admin) return res.redirect('/admin/login'); // Ensure admin is logged in

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
app.post('/admin/add-ambassador', async (req, res) => {
    if (!req.session.admin) return res.redirect('/admin/login');

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
app.post('/admin/payout-complete/:id', async (req, res) => {
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
    // If admin is already logged in, redirect directly to the ambassadors list
    if (req.session.admin) {
        return res.redirect('/admin/ambassadors');
    }
    res.render('admin-login', { error: null });
});

// POST: Process Admin Login Credentials
app.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const adminEmail = process.env.ADMIN_EMAIL || "admin@gmail.com";
        const adminPassword = process.env.ADMIN_PASSWORD || "ayomide2007";

        if (email === adminEmail && password === adminPassword) {
            // Set session variable
            req.session.admin = { email: adminEmail };
            
            // Save session explicitly and redirect to the ambassador page
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
    req.session.admin = null;
    req.session.save(() => {
        res.redirect('/admin/login?msg=Logged out successfully');
    });
});

app.get('/competition', (req, res) => {
    // If you want to check if the user is logged in first:
    const user = req.session.user || null;
    res.render('competition', { user });
});

// GET: View student deadlines
app.get('/deadlines', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    // Safety check: Lock feature if basic user hasn't paid
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
app.post('/deadlines/add', async (req, res) => {
    if (!req.session.user || !req.session.user.has_paid) {
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
app.post('/deadlines/delete/:id', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        await pool.query(
            'DELETE FROM deadlines WHERE id = $1 AND user_id = $2', 
            [req.params.id, req.session.user.id]
        );
        res.redirect('/deadlines');
    } catch (err) {
        console.error("Error deleting deadline:", err);
        res.redirect('/deadlines?error=Failed to delete deadline');
    }
});

// GET: Render the Pomodoro Timer page
app.get('/pomodoro', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    // Check if the student has paid for premium access
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard?msg=Upgrade to access the Pomodoro Timer');
    }

    res.render('pomodoro', { 
        user: req.session.user,
        hasNewNotifs: req.session.hasNewNotifs || false 
    });
});

// GET: Render the Timetable page with stored data
app.get('/timetable', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (!req.session.user.has_paid) {
        return res.redirect('/dashboard?msg=Upgrade to access the Day Planner');
    }

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
app.post('/timetable/add', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { course, day, start_time, end_time, venue } = req.body;
    
    try {
        await pool.query(
            'INSERT INTO timetables (user_id, course, day, start_time, end_time, venue) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.session.user.id, course, day, start_time, end_time, venue]
        );
        res.redirect('/timetable');
    } catch (err) {
        console.error(err);
        res.redirect('/timetable?error=Failed to add slot');
    }
});

// GET: Render the How It Works Guide
app.get('/how-it-works', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    res.render('how-it-works', { 
        user: req.session.user,
        hasNewNotifs: req.session.hasNewNotifs || false 
    });
});

// ==========================================
// USER CHAT ROUTES
// ==========================================

// GET: View all threads & chat interface
app.get('/suggestions', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
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
app.post('/suggestions/new', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
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
app.post('/suggestions/reply', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
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
app.get('/admin/suggestions', async (req, res) => {
    if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
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
app.post('/admin/suggestions/reply', async (req, res) => {
    if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
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
app.post('/admin/suggestions/status', async (req, res) => {
    if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
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

app.listen(3000, () => console.log('Prepium running on http://localhost:3000'));
