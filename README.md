# Prepium — Smart Exam Mastery Platform

CBT practice engine + AI study ecosystem for Nigerian university students.

## Overview

Prepium is a full-stack monolith (Express 5 + EJS + PostgreSQL) that turns every student's phone into a personal exam preparation centre. It combines a timed CBT exam engine, AI-generated quizzes from any PDF, CGPA tracking, academic productivity tools (timetables, deadlines, Pomodoro), community features, and an admin backoffice — all behind a ₦1,000 one-time paywall (with 2 free trials).

- **Live App**: https://theprepium.vercel.app
- **Tech Stack**: Node.js, Express 5, EJS, PostgreSQL (Neon), Paystack, Gemini AI, Groq, Cerebras, OpenRouter
- **Deployment**: Vercel (serverless), Neon (serverless Postgres)

---

## Core Features

### 1. Practice Exam Engine
| Route | Method | Middleware | Description |
|-------|--------|-----------|-------------|
| `/setup-test` | GET | `isStudent` | Choose subjects & question count per subject |
| `/start-quiz` | POST | `isStudent` | Validate free attempt cap (2), build quiz summary |
| `/live-exam` | POST | `isStudent` | Pull random questions per subject, start timed exam |
| `/submit-exam` | POST | `isStudent` | Grade, persist to `quiz_results`, increment `quiz_attempts` |

Students select 1+ subjects, pick question count per subject, set a timer (in minutes), then take a real CBT-style exam. Results show score, percentage, subject breakdown, per-question review with correct answers. Free users get 2 attempts then locked behind `has_paid`.

### 2. AI Quiz Generator (PDF → Questions)
| Route | Method | Middleware | Description |
|-------|--------|-----------|-------------|
| `POST /upload-pdf` | POST | none | Extract PDF text via `pdf-to-text` (server-side) or client-side PDF.js |
| `POST /generate-ai-quiz` | POST | `isAuth, requirePaid` | Send extracted text to AI pipeline → structured JSON quiz |
| `POST /save-ai-quiz-results` | POST | `isAuth` | Persist AI quiz score to `quiz_results` |
| `GET /api/ai-quiz/history` | GET | `isAuth` | Fetch past AI quiz results |

**Flow**: Student uploads a PDF lecture note → text is extracted (server-side via pdf-to-text lib or client-side via PDF.js for large files to bypass Vercel's 4.5MB body limit) → text is chunked and sent to the AI prompt chain (Groq fast → Cerebras 70B → Groq smart → OpenRouter fallback) → AI returns a JSON array of {type, question, options, correct, explanation} → quiz is rendered in the browser.

**AI prompt routing chain** (`openRouterPrompt()` in `app.js:4571`):
1. `groqPrompt()` with `llama-3.1-8b-instant` (~150-700ms)
2. `cerebrasPrompt()` with `llama-3.3-70b` (~700ms-1.5s)
3. `groqPrompt()` with `llama-3.3-70b-versatile` (~1-2s)
4. `openRouterPrompt()` with `google/gemma-3-27b-it:free` (~2-5s)

Supports 4 question types: **obj** (multiple choice), **german** (fill-in-gap), **theory** (essay), **mixed** (all three).

### 3. Daily Challenge Arena
| Route | Method | Description |
|-------|--------|-------------|
| `GET /daily-challenge` | GET | Auto-generates 10 questions via Gemini/Mistral, shows leaderboard |
| `POST /api/submit-arena` | POST | Submit score (once per day), upsert `daily_leaderboard` |

Uses `generateDailyChallengeQuestions()` in `app.js:2576` — calls Gemini 2.5 Flash with `responseMimeType: "application/json"` to generate exactly 10 questions covering Math, Science, English, History, Logic, Tech, etc. Falls back to Mistral API if Gemini fails.

Leaderboard shows top 10 with university slug.

### 4. Study Hub (AI-Powered Study System)
| Route | Method | Description |
|-------|--------|-------------|
| `GET /study` | GET | Dashboard with courses, progress, sessions, streak, today's stats |
| `GET /study/course/:id` | GET | Course detail with topics + subtopics tree |
| `GET /study/subtopic/:id` | GET | Subtopic content page with AI-generated explanations |
| `GET /study/session/:id` | GET | Study session view with timer |
| `GET /study/quiz/:attemptId` | GET | View quiz attempt results |
| `GET /study/flashcards/:courseId` | GET | Flashcards view |

**API Endpoints (prefix: `/api/study/`)**:
| Route | Method | Description |
|-------|--------|-------------|
| `/courses/add` | POST | Add a course |
| `/courses/delete/:id` | POST | Delete course + cascading topics/subtopics |
| `/import-timetable` | POST | Import courses from timetable |
| `/topics/add` | POST | Add topic with auto order_index |
| `/topics/delete/:id` | POST | Delete topic + subtopics |
| `/subtopics/ai-generate` | POST | AI generates 5-8 subtopics from topic title |
| `/subtopics/update` | POST | Update subtopic title/status |
| `/subtopics/:id/content` | POST | AI writes full lesson content (Key Points / Note / Example sections) |
| `/sessions/start` | POST | Start a Pomodoro-like study session |
| `/sessions/end` | POST | End session, update progress, AI-summarize notes |
| `/sessions/update` | POST | Update elapsed_seconds in real-time |
| `/session/summarize` | POST | AI summarizes study notes into bullet points |
| `/chat` | POST | Streaming AI tutor chat (Groq SSE stream) |
| `/flashcards/generate` | POST | AI generates flashcards |
| `/flashcards/delete/:id` | POST | Delete a flashcard |
| `/quiz/generate` | POST | AI generates quiz with configurable type/count/time |
| `/quiz/submit` | POST | Grade quiz, update progress |
| `/youtube/search` | POST | AI generates YouTube search queries for topic |
| `/stats` | GET | Aggregate study statistics |
| `/export/:courseId` | GET | Export course as JSON |
| `/cgpa-sync` | POST | Sync study courses into CGPA tracker |

### 5. CGPA Tracker
| Route | Method | Description |
|-------|--------|-------------|
| `GET /cgpa` | GET | CGPA dashboard with profile + courses, grade distribution, live calculation |
| `POST /cgpa/setup` | POST | Create/update CGPA profile (dept, level, grading scale, balance carry-forward) |
| `POST /cgpa/course/add` | POST | Add a course (code, title, level, semester, units, grade) |
| `POST /cgpa/course/edit` | POST | Edit course fields |
| `POST /cgpa/course/toggle-visible/:id` | POST | Hide/unhide course from CGPA calc |
| `POST /cgpa/course/delete/:id` | POST | Delete course |
| `POST /cgpa/reset` | POST | Reset all CGPA data |
| `GET /cgpa/api/data` | GET | JSON: profile + courses + computed stats via `buildCGPA()` |
| `POST /api/cgpa/forecast` | POST | What-if analysis — scenarios for grade improvements + adding courses + target CGPA |
| `POST /api/cgpa/ai-predict` | POST | AI predicts GPA range, identifies at-risk subjects, gives study tips |
| `POST /api/cgpa/ai-whatif` | POST | What-if for a single course (e.g. "If I take PHY 302 for 3 units and get A") |
| `POST /api/cgpa/ai-chat` | POST | Conversational AI academic advisor |
| `GET /api/cgpa/transcript` | GET | Full structured JSON transcript with semester grouping, degree class |

**CGPA engine** (`buildCGPA()` in `app.js:4004`):
- Supports 4.0 and 5.0 grading scales
- Degree class computation (First Class, Second Class Upper/Lower, Third Class, Pass, Fail)
- SVG arc rendering for visual gauge
- Grade distribution counts
- Balance carry-forward from previous institution
- Real-time calculation as courses are added/edited

### 6. Timetable System
| Route | Method | Description |
|-------|--------|-------------|
| `GET /timetable` | GET | View school timetable slots |
| `POST /timetable/add` | POST | Add a slot (course, day, time, venue, unit) |
| `POST /timetable/extract` | POST | AI extract timetable from uploaded image/PDF/document |
| `POST /timetable/delete/:id` | POST | Delete slot |
| `POST /timetable/update/:id` | POST | Update course_code + unit |
| `POST /timetable/save-extracted` | POST | Bulk save AI-extracted courses |

**AI extraction pipeline** (`POST /timetable/extract`):
```
Upload → file type detection → provider chain:
  Image (.jpg/.png/...): Gemini Vision (gemini-2.5-flash)
  PDF: LlamaParse → Gemini text (if LLAMAPARSE_KEY), else Gemini Vision
  DOCX/TXT: Unstructured.io → Gemini text (if UNSTRUCTURED_KEY), else Gemini Vision
  ↓
Clean JSON response → courses array [{course_code, course_name, day, start_time, end_time, venue, unit}]
```
Known courses context can be passed to improve matching accuracy.

### 7. Reading Timetable (AI-Generated Study Schedule)
| Route | Method | Description |
|-------|--------|-------------|
| `GET /reading-timetable` | GET | Page with settings, school slots, generated reading timetable |
| `POST /reading-timetable/settings` | POST | Save reading preferences (hours/day, session length, excluded courses) |
| `POST /reading-timetable/generate` | POST | Algorithmically distribute study sessions across week |
| `POST /reading-timetable/delete/:id` | POST | Delete a reading slot |
| `POST /reading-timetable/reset` | POST | Clear all reading slots |

**Algorithm** (`app.js:2352-2470`):
1. Gather courses (from school timetable or manual)
2. Calculate sessions needed = courses × sessions_per_course
3. Distribute across weekdays within preferred time window
4. Shuffle for fair distribution
5. Insert into `reading_timetables` table

### 8. Deadline Tracker + Email Notifications
| Route | Method | Description |
|-------|--------|-------------|
| `GET /deadlines` | GET | View deadlines |
| `POST /deadlines/add` | POST | Add deadline with date + time |
| `POST /deadlines/delete/:id` | POST | Delete deadline |
| `GET /api/deadlines` | GET | JSON for overlay |

**Notification system** (`checkDeadlineNotifications()` in `app.js:4349`):
- Runs every 5 minutes via `setInterval`
- Sends email 1 hour before deadline via Nodemailer (Gmail SMTP)
- Sends another email when deadline passes
- In-memory `notifiedDeadlines` Set prevents duplicate notifications
- Auto-cleans when > 1000 entries

### 9. Daily Task Dashboard
| Route | Method | Description |
|-------|--------|-------------|
| `GET /daily-task` | GET | Daily planner: school timetable, reading timetable, deadlines, goals, task checklist, weekly stats |
| `POST /api/daily-task/goal` | POST | Add personal goal |
| `POST /api/daily-task/goal/toggle/:id` | POST | Toggle goal completion |
| `POST /api/daily-task/goal/delete/:id` | POST | Delete goal |
| `POST /api/daily-task/task/toggle` | POST | Toggle task done/undone |
| `POST /api/daily-task/generate-tasks` | POST | Auto-generate tasks from timetable + deadlines |

### 10. Student Materials Library
| Route | Method | Description |
|-------|--------|-------------|
| `GET /subjects` | GET | Subjects library with question counts + uploaded materials |
| `POST /api/materials/upload` | POST | Upload file (disk storage, max 100MB) |
| `GET /api/materials` | GET | List user's materials |
| `GET /api/materials/:id/view` | GET | Serve file for viewing |
| `POST /api/materials/:id/delete` | POST | Delete material + file from disk |

### 11. Chat / Suggestions System
| Route | Method | Description |
|-------|--------|-------------|
| `GET /suggestions` | GET | User's support threads with unread indicators |
| `POST /suggestions/new` | POST | Create new support thread |
| `POST /suggestions/reply` | POST | Reply to thread |
| `GET /admin/suggestions` | GET | Admin view all threads |
| `POST /admin/suggestions/reply` | POST | Admin reply |
| `POST /admin/suggestions/status` | POST | Close/reopen thread |

### 12. Referral / Ambassador Program
| Route | Method | Description |
|-------|--------|-------------|
| `GET /refer` | GET | Referral landing page |
| `GET /refer/dashboard` | GET | Referral dashboard with stats, referrals list, withdrawal history |
| `POST /refer/withdraw` | POST | Submit withdrawal request (10% fee, min ₦100) |
| `POST /ambassador/register` | POST | Self-register with name + bank details, get 6-digit code |
| `GET /ambassador/login` | GET | Ambassador login |
| `POST /ambassador/login` | POST | Login via unique code |
| `GET /ambassador/dashboard` | GET | Ambassador stats + referrals |
| `POST /ambassador/update-bank` | POST | Update bank details |

**Commission model**: 15% per referral (₦300 per ₦2,000 premium activation). Commission credited on payment verification via Paystack callback.

### 13. Admin Panel
| Route | Description |
|-------|-------------|
| `GET /admin/login` | Admin login (env-based credentials) |
| `GET /admin/dashboard` | Overview: universities, students, premium, subjects, questions counts, recent signups |
| `GET /admin/analytics` | Full analytics: signup trends, revenue estimation, quiz counts, active battlers, coupon usage, page views |
| `GET /admin/students` | Student directory with search + university filter + premium toggle |
| `POST /admin/students/toggle-status/:id` | Toggle student has_paid |
| `GET /admin/universities` | University CRUD |
| `GET /admin/coupons` | Coupon management (percent/fixed discount, max uses, expiry, toggle active) |
| `GET /admin/notifications` | Send broadcast notifications |
| `GET /admin/email` | Bulk email sender with university/tier/group filters |
| `GET /admin/groups` | User group management for email targeting |
| `GET /admin/suggestions` | Student support thread management |
| `GET /admin/ambassadors` | Ambassador list with earnings + payout |
| `POST /admin/payout-complete/:id` | Record ambassador payout |
| `GET /admin/withdrawals` | Withdrawal request management |
| `POST /admin/withdrawals/update/:id` | Approve/reject withdrawal |
| `GET /admin/daily` | Daily challenge management — leaderboard, question stock, today's questions |
| `GET /admin/db-manager` | **DB Manager** — browse tables, view data, inline edit, run SELECT queries (PIN-protected) |

### 14. Auth & Security
| Route | Method | Description |
|-------|--------|-------------|
| `GET /signup` | GET | Signup form with university dropdown |
| `POST /auth/signup` | POST | Rate-limited (5/min), bcrypt password, referral code support |
| `GET /login` | GET | Login page |
| `POST /auth/login` | POST | Rate-limited (10/min), AJAX JSON response, session creation, streak tracking |
| `GET /logout` | GET | Session destroy + cookie clear |
| `GET /forgot-password` | GET | Password reset form |
| `POST /forgot-password` | POST | Generate token, email reset link (1hr expiry) |
| `GET /reset/:token` | GET | Verify token, show reset form |
| `POST /reset/:token` | POST | bcrypt new password, clear token |

**Session config**: PostgreSQL-backed via `connect-pg-simple`, rolling `maxAge: 24h`, `sameSite` varies by environment.

**Middleware chain**:
- `isAuth` — checks `req.session.user`, returns 401 JSON for XHR/API, redirects to /login otherwise
- `requirePaid` — checks `has_paid === true`, returns 402 JSON for XHR/API, redirects to /dashboard with message
- `hasPaid` — legacy, redirects to /dashboard
- `isAdmin` — checks `is_admin === true`, returns 403 otherwise
- `isStudent` — checks logged in + not admin, sets no-cache headers
- `rateLimit(max, windowMs)` — in-memory IP+path rate limiter

### 15. Payment System (Paystack)
| Route | Method | Description |
|-------|--------|-------------|
| `GET /verify-payment` | GET | Paystack callback — verify tx, activate user, credit ambassador, coupon usage |
| `GET /upgrade` | GET | Premium upgrade page |
| `POST /api/coupon/validate` | POST | Validate coupon code (percent/fixed discount, usage limits, expiry) |

**Flow**: Paystack popup → `transaction.verify` API → check `has_paid` (prevent double-credit) → update user + session → credit ambassador 15% of ₦2,000 → increment coupon usage → redirect with `?payment=success`.

### 16. Competition Mode
| Route | Method | Description |
|-------|--------|-------------|
| `GET /competition` | GET | Competition landing page (unauthenticated view) |

### 17. Utility Routes
| Route | Method | Description |
|-------|--------|-------------|
| `GET /api/heartbeat` | GET | Session cookie refresh (rolling: true) |
| `GET /download-vcard` | GET | Download contact vCard |
| `GET /how-it-works` | GET | Guide page |
| `POST /upload-pdf` | POST | PDF text extraction (legacy, replaced by client-side PDF.js) |
| `GET /profile` | GET | User profile with CGPA, streak, study stats, quiz stats |

---

## Database Schema (PostgreSQL)

Prepium auto-creates all tables on startup via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Here are all tables:

### Core Auth
- `users` — id, fullname, email, password, university_id, unique_code, has_paid, quiz_attempts, used_coupon, reset_password_token, reset_password_expires, created_at
- `user_sessions` — sid, sess, expire (PostgreSQL session store)

### Academy
- `universities` — id, name, slug
- `subjects` — id, name, university_id, drive_link
- `questions` — id, subject_id, question_text, option_a/b/c/d, correct_option, university_id, explanation
- `results` — user_id, score, total_questions, subject, taken_at (legacy)
- `quiz_results` — id, user_id, subject_id, title, score, total_questions, percentage, time_taken, created_at
- `competitions` — id, title, is_active

### AI Quiz System
- `ai_courses` — id, university_id, course_code, course_title, question_count, created_by
- `ai_questions` — id, course_id, question_text, options (JSONB), correct_answer, explanation

### Study Hub
- `study_courses` — id, user_id, course_name, course_code, unit, source, updated_at
- `study_topics` — id, course_id, user_id, topic_name, title, completed, order_index
- `study_subtopics` — id, topic_id, course_id, user_id, subtopic_name, title, status, content, notes
- `study_sessions` — id, user_id, course_id, subtopic_id, subject_id, course_name, elapsed_seconds, duration_minutes, session_date, status, notes, completed_at
- `study_progress` — id, user_id, course_id, course_name, total_sessions, total_minutes, last_studied (UNIQUE on user_id + course_name)
- `study_chat_messages` — id, user_id, course_id, subtopic_id, role, message
- `study_flashcards` — id, user_id, course_id, subtopic_id, front, back
- `study_quiz_attempts` — id, user_id, course_id, subtopic_id, question_type, question_count, time_limit, score, total_questions, status, started_at, completed_at
- `study_quiz_questions` — id, attempt_id, question, options (JSONB), correct_answer, user_answer, is_correct, explanation, order_index
- `study_youtube_videos` — id, user_id, course_id, subtopic_id, title, url, thumbnail, channel

### CGPA
- `cgpa_profiles` — user_id (UNIQUE), department, current_level, grading_scale, prev_units, prev_gp, prev_cgpa
- `cgpa_courses` — id, user_id, course_code, title, level_scope, semester, credit_units, grade, is_hidden, deleted

### Timetable
- `timetables` — id, user_id, course, course_code, unit, day, start_time, end_time, venue, source
- `reading_timetables` — id, user_id, course, course_code, unit, day, start_time, end_time, source, week_start
- `reading_settings` — user_id (UNIQUE), use_school_timetable, daily_hours, session_minutes, sessions_per_course, preferred_time_start, preferred_time_end, excluded_courses (TEXT[])

### Deadlines
- `deadlines` — id, user_id, title, due_date, due_time (INDEX on user_id + due_date)

### Daily Challenge
- `daily_questions` — id, question_text, option_a/b/c/d, correct_option, explanation, date_scheduled
- `daily_leaderboard` — user_id (UNIQUE), username, monthly_score, last_played

### Referral / Ambassador
- `ambassadors` — id, name, unique_code (UNIQUE), bank_details, total_referrals, total_earned, total_withdrawn, active_invite_count, free_invite_count
- `payout_requests` — id, ambassador_id, amount_requested, fee_amount, net_payout, bank_details, status, processed_by

### Admin
- `notifications` — id, title, message, is_read, created_at
- `coupons` — id, code (UNIQUE), discount_type, discount_value, max_uses, times_used, is_active, expires_at
- `page_views` — page_path, view_count (optional analytics)
- `user_groups` — id, name (UNIQUE), description
- `user_group_members` — id, group_id, user_id (UNIQUE)

### Chat
- `suggestion_threads` — id, user_id, title, status, created_at
- `suggestion_messages` — id, thread_id, sender_id, sender_role, message, is_read, created_at

### Materials
- `student_materials` — id, user_id, name, description, file_type, file_size, file_path, file_data (BYTEA), created_at

### Streaks
- `login_streaks` — user_id (UNIQUE), current_streak, longest_streak, last_login_date

### Tasks
- `personal_goals` — id, user_id, goal, target_date, is_completed
- `daily_task_items` — id, user_id, task_date, task_type, task_label, is_done
- `weekly_analytics` — id, user_id, week_start (UNIQUE), total_tasks, completed_tasks, study_minutes, quiz_count, avg_score

---

## AI Engine

### Provider Priority Chain

All text AI routes route through `openRouterPrompt()`:

```
groqPrompt(llama-3.1-8b-instant) [~150-700ms]
  → cerebrasPrompt(llama-3.3-70b / 3.1-70b) [~700ms-1.5s]
    → groqPrompt(llama-3.3-70b-versatile / 3.1-8b-instant) [~1-2s]
      → openRouterPrompt(google/gemma-3-27b-it:free) [~2-5s]
```

### Provider-Specific Functions

| Function | Provider | Model(s) | Use Case | Timeout |
|----------|----------|----------|----------|---------|
| `groqPrompt()` | Groq | llama-3.1-8b-instant, llama-3.3-70b-versatile | Chat, flashcards, explanations, quiz gen | 25s |
| `groqStream()` | Groq | llama-3.1-8b-instant | Streaming AI tutor chat (SSE) | 25s |
| `cerebrasPrompt()` | Cerebras | llama-3.3-70b, llama-3.1-70b | Long content, quiz gen, summaries | 45s |
| `openRouterPrompt()` | OpenRouter | gemma-3-27b-it:free | Last-resort fallback | 45s |
| `callGeminiWithImage()` | Gemini | gemini-2.5-flash | PDF/image timetable extraction | 30s |
| `callGeminiWithText()` | Gemini | gemini-2.5-flash | Text-based AI tasks | 30s |
| `generateDailyChallengeQuestions()` | Gemini → Mistral | gemini-2.5-flash / mistral-small-latest | Daily question generation with JSON mode | 30s |
| `callLlamaParse()` | LlamaParse | proprietary | High-quality PDF text extraction | poll up to 60s |
| `callUnstructured()` | Unstructured.io | proprietary | DOCX/PPTX text extraction | 60s |

### AI Prompt Categories

1. **Quiz generation** (`/generate-ai-quiz`, `/api/study/quiz/generate`): Extract text → AI prompt with style instructions (obj/german/theory/mixed) + difficulty level → JSON array response → normalize answer formats → persist questions

2. **Content generation** (`/api/study/subtopics/:id/content`): Generate 3-section lesson (Key Points, Note, Example) using `studyPromptSmart()`

3. **Flashcard generation** (`/api/study/flashcards/generate`): Generate {front, back, image} pairs from topic title

4. **Chat** (`/api/study/chat`, `/api/cgpa/ai-chat`): Streaming (Groq SSE) or non-streaming with conversation history context

5. **Timetable extraction** (`/timetable/extract`): Multi-provider extraction pipeline with format-specific routing

6. **Tutor / Advisor** (`/api/cgpa/ai-predict`, `/api/cgpa/ai-whatif`): Academic prediction and advice based on course history

7. **Subtopics** (`/api/study/subtopics/ai-generate`): Generate subtopic list from topic title

8. **YouTube search** (`/api/study/youtube/search`): Generate search queries, save to DB, render clickable cards

---

## Key Operations & Running Shit

### Startup
```bash
node app.js
# → http://localhost:3000
```

The server auto-creates all DB tables on first run. No manual migration needed for core schema. The `_migrate.cjs` script handles column backfills for older schemas.

### Environment Variables (.env)
```
DATABASE_URL=postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
PAYSTACK_PUBLIC_KEY=pk_test_xxx
PAYSTACK_SECRET_KEY=sk_test_xxx
SESSION_SECRET=any-random-string
ADMIN_EMAIL=admin@prepium.com
ADMIN_PASSWORD=admin123

# AI Keys (at least one required for AI features to work)
CEREBRAS_API_KEY=csk-xxx          # → Cerebras 70B (best for quiz gen)
GROQ_API_KEY=gsk-xxx               # → Groq (fastest for chat/flashcards)
GEMINI_API_KEY_PRIMARY=AIza...     # → Gemini (PDF/image extraction, daily challenge)
GEMINI_API_KEY_SECONDARY=AIza...   # → Gemini failover
OPENROUTER_API_KEY=sk-or-...       # → Fallback
MISTRAL_API_KEY=xxx                # → Daily challenge fallback
LLAMAPARSE_API_KEY=llx-...         # → Optional: better PDF extraction
UNSTRUCTURED_API_KEY=xxx           # → Optional: DOCX/PPTX extraction

# Email (for password reset + deadline notifications)
EMAIL_USER=your@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx     # Gmail app password
APP_URL=http://localhost:3000
```

### API Key Limits (Free Tier)
| Provider | RPM | Daily Limit | Sign-up |
|----------|-----|-------------|---------|
| Gemini | 15 | 1,500 req/day | aistudio.google.com |
| Cerebras | 30 | unlimited | cloud.cerebras.ai |
| Groq | 30 | unlimited | console.groq.com |
| OpenRouter | varies | varies | openrouter.ai |

### Key-Rotator (Gemini Failover)
File: `key-rotator.cjs` — monkeys-patches `globalThis.fetch` to intercept Gemini API calls. Implements:
- Round-robin across `GEMINI_API_KEY_PRIMARY` and `GEMINI_API_KEY_SECONDARY`
- Auto-retry on 429 (rate limit) with next key
- Auto-failover on connection errors
- Consecutive failure counter for circuit-breaking

### Deployment (Vercel)
```json
{
  "version": 2,
  "builds": [{ "src": "app.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "app.js" }]
}
```
⚠ **Vercel body limit**: 4.5MB. PDF uploads exceeding this are handled client-side via PDF.js (extract text in-browser, send only text to server). The `POST /upload-pdf` route is a fallback for small files.

### Paywall System
Premium features are gated behind `requirePaid` middleware. Utility scripts in root (`_apply_paywall.js.cjs`, `_paywall_v2.js.cjs`, `_paywall_v3.js.cjs`) auto-patch `prepium/app.js` to add `requirePaid` to route handlers. The `.gitignore` excludes `prepium/` to prevent deployment of the patched copy.

### DB Manager (Admin)
`/admin/db-manager` provides:
- Browse any table with column headers
- Inline edit any row
- Run SELECT queries
- PIN + password protection (`DB_MANAGER_PIN`, `DB_MANAGER_PASS`)

---

## Advantages & Why You Need This

### For Students
1. **All-in-one**: Practice questions, AI study tools, CGPA, deadlines, timetables, chat — one app, no switching
2. **AI from your own materials**: Upload any PDF lecture note → instant practice questions with explanations
3. **Free to try**: 2 full practice quizzes before any payment
4. **Lifetime access**: ₦1,000 one-time, no subscriptions, no recurring charges
5. **Mobile-first**: PWA with manifest.json + service worker, works offline for cached content
6. **No internet for exams**: All quiz logic runs server-side, just need connection to fetch questions + submit

### For Schools
1. **Zero infrastructure**: Works on any phone with a browser, no app store deployment
2. **Unified question bank**: All departments, all courses, one platform
3. **Auto-graded exams**: Instant results, no manual marking
4. **Performance analytics**: Per student, per subject, per session data
5. **AI question generation**: Convert existing PDF lecture notes into practice questions automatically
6. **GES/GST support**: Built-in AI course generation for General Studies
7. **Cost-effective**: ₦1,000 per student lifetime vs. printing costs

### Technical Advantages
1. **Multi-AI fallback chain**: Auto-failover across 4 AI providers, no single point of failure
2. **Serverless-ready**: Runs on Vercel free tier, Neon free tier PostgreSQL
3. **Zero downtime migrations**: All schema changes via `CREATE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`
4. **Client-side PDF extraction**: Bypasses Vercel's 4.5MB body limit for large lecture PDFs
5. **Rate limiting**: Per-route, per-IP in-memory limiter for auth endpoints
6. **Atomic transactions**: CGPA reset, daily question insertion, payment verification all use BEGIN/COMMIT/ROLLBACK
7. **Session-backed quiz state**: Active quiz stored in session, survives page refreshes
8. **Streaming AI chat**: Groq SSE stream for real-time AI tutor responses

---

## Links

- **Live App**: https://theprepium.vercel.app
- **Email**: michaelbrainny842@gmail.com

*Built for Nigerian students.*
