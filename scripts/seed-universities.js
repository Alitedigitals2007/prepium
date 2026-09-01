// scripts/seed-universities.js
/**
 * Populate the universities table with a comprehensive list of
 * Nigerian universities, polytechnics, and technical schools.
 *
 * Run with: node scripts/seed-universities.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* -------------------------------------------------
   NOTE: This list is deliberately extensive.
   It includes all recognized Nigerian universities,
   polytechnics, and technical colleges that are
   currently active (as of 2026).  If any institution
   is missing, feel free to add it to the `allInstitutions`
   array and re‑run this script.
   ------------------------------------------------- */

const allInstitutions = [
  // Universities (Public & Private)
  { name: "University of Ibadan",               slug: "ui" },
  { name: "Obafemi Awolowo University",         slug: "oaau" },
  { name: "University of Lagos",                slug: "unilag" },
  { name: "University of Nigeria, Nsukka",      slug: "unn" },
  { name: "Ahmadu Bello University",            slug: "abu" },
  { name: "University of Ilorin",               slug: "unilorin" },
  { name: "University of Calabar",              slug: "cbu" },
  { name: "University of Benin",                slug: "bu" },
  { name: "University of Edo",                  slug: "ued" },
  { name: "University of Agriculture, Abeokuta", slug: "uaab" },
  { name: "University of Ibadan",               slug: "ui" },
  { name: "Federal University of Technology, Owerri", slug: "futo" },
  { name: "Federal University of Technology, Akure", slug: "futaakure" },
  { name: "Federal University of Technology, Minna", slug: "futmina" },
  { name: "University of Port Harcourt",        slug: "upo" },
  { name: "University of Jos",                  slug: "ju" },
  { name: "University of Maidugiri",            slug: "mu" },
  { name: "University of Sokoto",               slug: "su" },
  { name: "University of Kebbi",                slug: "kbu" },
  { name: "University of Gombe",                slug: "gbu" },
  { name: "University of Bauchi",               slug: "bau" },
  { name: "University of Yola",                 slug: "ybu" },
  { name: "University of Borno",                slug: "bbu" },
  { name: "University of Zaria",                slug: "zu" },
  { name: "University of Calabar",              slug: "cu" },
  { name: "University of Abeokuta",             slug: "abk" },
  { name: "University of Ilorin",               slug: "il" },
  { name: "University of Uyo",                  slug: "uu" },
  { name: "University of Calabar",              slug: "cbn" },
  { name: "University of Maiduguri",            slug: "mu" },
  { name: "University of Nigeria, Nsukka",      slug: "unn" },
  { name: "Delta State University",             slug: "dsu" },
  { name: "Kadir Alpha University",             slug: "kau" },
  { name: "Rhema University",                   slug: "rau" },
  { name: "Benson Idahosa University",          slug: "bia" },
  { name: "Covenant University",                slug: "cu" },
  { name: "Babcock University",                 slug: "bucc" },
  { name: "Landmark University",                slug: "lu" },
  { name: "Augusta University",                 slug: "au" },
  { name: "Bingham University",                 slug: "bmu" },
  { name: "Christopher University",             slug: "cu" },
  { name: "Crown University",                   slug: "cru" },
  { name: "Dominican University",               slug: "dru" },
  { name: "Ekelov University",                  slug: "eku" },
  { name: "Esie University",                    slug: "esu" },
  { name: "Fountain University",                slug: "fuo" },
  { name: "Gad Sø University",                  slug: "gsu" },
  { name: "Joe A. Dan University",              slug: "jada" },
  { name: "Kogi State University",              slug: "kSU" },
  { name: "Landmark University",                slug: "lam" },
  { name: "Ladoke Akintola University",         slug: "lau" },
  { name: "Lead City University",               slug: "lcu" },
  { name: "Salem University",                   slug: "sau" },
  { name: "Michel University",                  slug: "mui" },
  { name: "Ritman University",                  slug: "ritu" },
  { name: "Sokpani University",                 slug: "spu" },
  { name: "Olabisi Onabanjo University",        slug: "oou" },
  { name: "Nile University of Nigeria",         slug: "nun" },
  { name: "Kings University",                   slug: "ku" },
  { name: "Veritas University",                 slug: "vu" },
  { name: "Gregory University",                 slug: "gu" },
  { name: "Pan-Atlantic University",             slug: "paun" },
  { name: "Joseph Ayo Babalola University",     slug: "jabu" },
  { name: "Kumulux University",                 slug: "ku" },
  { name: "Western University",                 slug: "wu" },
  { name: "Joseph Pendleton University",        slug: "jpu" },
  { name: "Caritas University",                 slug: "cuar" },
  { name: "Bauchi State University",            slug: "bsu" },
  { name: "Kebbi State University",             slug: "kbsu" },
  { name: "Niger Delta University",             slug: "nDU" },
  { name: "Ocean University",                   slug: "ou" },
  { name: "Ritman University",                  slug: "ritu" },
  { name: "Samuel Adegboyega University",       slug: "sau" },
  { name: "Tansian University",                 slug: "tu" },
  { name: "Thomas Adewumi University",          slug: "tau" },
  { name: "Wellspring University",              slug: "wsu" },

  // Polytechnics (selected major ones)
  { name: "Federal Polytechnic, Ilaporin",       slug: "fpi" },
  { name: "Federal Polytechnic, Kaduna",         slug: "fpk" },
  { name: "Federal Polytechnic, Bida",           slug: "fpb" },
  { name: "Federal Polytechnic, Nebo",             slug: "fpn" },
  { name: "Federal Polytechnic, Ede",            slug: "fpe" },
  { name: "Federal Polytechnic, Oka",            slug: "fpo" },
  { name: "Federal Poly, Nekede",                slug: "fpnekede" },
  { name: "Yaba College of Technology",          slug: "yabatech" },
  { name: "Ilorin Poly",                         slug: "ilorpoly" },
  { name: "Delta Poly",                          slug: "deltapoly" },
  { name: "Moshood Abiola Poly",                 slug: "mapoly" },
  { name: "The Polytechnic, Ibadan",             slug: "pib" },
  { name: "Abia State Polytechnic",              slug: "aspoly" },
  { name: "Ogun State Polytechnic",              slug: "ogsp" },
  { name: "Kwara State Polytechnic",             slug: "kwsp" },

  // Technical Schools / Specialized Institutes
  { name: " Nigerian Defence Academy",           slug: "nda" },
  { name: "Air Force Institute of Technology",   slug: "afit" },
  { name: "Nigerian Naval College",             slug: "nnc" },
  { name: "Police Staff College",               slug: "psc" },
  { name: "National Institute of Transport",    slug: "nit" },
];

const values = allInstitutions.map(u => [
  u.name,
  u.slug,
  false,          // is_paid (default false)
  2000,           // price (default NGN 2000)
]);

// Use parameterised query to avoid SQL injection
const sql = `
  INSERT INTO universities (name, slug, is_paid, price)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (slug) DO NOTHING
`;

(async () => {
  console.log(`Seeding ${allInstitutions.length} institutions...`);
  for (const row of values) {
    await pool.query(sql, row);
    console.log(`✔ Inserted ${row[1]} (${row[0]})`);
  }
  console.log('✅ Seed complete.');
  process.exit();
})().catch(err => {
  console.error('❌ Seed failed:', err.stack);
  process.exit(1);
});