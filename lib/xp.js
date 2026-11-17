'use strict';

// Shared XP ledger. All XP across Prepium (daily challenge, games, challenges,
// holiday-mode goals, skills) is awarded through awardXP() so every award is
// traceable and duplicates are impossible: the (source_type, source_ref) pair
// is unique in the database, and repeated award calls for the same event are
// no-ops. XP is NOT CGPA and NOT money — it is engagement credit only.

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS xp_ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_ref VARCHAR(120),
    description VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
)`;
const INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS ux_xp_ledger_event ON xp_ledger (source_type, COALESCE(source_ref, ''))`;
const USER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ix_xp_ledger_user ON xp_ledger (user_id, created_at)`;

let ready = null;
function ensureTable(pool) {
    if (!ready) {
        ready = (async () => {
            await pool.query(TABLE_SQL);
            await pool.query(INDEX_SQL);
            await pool.query(USER_INDEX_SQL);
        })().catch(err => { ready = null; throw err; });
    }
    return ready;
}

// Award XP. Returns { awarded: true, balance, level } when a new award was
// recorded, or { awarded: false, reason: 'duplicate' } when the same event
// was already rewarded. sourceRef identifies the concrete event (e.g. attempt
// id, date string, challenge id) — pass null only for events that can never
// repeat. The ledger row is the traceable record; users.xp is kept in sync so
// all existing XP displays (profile, leaderboard, games) keep working.
async function awardXP(pool, userId, amount, sourceType, sourceRef, description) {
    if (!userId) return { awarded: false, reason: 'no-user' };
    const amt = parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return { awarded: false, reason: 'bad-amount' };
    await ensureTable(pool);
    let inserted = false;
    try {
        await pool.query(
            'INSERT INTO xp_ledger (user_id, amount, source_type, source_ref, description) VALUES ($1, $2, $3, $4, $5)',
            [userId, amt, String(sourceType).slice(0, 50), sourceRef ? String(sourceRef).slice(0, 120) : null, String(description || '').slice(0, 255)]
        );
        inserted = true;
    } catch (err) {
        if (err && err.code === '23505') return { awarded: false, reason: 'duplicate' };
        throw err;
    }
    // Keep the denormalised users.xp balance in sync (single UPDATE, no drift
    // because every change to users.xp now goes through this function).
    const upd = await pool.query(
        'UPDATE users SET xp = GREATEST(0, COALESCE(xp, 0) + $1) WHERE id = $2 RETURNING xp',
        [amt, userId]
    );
    const balance = upd.rows[0] ? (parseInt(upd.rows[0].xp, 10) || 0) : await getXPBalance(pool, userId);
    return { awarded: inserted, balance };
}

async function getXPBalance(pool, userId) {
    const r = await pool.query('SELECT COALESCE(xp, 0) AS xp FROM users WHERE id = $1', [userId]);
    return parseInt(r.rows[0]?.xp, 10) || 0;
}

async function getXPHistory(pool, userId, limit = 30) {
    const r = await pool.query(
        'SELECT amount, source_type, description, created_at FROM xp_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
        [userId, Math.min(parseInt(limit, 10) || 30, 100)]
    );
    return r.rows;
}

// XP earned within a time window (used by Wrapped + challenges).
async function getXPInWindow(pool, userId, sinceSql) {
    const r = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM xp_ledger WHERE user_id = $1 AND created_at >= ${sinceSql}`,
        [userId]
    );
    return parseInt(r.rows[0].total, 10) || 0;
}

module.exports = { awardXP, getXPBalance, getXPHistory, getXPInWindow, ensureTable };
