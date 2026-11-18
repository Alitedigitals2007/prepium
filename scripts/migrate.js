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

// Advisory-lock key that serialises migrations across concurrent processes.
// On Vercel every cold start boots a lambda that runs the migrations, so two
// instances can race the same file: the loser used to crash on the
// schema_migrations primary key and serve 503s. The lock is taken inside the
// migration transaction (pg_advisory_xact_lock) so it also behaves correctly
// behind Neon's transaction-mode pooler.
const MIGRATION_LOCK_KEY = 727101;

// Connection-class / capacity errors that clear up on retry (Neon cold start,
// pooler connection churn, free-tier connection limit).
const TRANSIENT_ERR_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '53300', '57P01', '57P02', '57P03']);
function isTransientDbError(err) {
    if (!err) return false;
    if (TRANSIENT_ERR_CODES.has(err.code)) return true;
    return /connection terminated|terminating connection|timeout expired|ECONNRESET|ETIMEDOUT|too many connections/i.test(String(err.message || ''));
}

// Human-facing error: keeps the SQLSTATE and adds the fix for the most common
// deterministic failure — PostgreSQL 15+ no longer grants CREATE on the public
// schema to non-owner roles, so the first CREATE TABLE fails with 42501.
function describeError(err) {
    const base = [err && err.code ? String(err.code) : '', err && err.message ? err.message : '']
        .filter(Boolean).join(' ');
    if (err && err.code === '42501') {
        return `${base} — the database role in DATABASE_URL cannot create tables. ` +
            `Use the database owner connection string (Neon: the one ending in "-owner"), ` +
            `or run as the owner: GRANT CREATE ON SCHEMA public TO <db_user>;`;
    }
    return base || 'unknown migration error';
}
function enrichError(err) {
    const enriched = new Error(describeError(err));
    enriched.code = err && err.code;
    enriched.cause = err;
    return enriched;
}

async function runMigrations(pool, { log = console.log } = {}) {
    // Bootstrap the tracking table under the same advisory lock as the
    // migrations: two concurrent cold starts both running
    // CREATE TABLE IF NOT EXISTS schema_migrations on a fresh database can
    // collide inside the Postgres catalog (unique pg_type index) even though
    // the statement is idempotent.
    for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
            await client.query(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    name VARCHAR(255) PRIMARY KEY,
                    applied_at TIMESTAMP DEFAULT NOW()
                )
            `);
            await client.query('COMMIT');
            break;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (isTransientDbError(err) && attempt < 3) {
                log(`[migrate] transient error bootstrapping schema_migrations (attempt ${attempt + 1}), retrying: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                continue;
            }
            throw enrichError(err);
        } finally {
            client.release();
        }
    }

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const results = [];
    for (const file of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        for (let attempt = 0; ; attempt++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Serialise concurrent boots, then re-check: another instance
                // may have applied this file while we waited for the lock.
                await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
                const dup = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
                if (dup.rowCount > 0) {
                    await client.query('ROLLBACK');
                    results.push({ file, status: 'already-applied' });
                    break;
                }
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
                    [file]
                );
                await client.query('COMMIT');
                results.push({ file, status: 'applied' });
                log(`[migrate] applied ${file}`);
                break;
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                if (isTransientDbError(err) && attempt < 3) {
                    log(`[migrate] transient error on ${file} (attempt ${attempt + 1}), retrying: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                    continue;
                }
                results.push({ file, status: 'failed', error: describeError(err) });
                log(`[migrate] FAILED ${file}: ${describeError(err)}`);
                throw enrichError(err);
            } finally {
                client.release();
            }
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
