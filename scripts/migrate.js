#!/usr/bin/env node
'use strict';

// Version-controlled database migration runner.
// Usage: node scripts/migrate.js        (apply pending migrations)
//        node scripts/migrate.js list   (show applied/pending)
//
// Applied migrations are tracked in schema_migrations. Every migration runs
// inside a transaction so a failure leaves the database untouched. This
// replaces undocumented production schema edits: all schema changes must be
// added here as new numbered .sql files.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations(pool, { log = console.log } = {}) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT NOW()
        )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const appliedRes = await pool.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRes.rows.map(r => r.name));

    const results = [];
    for (const file of files) {
        if (applied.has(file)) {
            results.push({ file, status: 'already-applied' });
            continue;
        }
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
            results.push({ file, status: 'applied' });
            log(`[migrate] applied ${file}`);
        } catch (err) {
            await client.query('ROLLBACK');
            results.push({ file, status: 'failed', error: err.message });
            log(`[migrate] FAILED ${file}: ${err.message}`);
            throw err;
        } finally {
            client.release();
        }
    }
    return results;
}

async function listMigrations(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT NOW()
        )
    `);
    const appliedRes = await pool.query('SELECT name, applied_at FROM schema_migrations ORDER BY name');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const applied = new Set(appliedRes.rows.map(r => r.name));
    return files.map(f => ({ file: f, applied: applied.has(f) }));
}

module.exports = { runMigrations, listMigrations };

if (require.main === module) {
    if (!process.env.DATABASE_URL) {
        console.error('[migrate] DATABASE_URL is not set');
        process.exit(1);
    }
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 30000,
        family: 4
    });
    const mode = process.argv[2] || 'apply';
    (async () => {
        if (mode === 'list') {
            const rows = await listMigrations(pool);
            rows.forEach(r => console.log(`${r.applied ? '[x]' : '[ ]'} ${r.file}`));
        } else {
            await runMigrations(pool);
            console.log('[migrate] done');
        }
    })()
        .then(() => pool.end())
        .catch(err => { console.error('[migrate] error:', err.message); return pool.end().then(() => process.exit(1)); });
}
