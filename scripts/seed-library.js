// Seeds the course library structure for the University of Ibadan.
// Faculties and departments below follow the university's publicly documented
// academic structure. No course lists or documents are fabricated — courses
// and resources grow through community contribution and admin verification.
//
// Usage: node scripts/seed-library.js   (requires DATABASE_URL)

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const UI_STRUCTURE = {
    'Arts': [
        'Classics', 'Communication and Language Arts', 'English', 'European Studies',
        'French', 'History', 'Linguistics and African Languages', 'Music',
        'Philosophy', 'Religious Studies', 'Theatre Arts'
    ],
    'Science': [
        'Botany', 'Chemistry', 'Computer Science', 'Geology', 'Mathematics',
        'Microbiology', 'Physics', 'Statistics', 'Zoology'
    ],
    'Basic Medical Sciences': [
        'Anatomy', 'Biochemistry', 'Physiology', 'Nursing Science',
        'Oral Biology', 'Pharmacology and Therapeutics'
    ],
    'Clinical Sciences': [
        'Anaesthesia', 'Medicine', 'Obstetrics and Gynaecology', 'Paediatrics',
        'Pathology', 'Radiology', 'Surgery'
    ],
    'Agriculture and Forestry': [
        'Agricultural Economics', 'Agricultural Extension and Rural Development',
        'Agronomy', 'Animal Science', 'Crop Protection and Environmental Biology',
        'Forest Production and Products', 'Wildlife and Ecotourism Management'
    ],
    'Education': [
        'Adult Education', 'Educational Management', 'Guidance and Counselling',
        'Human Kinetics and Health Education', 'Library, Archival and Information Studies',
        'Science Education', 'Special Education'
    ],
    'Technology': [
        'Agricultural and Environmental Engineering', 'Civil Engineering',
        'Electrical and Electronics Engineering', 'Food Science and Technology',
        'Mechanical Engineering', 'Petroleum Engineering', 'Wood Products Engineering'
    ],
    'Social Sciences': [
        'Economics', 'Geography', 'Political Science', 'Psychology', 'Sociology'
    ],
    'Law': ['Public Law', 'Private Law'],
    'Pharmacy': ['Pharmaceutics', 'Pharmaceutical Chemistry', 'Pharmacognosy', 'Pharmacology and Toxicology'],
    'Veterinary Medicine': [
        'Veterinary Anatomy', 'Veterinary Medicine', 'Veterinary Microbiology and Parasitology',
        'Veterinary Pathology', 'Veterinary Pharmacology and Toxicology', 'Veterinary Public Health and Preventive Medicine',
        'Veterinary Surgery and Reproduction'
    ],
    'Renewable Natural Resources': [
        'Aquaculture and Fisheries Management', 'Forest Production and Products',
        'Social and Environmental Forestry', 'Wildlife and Ecotourism Management'
    ],
    'Public Health': ['Environmental Health Sciences', 'Epidemiology and Medical Statistics', 'Health Policy and Management', 'Health Promotion and Education'],
    'Dentistry': ['Child Oral Health', 'Oral and Maxillofacial Surgery', 'Preventive Dentistry', 'Restorative Dentistry'],
    'Multidisciplinary Studies': ['Economics', 'Mass Communication', 'Political Science']
};

const UI_SLUG = 'university-of-ibadan';

(async () => {
    try {
        const uni = await pool.query('SELECT id FROM universities WHERE slug = $1', [UI_SLUG]);
        let uniId;
        if (uni.rows[0]) {
            uniId = uni.rows[0].id;
        } else {
            const ins = await pool.query(
                "INSERT INTO universities (name, slug, is_paid, price) VALUES ('University of Ibadan', $1, false, 2000) RETURNING id",
                [UI_SLUG]
            );
            uniId = ins.rows[0].id;
        }

        let facCount = 0, depCount = 0;
        for (const [facultyName, departments] of Object.entries(UI_STRUCTURE)) {
            const fSlug = slug(facultyName);
            const f = await pool.query(
                'INSERT INTO library_faculties (university_id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (university_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id',
                [uniId, facultyName, fSlug]
            );
            facCount++;
            const facId = f.rows[0].id;
            for (const depName of departments) {
                await pool.query(
                    'INSERT INTO library_departments (faculty_id, university_id, name, slug) VALUES ($1,$2,$3,$4) ON CONFLICT (faculty_id, slug) DO UPDATE SET name = EXCLUDED.name',
                    [facId, uniId, depName, slug(depName)]
                );
                depCount++;
            }
        }
        console.log(`[Library seed] University of Ibadan: ${facCount} faculties, ${depCount} departments ready.`);
    } catch (err) {
        console.error('[Library seed] failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
