'use strict';

// Regression tests for the shared CGPA module (lib/cgpa.js) and the XP ledger
// (lib/xp.js). Run with: node tests/run.js
// No database required — XP tests use an in-memory mock pool.

const assert = require('assert');
const cgpa = require('../lib/cgpa');
const xp = require('../lib/xp');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  \u2713 ' + name);
    } catch (err) {
        failed++;
        console.error('  \u2717 ' + name);
        console.error('    ' + err.message);
    }
}

// ---- Shared student record used across tracker / forecast / transcript ----
const RECORD = {
    scale: 5,
    prevUnits: 20,
    prevPoints: 78, // 3.90 carried in
    courses: [
        { course_code: 'CSC201', title: 'Computer Programming I', credit_units: 3, grade: 'A', level_scope: 200, semester: 1 },
        { course_code: 'MTH205', title: 'Linear Algebra', credit_units: 3, grade: 'B', level_scope: 200, semester: 1 },
        { course_code: 'GST203', title: 'Peace Studies', credit_units: 2, grade: 'C', level_scope: 200, semester: 1 },
        { course_code: 'CSC205', title: 'Discrete Structures', credit_units: 3, grade: 'D', level_scope: 200, semester: 2, is_hidden: true }, // excluded
        { course_code: 'CSC301', title: 'Data Structures', credit_units: 4, grade: 'F', level_scope: 300, semester: 1 }
    ]
};
// Expected: units 20 + 3 + 3 + 2 + 4 = 32 (hidden excluded)
// points: 78 + 15 + 12 + 6 + 0 = 111 -> 111/32 = 3.46875 -> 3.47

console.log('\nlib/cgpa.js');

test('computeCGPA matches hand-computed value for the shared record', () => {
    const r = cgpa.computeCGPA(RECORD);
    assert.strictEqual(r.cgpa, '3.47');
    assert.strictEqual(r.totalUnits, 32);
    assert.strictEqual(r.totalPoints, 111);
});

test('hidden courses are excluded from totals but counted in gradeCounts', () => {
    const r = cgpa.computeCGPA(RECORD);
    assert.strictEqual(r.gradeCounts.D, 1); // the hidden D course is still counted as a grade
    assert.strictEqual(r.gradeCounts.F, 1);
    assert.strictEqual(r.totalUnits, 32);   // ...but its units are NOT in the total
});

test('tracker, transcript and forecast agree for the same record', () => {
    const tracker = cgpa.computeCGPA(RECORD);
    const transcript = cgpa.buildSemesterBreakdown(RECORD);
    assert.strictEqual(tracker.cgpa, transcript.totals.cgpa);
    assert.strictEqual(tracker.totalUnits, transcript.totals.totalUnits);
    assert.strictEqual(tracker.degreeClass, transcript.totals.degreeClass);

    // Forecast with zero extra courses must equal the base exactly
    const forecast = cgpa.forecastCGPA({ ...RECORD, extraCourses: [] });
    assert.strictEqual(forecast.cgpa, tracker.cgpa);
    assert.strictEqual(forecast.totalUnits, tracker.totalUnits);
});

test('forecast with hypothetical courses does not change the base record', () => {
    const base = cgpa.computeCGPA(RECORD);
    const forecast = cgpa.forecastCGPA({
        ...RECORD,
        extraCourses: [{ grade: 'A', credit_units: 3 }, { grade: 'A', credit_units: 3 }]
    });
    assert.strictEqual(base.totalUnits, 32);          // base untouched
    assert.strictEqual(forecast.totalUnits, 38);      // +6 hypothetical units
    assert.strictEqual(forecast.cgpa, ((111 + 30) / 38).toFixed(2)); // 141/38 = 3.71
});

test('both 4-point and 5-point scales are supported', () => {
    const five = cgpa.computeCGPA({ scale: 5, prevUnits: 0, prevPoints: 0, courses: [{ grade: 'A', credit_units: 3 }] });
    const four = cgpa.computeCGPA({ scale: 4, prevUnits: 0, prevPoints: 0, courses: [{ grade: 'A', credit_units: 3 }] });
    assert.strictEqual(five.cgpa, '5.00');
    assert.strictEqual(four.cgpa, '4.00');
    assert.strictEqual(five.degreeClass, 'First Class Honours');
    assert.strictEqual(four.degreeClass, 'First Class Honours');
});

test('4-point scale B gives 3.00 (not 4.00)', () => {
    const four = cgpa.computeCGPA({ scale: 4, prevUnits: 0, prevPoints: 0, courses: [{ grade: 'B', credit_units: 3 }] });
    assert.strictEqual(four.cgpa, '3.00');
});

test('degree classification boundaries (5-point)', () => {
    assert.strictEqual(cgpa.classifyDegree(4.50, 5).degreeClass, 'First Class Honours');
    assert.strictEqual(cgpa.classifyDegree(4.49, 5).degreeClass, 'Second Class (Upper)');
    assert.strictEqual(cgpa.classifyDegree(3.50, 5).degreeClass, 'Second Class (Upper)');
    assert.strictEqual(cgpa.classifyDegree(2.40, 5).degreeClass, 'Second Class (Lower)');
    assert.strictEqual(cgpa.classifyDegree(1.50, 5).degreeClass, 'Third Class');
    assert.strictEqual(cgpa.classifyDegree(1.00, 5).degreeClass, 'Pass');
    assert.strictEqual(cgpa.classifyDegree(0.90, 5).degreeClass, 'Fail');
});

test('degree classification boundaries (4-point)', () => {
    assert.strictEqual(cgpa.classifyDegree(3.50, 4).degreeClass, 'First Class Honours');
    assert.strictEqual(cgpa.classifyDegree(3.00, 4).degreeClass, 'Second Class (Upper)');
    assert.strictEqual(cgpa.classifyDegree(2.00, 4).degreeClass, 'Second Class (Lower)');
    assert.strictEqual(cgpa.classifyDegree(1.50, 4).degreeClass, 'Third Class');
    assert.strictEqual(cgpa.classifyDegree(0.50, 4).degreeClass, 'Fail');
});

test('missing, invalid and zero-credit data is handled safely', () => {
    const r = cgpa.computeCGPA({
        scale: 5,
        prevUnits: 0,
        prevPoints: 0,
        courses: [
            null,
            { grade: 'A', credit_units: 0 },        // zero units -> no effect
            { grade: 'X', credit_units: 3 },        // invalid grade -> F equivalent
            { credit_units: 3 },                    // missing grade -> F equivalent
            'garbage'
        ]
    });
    assert.strictEqual(r.totalUnits, 6);
    assert.strictEqual(r.totalPoints, 0);
    assert.strictEqual(r.cgpa, '0.00');
    assert.strictEqual(r.degreeClass, 'Fail');
});

test('empty record gives 0.00 without crashing', () => {
    const r = cgpa.computeCGPA({ scale: 5, prevUnits: 0, prevPoints: 0, courses: [] });
    assert.strictEqual(r.cgpa, '0.00');
    assert.strictEqual(r.totalUnits, 0);
});

test('transcript semester grouping and passed-course count', () => {
    const t = cgpa.buildSemesterBreakdown(RECORD);
    assert.strictEqual(t.semesters.length, 3); // L200S1, L200S2, L300S1
    assert.strictEqual(t.semesters[0].level, 200);
    assert.strictEqual(t.semesters[0].semester, 1);
    // Passed = non-F, non-hidden: A, B, C = 3
    assert.strictEqual(t.totalPassed, 3);
});

test('arcOffset is consistent with cgpa (SVG ring)', () => {
    const r = cgpa.computeCGPA(RECORD);
    const pct = Math.min(parseFloat(r.cgpa) / r.scale, 1);
    assert.strictEqual(r.arcOffset, parseFloat((251.2 * (1 - pct)).toFixed(1)));
});

console.log('\nlib/xp.js (mock pool)');

function mockPool() {
    const ledger = [];
    const users = new Map([[1, { xp: 0 }]]);
    return {
        ledger,
        users,
        async query(sql, params) {
            if (sql.includes('INSERT INTO xp_ledger')) {
                const [userId, amount, sourceType, sourceRef] = params;
                const key = sourceType + '|' + (sourceRef || '');
                if (ledger.some(l => l.key === key)) {
                    const err = new Error('duplicate key'); err.code = '23505'; throw err;
                }
                ledger.push({ key, userId, amount, sourceType, sourceRef });
                return { rows: [] };
            }
            if (sql.includes('UPDATE users SET xp')) {
                const [delta, userId] = params;
                const u = users.get(userId);
                u.xp = Math.max(0, u.xp + delta);
                return { rows: [{ xp: u.xp }] };
            }
            if (sql.includes('SELECT COALESCE(xp, 0)')) {
                const u = users.get(params[0]) || { xp: 0 };
                return { rows: [{ xp: u.xp }] };
            }
            if (sql.includes('SELECT COALESCE(SUM(amount), 0)')) {
                const total = ledger.filter(l => l.userId === params[0]).reduce((s, l) => s + l.amount, 0);
                return { rows: [{ total: String(total) }] };
            }
            if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { rows: [] };
            throw new Error('Unexpected SQL in mock: ' + sql.slice(0, 60));
        }
    };
}

(async () => {
    const pool = mockPool();

    await test('awardXP records the ledger row and syncs users.xp', async () => {
        const r = await xp.awardXP(pool, 1, 40, 'daily_challenge', 'attempt_9', 'Daily Challenge: 8/15');
        assert.strictEqual(r.awarded, true);
        assert.strictEqual(r.balance, 40);
        assert.strictEqual(pool.ledger.length, 1);
    });

    await test('duplicate event is rejected (no double XP)', async () => {
        const r = await xp.awardXP(pool, 1, 40, 'daily_challenge', 'attempt_9', 'Daily Challenge: 8/15');
        assert.strictEqual(r.awarded, false);
        assert.strictEqual(r.reason, 'duplicate');
        assert.strictEqual(pool.ledger.length, 1);      // no new row
        assert.strictEqual(pool.users.get(1).xp, 40);   // balance unchanged
    });

    await test('same user, different event, awards normally', async () => {
        const r = await xp.awardXP(pool, 1, 100, 'challenge', 'challenge_1_user_1', 'Weekly Warm-up');
        assert.strictEqual(r.awarded, true);
        assert.strictEqual(r.balance, 140);
    });

    await test('same event ref for a different user is allowed', async () => {
        const r = await xp.awardXP(pool, 2, 100, 'challenge', 'challenge_1_user_1', 'Weekly Warm-up');
        assert.strictEqual(r.awarded, true);
    });

    await test('zero/negative amounts are refused', async () => {
        const r0 = await xp.awardXP(pool, 1, 0, 'test', null, '');
        const rn = await xp.awardXP(pool, 1, -5, 'test', null, '');
        assert.strictEqual(r0.awarded, false);
        assert.strictEqual(rn.awarded, false);
    });

    await test('getXPBalance reads the synced balance', async () => {
        assert.strictEqual(await xp.getXPBalance(pool, 1), 140);
    });

    console.log('\napp.js smoke');

    await test('app.js module loads without throwing (routes register cleanly)', async () => {
        // Requiring app.js registers every route; a duplicate route/middleware
        // or syntax problem would throw here. DB-dependent init blocks catch
        // their own errors, so no database is needed for this check.
        process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
        const appPath = require.resolve('../app.js');
        delete require.cache[appPath];
        const loaded = require('../app.js');
        assert.ok(loaded, 'app.js should export the express app');
    });

    console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
