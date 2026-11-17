'use strict';

// Shared, authoritative CGPA / GPA / degree-class calculation logic.
// Every academic calculation in Prepium (tracker, what-if builder, forecasts,
// AI-advisor context, transcript generation) MUST use this module so the same
// student record always produces the same values everywhere.

const GP_MAPS = {
    5: { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 },
    4: { A: 4, B: 3, C: 2, D: 1, E: 0, F: 0 }
};

const VALID_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'];

function normalizeScale(scale) {
    const s = parseInt(scale, 10);
    return s === 4 ? 4 : 5;
}

function gradePoint(grade, scale) {
    const s = normalizeScale(scale);
    const g = String(grade || 'F').trim().toUpperCase();
    const map = GP_MAPS[s];
    return Object.prototype.hasOwnProperty.call(map, g) ? map[g] : 0;
}

// Degree-class thresholds differ between the 5-point and 4-point systems.
function classifyDegree(cgpa, scale) {
    const s = normalizeScale(scale);
    const value = Number(cgpa) || 0;
    let degreeClass = 'Pass';
    let divBadge = 'none';
    if (s === 5) {
        if      (value >= 4.50) { degreeClass = 'First Class Honours';  divBadge = 'first'; }
        else if (value >= 3.50) { degreeClass = 'Second Class (Upper)'; divBadge = 'upper'; }
        else if (value >= 2.40) { degreeClass = 'Second Class (Lower)'; divBadge = 'lower'; }
        else if (value >= 1.50) { degreeClass = 'Third Class';          divBadge = 'third'; }
        else if (value >= 1.00) { degreeClass = 'Pass';                 divBadge = 'none';  }
        else                    { degreeClass = 'Fail';                 divBadge = 'fail';  }
    } else {
        if      (value >= 3.50) { degreeClass = 'First Class Honours';  divBadge = 'first'; }
        else if (value >= 3.00) { degreeClass = 'Second Class (Upper)'; divBadge = 'upper'; }
        else if (value >= 2.00) { degreeClass = 'Second Class (Lower)'; divBadge = 'lower'; }
        else if (value >= 1.50) { degreeClass = 'Third Class';          divBadge = 'third'; }
        else if (value >= 1.00) { degreeClass = 'Pass';                 divBadge = 'none';  }
        else                    { degreeClass = 'Fail';                 divBadge = 'fail';  }
    }
    return { degreeClass, divBadge };
}

// Validate + normalize a single course row. Returns null for unusable rows.
function normalizeCourse(c) {
    if (!c || typeof c !== 'object') return null;
    const grade = String(c.grade || '').trim().toUpperCase();
    const units = parseInt(c.credit_units, 10);
    return {
        course_code: String(c.course_code || c.code || '').trim(),
        title: String(c.title || '').trim(),
        grade: VALID_GRADES.includes(grade) ? grade : null,
        credit_units: Number.isFinite(units) && units > 0 ? units : 0,
        is_hidden: !!(c.is_hidden || c.excluded),
        level_scope: c.level_scope,
        semester: c.semester
    };
}

// Core cumulative calculation.
// opts = { scale, prevUnits, prevPoints, courses }
// Courses with is_hidden=true are excluded from totals (matching the
// existing tracker behaviour) but still reported in gradeCounts only when
// the caller passes includeHiddenInGrades.
function computeCGPA(opts) {
    const scale = normalizeScale(opts && opts.scale);
    const prevUnits  = Number(opts && opts.prevUnits)  || 0;
    const prevPoints = Number(opts && opts.prevPoints) || 0;

    let totalUnits  = Math.max(prevUnits, 0);
    let totalPoints = Math.max(prevPoints, 0);

    const gradeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    const courses = Array.isArray(opts && opts.courses) ? opts.courses : [];

    courses.forEach(raw => {
        const c = normalizeCourse(raw);
        if (!c) return;
        if (c.grade && Object.prototype.hasOwnProperty.call(gradeCounts, c.grade)) gradeCounts[c.grade]++;
        if (c.is_hidden) return; // hidden courses never affect totals
        const pt = c.grade ? gradePoint(c.grade, scale) : 0;
        totalUnits  += c.credit_units;
        totalPoints += pt * c.credit_units;
    });

    const cgpa = totalUnits > 0
        ? parseFloat((totalPoints / totalUnits).toFixed(2))
        : 0;

    const { degreeClass, divBadge } = classifyDegree(cgpa, scale);

    const arcPct    = Math.min(cgpa / scale, 1);
    const arcOffset = parseFloat((251.2 * (1 - arcPct)).toFixed(1));

    return {
        cgpa: cgpa.toFixed(2),
        cgpaNumber: cgpa,
        totalUnits,
        totalPoints,
        degreeClass,
        divBadge,
        gradeCounts,
        arcOffset,
        scale
    };
}

// Semester-by-semester breakdown used by transcript generation.
// Returns { semesters, totals } where totals is a computeCGPA() result.
function buildSemesterBreakdown(opts) {
    const scale = normalizeScale(opts && opts.scale);
    const prevUnits  = Number(opts && opts.prevUnits)  || 0;
    const prevPoints = Number(opts && opts.prevPoints) || 0;

    const semesterData = {};
    const courses = Array.isArray(opts && opts.courses) ? opts.courses : [];

    courses.forEach(c => {
        const key = `L${c.level_scope} S${c.semester}`;
        if (!semesterData[key]) {
            semesterData[key] = { level: c.level_scope, semester: c.semester, courses: [], units: 0, points: 0 };
        }
        const u = parseInt(c.credit_units, 10) || 0;
        const pts = gradePoint(c.grade, scale) * u;
        if (!c.is_hidden) {
            semesterData[key].units += u;
            semesterData[key].points += pts;
        }
        semesterData[key].courses.push({
            code: c.course_code || c.code,
            title: c.title,
            units: c.credit_units,
            grade: c.grade,
            excluded: !!c.is_hidden
        });
    });

    const semesters = Object.values(semesterData).sort((a, b) => (a.level - b.level) || (a.semester - b.semester));

    let totalPassed = 0;
    semesters.forEach(s => {
        s.courses.forEach(c => { if (c.grade && c.grade !== 'F' && !c.excluded) totalPassed++; });
    });

    const totals = computeCGPA({ scale, prevUnits, prevPoints, courses });

    return { semesters, totals, totalPassed };
}

// Forecast: CGPA if the given hypothetical courses were earned on top of the
// current record. Hypothetical courses NEVER mutate actual records — they are
// only fed through the same trusted math here.
function forecastCGPA(opts) {
    const base = computeCGPA(opts);
    const extra = Array.isArray(opts && opts.extraCourses) ? opts.extraCourses : [];
    const scale = normalizeScale(opts && opts.scale);

    let totalUnits  = base.totalUnits;
    let totalPoints = base.totalPoints;
    extra.forEach(raw => {
        const c = normalizeCourse(raw);
        if (!c || c.is_hidden) return;
        const pt = c.grade ? gradePoint(c.grade, scale) : 0;
        totalUnits  += c.credit_units;
        totalPoints += pt * c.credit_units;
    });

    const cgpa = totalUnits > 0 ? parseFloat((totalPoints / totalUnits).toFixed(2)) : 0;
    const { degreeClass, divBadge } = classifyDegree(cgpa, scale);
    return {
        cgpa: cgpa.toFixed(2),
        cgpaNumber: cgpa,
        totalUnits,
        totalPoints,
        degreeClass,
        divBadge,
        scale,
        baseline: base
    };
}

module.exports = {
    GP_MAPS,
    VALID_GRADES,
    normalizeScale,
    gradePoint,
    classifyDegree,
    normalizeCourse,
    computeCGPA,
    buildSemesterBreakdown,
    forecastCGPA
};
