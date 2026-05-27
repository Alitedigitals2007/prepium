'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Simple file-based store (swap for DB in production) ─────
const DB_FILE = path.join(__dirname, 'data', 'db.json');

function readDB() {
    if (!fs.existsSync(DB_FILE)) return { profiles: {}, courses: {} };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Demo user (replace with real auth in production) ────────
const DEMO_USER = {
    id:         'user-001',
    name:       'Demo Student',
    department: 'Computer Science',
};

function getUser(req) { return DEMO_USER; }

// ── Helpers ─────────────────────────────────────────────────
function getProfile(userId) {
    const db = readDB();
    return db.profiles[userId] || null;
}

function getCourses(userId) {
    const db = readDB();
    return (db.courses[userId] || []).filter(c => !c.deleted);
}

// ── Routes ───────────────────────────────────────────────────

// Root → redirect to tracker
app.get('/', (req, res) => res.redirect('/cgpa'));

// Dashboard stub
app.get('/dashboard', (req, res) => {
    const user    = getUser(req);
    const profile = getProfile(user.id);
    const courses = getCourses(user.id);
    res.render('cgpa', { user, profile, courses, hasProfile: !!profile, page: 'dashboard' });
});

// ── CGPA Tracker ─────────────────────────────────────────────
app.get('/cgpa', (req, res) => {
    const user    = getUser(req);
    const profile = getProfile(user.id);
    const courses = getCourses(user.id);
    res.render('cgpa', { user, profile, courses, hasProfile: !!profile, page: 'cgpa' });
});

// Setup profile
app.post('/cgpa/setup', (req, res) => {
    const user = getUser(req);
    const db   = readDB();

    const {
        start_type,
        department,
        current_level,
        grading_scale,
        initial_cgpa,
        initial_units,
        initial_passed,
        initial_pending,
    } = req.body;

    db.profiles[user.id] = {
        department:      department || 'General Studies',
        current_level:   parseInt(current_level)  || 100,
        grading_scale:   parseInt(grading_scale)  || 5,
        start_type:      start_type || 'fresh',
        initial_cgpa:    parseFloat(initial_cgpa)   || 0,
        initial_units:   parseInt(initial_units)    || 0,
        initial_passed:  parseInt(initial_passed)   || 0,
        initial_pending: parseInt(initial_pending)  || 0,
        created_at:      new Date().toISOString(),
    };

    if (!db.courses[user.id]) db.courses[user.id] = [];
    writeDB(db);
    res.redirect('/cgpa');
});

// Reset profile
app.post('/cgpa/reset', (req, res) => {
    const user = getUser(req);
    const db   = readDB();
    delete db.profiles[user.id];
    db.courses[user.id] = [];
    writeDB(db);
    res.redirect('/cgpa');
});

// Add course
app.post('/cgpa/course/add', (req, res) => {
    const user    = getUser(req);
    const db      = readDB();
    if (!db.courses[user.id]) db.courses[user.id] = [];

    const {
        course_code,
        units,
        grade_point,
        level,
        semester,
        is_clearing_pending,
    } = req.body;

    db.courses[user.id].push({
        id:                  uuidv4(),
        course_code:         (course_code || '').toUpperCase().trim(),
        units:               parseInt(units) || 1,
        grade_point:         parseInt(grade_point),
        level:               parseInt(level)    || 100,
        semester:            parseInt(semester)  || 1,
        is_clearing_pending: is_clearing_pending === 'true',
        is_hidden:           false,
        deleted:             false,
        created_at:          new Date().toISOString(),
    });

    writeDB(db);
    res.redirect('/cgpa');
});

// Toggle visibility (hide/unhide)
app.post('/cgpa/course/toggle/:id', (req, res) => {
    const user = getUser(req);
    const db   = readDB();
    const list = db.courses[user.id] || [];
    const course = list.find(c => c.id === req.params.id);
    if (course) course.is_hidden = !course.is_hidden;
    writeDB(db);
    res.redirect('/cgpa');
});

// Delete course
app.post('/cgpa/course/delete/:id', (req, res) => {
    const user = getUser(req);
    const db   = readDB();
    const list = db.courses[user.id] || [];
    const course = list.find(c => c.id === req.params.id);
    if (course) course.deleted = true;
    writeDB(db);
    res.redirect('/cgpa');
});

// ── CSV Export ───────────────────────────────────────────────
app.get('/cgpa/export/csv', (req, res) => {
    const user    = getUser(req);
    const profile = getProfile(user.id);
    const courses = getCourses(user.id);

    if (!profile) return res.redirect('/cgpa');

    // Build CSV
    const scale = profile.grading_scale;

    function gradeLetter(gp) {
        if (gp === scale)     return 'A';
        if (gp === scale - 1) return 'B';
        if (gp === scale - 2) return 'C';
        if (gp === scale - 3) return 'D';
        if (scale === 5 && gp === 1) return 'E';
        return 'F';
    }

    // Compute global CGPA
    let totalQP = 0, totalReg = 0, totalPassed = 0, totalPending = 0;

    if (profile.start_type === 'existing') {
        totalReg     += profile.initial_units   || 0;
        totalPassed  += profile.initial_passed  || 0;
        totalPending += profile.initial_pending || 0;
        totalQP      += (profile.initial_cgpa || 0) * (profile.initial_units || 0);
    }

    courses.forEach(c => {
        if (c.is_hidden) return;
        const units = c.units, gp = c.grade_point;
        if (c.is_clearing_pending) {
            totalQP += units * gp;
            if (gp > 0) { totalPassed += units; totalPending -= units; }
        } else {
            totalReg += units; totalQP += units * gp;
            if (gp > 0) totalPassed += units; else totalPending += units;
        }
    });
    if (totalPending < 0) totalPending = 0;

    const cgpa    = totalReg > 0 ? (totalQP / totalReg).toFixed(2) : '0.00';

    const rows = [
        ['PREPIUM CGPA TRANSCRIPT'],
        [`Student: ${user.name}`, `Department: ${profile.department}`, `Level: ${profile.current_level}L`],
        [`Scale: ${scale}-Point`, `CGPA: ${cgpa}`, `Registered: ${totalReg}`, `Passed: ${totalPassed}`, `Pending: ${totalPending}`],
        [],
        ['Level', 'Semester', 'Course Code', 'Units', 'Grade', 'Grade Point', 'Quality Points', 'Type', 'Visible'],
    ];

    // Group by level + semester
    const visible = courses.filter(c => !c.deleted);
    visible.forEach(c => {
        rows.push([
            c.level + 'L',
            c.semester === 1 ? '1st Sem' : '2nd Sem',
            c.course_code,
            c.units,
            gradeLetter(c.grade_point),
            c.grade_point,
            c.units * c.grade_point,
            c.is_clearing_pending ? 'Clearing' : 'Regular',
            c.is_hidden ? 'Hidden' : 'Visible',
        ]);
    });

    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="prepium-transcript-${Date.now()}.csv"`);
    res.send(csv);
});

// Stub routes so nav links don't 404
app.get('/history',    (req, res) => res.redirect('/cgpa'));
app.get('/setup-test', (req, res) => res.redirect('/cgpa'));
app.get('/profile',    (req, res) => res.redirect('/cgpa'));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Prepium running → http://localhost:${PORT}`));
