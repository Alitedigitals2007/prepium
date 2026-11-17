-- 001: XP ledger + feature tables for the approved Prepium additions.
-- All statements are idempotent (IF NOT EXISTS) so re-running is safe.

-- Shared XP ledger (used by challenges, games, holiday mode, wrapped, skills)
CREATE TABLE IF NOT EXISTS xp_ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    source_ref VARCHAR(120),
    description VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_xp_ledger_event ON xp_ledger (source_type, COALESCE(source_ref, ''));
CREATE INDEX IF NOT EXISTS ix_xp_ledger_user ON xp_ledger (user_id, created_at);

-- Addition 1: Personal Academic Intelligence — editable study plans
CREATE TABLE IF NOT EXISTS study_plans (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT 'My study plan',
    period_type VARCHAR(20) NOT NULL DEFAULT 'weekly', -- daily | weekly
    items JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_study_plans_user ON study_plans (user_id, updated_at DESC);

-- Addition 2: Prepium Wrapped — shareable cards with privacy controls
CREATE TABLE IF NOT EXISTS wrapped_shares (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    share_token VARCHAR(64) UNIQUE NOT NULL,
    period_type VARCHAR(20) NOT NULL, -- weekly | semester | annual
    payload JSONB NOT NULL DEFAULT '{}',
    is_public BOOLEAN NOT NULL DEFAULT false,
    show_cgpa BOOLEAN NOT NULL DEFAULT false, -- CGPA is NEVER exposed by default
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_wrapped_shares_user ON wrapped_shares (user_id, created_at DESC);

-- Addition 3: Skills Centre — paths, lessons, enrollment + progress
CREATE TABLE IF NOT EXISTS skill_paths (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(80) UNIQUE NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT DEFAULT '',
    icon VARCHAR(60) DEFAULT 'fa-star',
    tone VARCHAR(30) DEFAULT 'blue',
    sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skill_lessons (
    id SERIAL PRIMARY KEY,
    path_id INTEGER NOT NULL REFERENCES skill_paths(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    summary TEXT DEFAULT '',
    content TEXT DEFAULT '',
    resource_url TEXT DEFAULT '',
    resource_label VARCHAR(150) DEFAULT '',
    est_minutes INTEGER DEFAULT 20,
    sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS skill_enrollments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    path_id INTEGER NOT NULL REFERENCES skill_paths(id) ON DELETE CASCADE,
    started_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, path_id)
);
CREATE TABLE IF NOT EXISTS skill_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    lesson_id INTEGER NOT NULL REFERENCES skill_lessons(id) ON DELETE CASCADE,
    completed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS skill_projects (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    path_id INTEGER NOT NULL REFERENCES skill_paths(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    notes TEXT DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'in_progress', -- in_progress | submitted
    submitted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Addition 4: Prepium Challenges — extends the existing Daily Challenge
CREATE TABLE IF NOT EXISTS challenge_defs (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(80) UNIQUE NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT DEFAULT '',
    cadence VARCHAR(20) NOT NULL, -- weekly | 7day | 30day | seasonal
    scope VARCHAR(20) NOT NULL DEFAULT 'individual', -- individual | friends | squad | department | faculty
    metric VARCHAR(30) NOT NULL DEFAULT 'quizzes',  -- quizzes | study_minutes | xp | challenge_score
    target INTEGER NOT NULL DEFAULT 5,
    xp_reward INTEGER NOT NULL DEFAULT 100,
    starts_at TIMESTAMP,
    ends_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS challenge_participants (
    id SERIAL PRIMARY KEY,
    challenge_id INTEGER NOT NULL REFERENCES challenge_defs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    joined_at TIMESTAMP DEFAULT NOW(),
    progress INTEGER NOT NULL DEFAULT 0,
    completed_at TIMESTAMP,
    UNIQUE (challenge_id, user_id)
);

-- Addition 5: Holiday Mode
CREATE TABLE IF NOT EXISTS holiday_mode (
    user_id INTEGER PRIMARY KEY,
    is_active BOOLEAN NOT NULL DEFAULT false,
    activated_at TIMESTAMP,
    deactivated_at TIMESTAMP,
    source VARCHAR(20) NOT NULL DEFAULT 'manual' -- manual | recommended
);
CREATE TABLE IF NOT EXISTS holiday_goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    goal_type VARCHAR(30) NOT NULL, -- revision | skills | projects | reading | challenges | opportunities | community
    title VARCHAR(200) NOT NULL,
    target_value INTEGER DEFAULT 1,
    progress_value INTEGER DEFAULT 0,
    is_done BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_holiday_goals_user ON holiday_goals (user_id, is_done, created_at DESC);

-- Addition 6: Opportunities Centre
CREATE TABLE IF NOT EXISTS opportunities (
    id SERIAL PRIMARY KEY,
    title VARCHAR(250) NOT NULL,
    category VARCHAR(40) NOT NULL, -- scholarship | bursary | internship | fellowship | competition | hackathon | graduate | volunteering | leadership
    organisation VARCHAR(200) DEFAULT '',
    description TEXT DEFAULT '',
    source_url TEXT,
    eligibility TEXT DEFAULT '',
    closing_date DATE,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified', -- verified | unverified
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_opportunities_active ON opportunities (is_active, closing_date);
CREATE TABLE IF NOT EXISTS opportunity_saves (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'saved', -- saved | applied | submitted | rejected | accepted
    reminder_at TIMESTAMP,
    note TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, opportunity_id)
);

-- Addition 7: Calls — history for accurate states + missed-call notifications
CREATE TABLE IF NOT EXISTS call_history (
    id SERIAL PRIMARY KEY,
    caller_id INTEGER NOT NULL,
    callee_id INTEGER NOT NULL,
    call_type VARCHAR(10) NOT NULL DEFAULT 'audio', -- audio | video
    status VARCHAR(20) NOT NULL DEFAULT 'missed',  -- missed | declined | ended | busy
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_call_history_user ON call_history (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_call_history_callee ON call_history (callee_id, created_at DESC);
