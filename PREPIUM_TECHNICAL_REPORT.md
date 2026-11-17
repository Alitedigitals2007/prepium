# Prepium — Complete Technical Investigation Report

**Date of investigation:** 17 Nov 2026
**Repository:** `Alitedigitals2007/prepium` (HEAD at commit `70dd292`)
**Method:** Full read of `app.js` (8,622 lines, the entire backend), all route inventories, view templates, scripts, configs, git history, and cross-referencing of routes ↔ views ↔ database tables. No files were modified during the investigation. Everything below is code-verified unless explicitly marked *assumption* / *unverifiable*.

---

## 1. Project Overview

**What Prepium is:** An AI-powered study companion for Nigerian university students, marketed at `https://theprepium.vercel.app`. It combines CBT-style practice, an AI Study Hub, CGPA tracking, timetables/deadlines, daily challenges, games, and a social community layer, monetized through a school-based premium model paid via Paystack.

**Architecture (verified):**

| Layer | Technology | Evidence |
|---|---|---|
| Backend | Node.js (≥18) + Express 5, single-file monolith | `package.json` (`"main": "app.js"`), `app.js:1-9` |
| Frontend | Server-rendered EJS templates (~100 views) + one shared stylesheet + vanilla JS | `views/`, `public/css/style.css`, `views/partials/head.ejs` |
| Database | PostgreSQL (Neon serverless per code comments), accessed via `pg` Pool | `app.js:71-79` |
| Sessions | `express-session` + `connect-pg-simple` (Postgres-backed `user_sessions` table) | `app.js:42-42, 478-494` |
| Auth | bcryptjs password hashing; separate env-credential admin login | `app.js:661, 723, 2170-2205` |
| Realtime | Socket.IO (chat, typing, read receipts, WebRTC call signaling) | `app.js:8529-8613` |
| Payments | Paystack (inline popup + webhook + server-side verification) | `app.js:402-464, 1012-1145`, `views/upgrade.ejs` |
| Email | Nodemailer via Gmail SMTP | `app.js:390-395, 5106-5125` |
| PDF/Excel | pdfkit (transcript), pdf-parse (lecture notes), exceljs (form exports) | `package.json`, `app.js:6652, 3642` |
| PWA | `public/manifest.json`, `public/sw.js` (cache-first static / network-first public pages), `/offline`, `/install` | `public/sw.js:1-40` |
| Hosting | Vercel serverless (`vercel.json` routes everything to `app.js`); background jobs skipped when `VERCEL=1` | `vercel.json`, `app.js:89, 5204, 5238` |

**How it works overall:** One Express app serves everything — SEO middleware, page-view tracking, session auth, three entitlement middlewares (`isAuth` app.js:508, `requirePaid` app.js:516, `featureLock(key)` app.js:911, plus `isStudent` app.js:1504 and `isAdmin` app.js:542). Database schema is bootstrapped at startup by ~20 self-invoking `CREATE TABLE IF NOT EXISTS` blocks (e.g. `app.js:108-388, 5486-5532, 6879-7161`). AI calls are funneled through a provider-fallback chain (Gemini → Groq → Cerebras → OpenRouter). On a long-lived server, three `setInterval` background jobs run (deadline email reminders app.js:5204-5211, weekly leaderboard reset app.js:5238-5243, DB keep-alive app.js:89-94); on Vercel these are skipped.

**Repo layout:**
- `app.js` — the entire backend (routes, middleware, DB bootstrap, AI helpers, Socket.IO).
- `views/*.ejs` + `views/admin/*.ejs` + `views/partials/*.ejs` — all pages.
- `public/` — css, images, manifest, service worker, uploaded podcast mp3s, roadmap.html, Google verification file.
- `scripts/` — `seed-universities.js` (Nigerian institutions list), `seed-library.js` (University of Ibadan faculty/department structure), `generate-icons.js` (PWA icons).
- `Platform.md` / `converted (1).md` — identical product-redesign specification documents (693 lines).
- `start.py` + three `.pptx` files — a python-pptx script and generated pitch decks (not app code).
- `session-ses_e16a.md` — a 1 MB AI session transcript (stray artifact, untracked).
- `renaissance-import-template.tex` — LaTeX bulk-import template for the (now route-less) Renaissance exam builder.

---

## 2. Features (existing, with implementation locations)

### 2.1 Accounts & Auth
- **Signup** with school selection; school determines premium entitlement at signup (`/auth/signup`, app.js:657-690).
- **Login** (AJAX) with login-streak tracking and `login_history` analytics insert (`/auth/login`, app.js:712-786).
- **Password reset** via email token (`/forgot-password` POST app.js:4123-4170, `/reset/:token` GET/POST app.js:4172-4247; token = 20-byte hex, 1 h expiry, single-use).
- **Logout** (app.js:1465), **account deletion** via GET `/auth/delete-account` (app.js:1482-1502).
- **Profile page** `/profile` with stats (quizzes taken, avg score, computed CGPA, streak, study minutes) (app.js:1147-1244).

### 2.2 Practice & Challenges
- **Subjects library** `/subjects` — per-university subject list with question counts + Google Drive links + personal material uploads (app.js:1717-1766).
- **Student materials** — upload/view/delete files stored as Postgres BYTEA (`/api/materials*`, app.js:1769-1862).
- **Daily Challenge / "The Prepium Arena"** `/daily-challenge` + `/competition` — AI-generated 15-question MCQ challenge, one attempt/day, server-side scoring (`/api/daily-challenge/start` app.js:3833, `/api/submit-arena` app.js:3906), monthly leaderboard (`daily_leaderboard`), weekly reset job (app.js:5220-5243).

### 2.3 Study Hub (premium)
- Courses → topics → subtopics hierarchy; import courses from timetable (`/api/study/import-timetable`, app.js:5835).
- **AI subtopic generation** per topic (app.js:5916), **AI lecture content** with a large structured professor prompt incl. LaTeX + optional Mermaid (app.js:5989-6056), **AI Q&A** grounded on the generated content (app.js:6060), **AI tutor chat** with persisted history (app.js:6125-6165).
- **AI flashcards** generation/management (app.js:6300-6360), **AI quizzes** (MCQ/theory/mixed) with attempts, scoring, resume-in-progress (app.js:6191-6297), **Pomodoro-style study sessions** with notes + AI summary (app.js:6082-6122), **YouTube search** suggestions (AI-generated queries, links out to YouTube) (app.js:6168-6188), course JSON export (app.js:6377), CGPA sync (app.js:6390).

### 2.4 CGPA Tracker (premium)
- Profile wizard (4/5-point scale, carry-over balance), course CRUD, CSV import/export, hide/show courses, reset (`/cgpa*`, app.js:4685-5083).
- **What-If builder** (single + bulk hypothetical courses) (app.js:6484-6546), forecast scenarios (app.js:6406), **AI next-semester prediction** (app.js:6464), **AI academic-advisor chat** (app.js:6548).
- **Transcript** as structured JSON (app.js:6577) and a branded **PDF transcript** via pdfkit (app.js:6622-6807) with reference numbers and "student-owned record" disclaimer.

### 2.5 Timetables & Planning (premium)
- **Class timetable** with manual slots and **AI extraction** from images/PDFs/docs (Gemini Vision / LlamaParse→Gemini / Unstructured→Gemini fallback chain) (`/timetable/extract`, app.js:2410-2518).
- **AI Reading Schedule** `/reading-timetable` — settings-driven algorithmic generator (daily hours, session length, sessions/course, preferred window, excluded courses) (app.js:2576-2805). Despite the "AI" name, generation is deterministic arithmetic, not an LLM call.
- **Deadline tracker** with CRUD + JSON API (app.js:2222-2301) and **email reminders** (1-hour warning + expiry notice) via background job (app.js:5136-5211).
- **Daily Task dashboard** `/daily-task` — today's classes/reading/deadlines, personal goals, tick-box tasks, auto-generation of tasks, weekly report API (app.js:4400-4661).

### 2.6 Games Hub (free)
- **Sudoku, Word Scramble, Chess vs AI, Crossword** — fully client-side pages (`/games*`, app.js:5737-5745; views `games-*.ejs`).
- Results saved server-side (`/api/games/result` app.js:5681) with validation; **XP + level system** on `users.xp` (app.js:5605-5615, 5631), per-game stats and history APIs (app.js:5654-5679), **friends XP leaderboard** (`/api/friends/leaderboard`, app.js:7707).

### 2.7 Community (free)
- **Friends**: search, request/accept/remove, requests lists (app.js:7500-7730).
- **Chat**: direct + group conversations, text/image/voice messages (BYTEA), unread counts, sent/delivered/read states, typing indicators, Socket.IO realtime, **WebRTC audio/video call signaling** (`call:offer/answer/ice/end`, app.js:8579-8607), group admin (add/remove members, rename, leave, delete) (app.js:7742-8106).
- **Status stories**: text/image, 24 h expiry, public/friends privacy, view tracking (app.js:8109-8221).
- **Feed**: posts with images, likes, delete, friend-scoped visibility (app.js:8298-8401).
- **Public profiles** `/u/:id` (games, level, friends count — no academic data) (app.js:8404-8458).
- **Squads**: group accountability with daily check-ins and computed squad streaks (app.js:3315-3480).
- **Notifications**: global announcements + per-user social notifications, read tracking (app.js:1671-1715, 8224-8274).

### 2.8 Course Library (public)
- Hierarchy University → Faculty → Department → Course → Resources (`/library*`, app.js:7261-7404), global search, level/semester filters.
- Community contributions with https-only links, stored **unverified** until admin approval (`/api/library/contribute`, app.js:7407-7451); admin moderation (app.js:7454-7481). Seeded via `scripts/seed-library.js`.

### 2.9 Premium & Payments
- `/upgrade` page with free-vs-premium comparison, Paystack inline popup, coupon input (`views/upgrade.ejs:559-620`).
- Server verification `/verify-payment` (app.js:1012-1145) and webhook `/paystack-webhook` (app.js:402-464).
- **Coupon system** (`/api/coupon/validate` app.js:789; admin CRUD app.js:982-1009).
- **Refer & Earn** for paid-school students: auto-generated referral code, 15% commission credited on referred payments, withdrawal requests with 10% fee, min ₦100 (app.js:3195-3310). Legacy ambassador self-service routes deliberately return 403 (app.js:1918-1933, 3665).

### 2.10 Misc
- PWA install page/banner + service worker; SEO (robots.txt, sitemap.xml, OG tags, canonical); `/guide` user guide; `/how-it-works`; `/terms`, `/privacy`; feedback/support threads `/suggestions` (app.js:3002-3107); public score-collection forms `/form/:slug` with Excel export (app.js:3485-3663); vCard download (app.js:4262); `/api/heartbeat`.

---

## 3. User Experience (journeys, pages, navigation)

- **Landing** `/` (index.ejs) → `/signup` (school picker) → `/login` (shows admin-configurable **login notice**).
- **Student dashboard** `/dashboard` (dashboard.ejs, 635 lines): phone-style home screen with greeting + streak chip, notification bell with unread count, a data-driven **"next action" hero card** (resume quiz → upcoming deadline → flashcards → weak subject → reading plan → tasks; logic app.js:1620-1637), 4 stat tiles (streak, study sessions, quizzes, avg score), quick-launch tiles (Study Hub, Community, Challenge, Games, Tasks, CGPA, Library, All apps), today's plan/deadlines, daily-challenge banner, premium/recharge card (shown per school pricing), recent quiz results.
- **Navigation shell**: `partials/sidebar.ejs` (desktop), `partials/bottom-nav.ejs` (mobile), `partials/app-drawer.ejs` ("All apps" phone-style drawer), `drawer-trigger` partial reused on inner pages. Links: /dashboard, /study, /chat, /daily-challenge, /daily-task, /games, /cgpa, /library, /timetable, /reading-timetable, /deadlines, /history, /competition, /squads, /refer, /suggestions, /notifications, /profile, /guide, /upgrade, /logout.
- **Premium gating UX**: locked tiles show a lock badge; `requirePaid` redirects to `/dashboard?msg=Premium+feature...`; APIs return HTTP 402 with `premium_required: true`.
- **Community** `/chat` (chat.ejs, 1018 lines) with tabs: chats / friends / status / feed; thread view `chat-thread.ejs`; profiles `/u/:id`.
- **Study flow**: `/study` dashboard → `/study/course/:id` (topics/subtopics) → `/study/subtopic/:id` (AI lecture, ask, flashcards, quiz, YouTube) → `/study/quiz/:attemptId` → result; sessions via `/study/session/:id`.
- **Games**: hub + four full-page games with saved scores/history.
- **CGPA**: wizard → matrix of courses per level/semester → arc gauge, what-if panel, AI advisor, transcript export.
- **Admin UI**: `/admin/login` → `/admin/dashboard` with sidebar linking all admin modules (see §7).
- **PWA**: install banner partial + `/install` guide + offline fallback page.

---

## 4. Backend

**Server logic:** Single Express app; JSON/urlencoded bodies limited to 25 MB; static from `public/`; helmet with CSP **disabled** (`contentSecurityPolicy: false`, app.js:473-476); `trust proxy` set for Vercel. In-memory rate limiter keyed by IP+path (app.js:44-69) applied to login (10/min), signup (5/min), admin login (5/min), AI-heavy endpoints (12-20/min), payment verification (5/5min).

**Database:** Neon Postgres over SSL. ~60 tables referenced. Auto-created at boot: `student_materials`, `user_sessions`, `reading_timetables`, `reading_settings`, `login_streaks`, `personal_goals`, `daily_task_items`, `weekly_analytics`, `deadlines`, `payout_requests`, `user_groups(+members)`, `user_courses`, `study_*` (10 tables), `game_results`, `ai_courses`, `ai_questions`, `coupons`, `premium_settings`, `squads(+members,checkins)`, `friendships`, `pub_forms`, `pub_responses`, `payments`, `admin_quiz_*` (4), `app_config`, `daily_challenge_attempts`, `renaissance_*` (5), `library_*` (4), `conversations`, `conversation_members`, `chat_messages`, `status_posts`, `status_views`, `user_notifications`, `notification_reads`, `feed_posts`, `feed_likes`. **NOT auto-created** (must pre-exist in the production DB): `users`, `universities`, `subjects`, `questions`, `results`, `quiz_results`, `notifications`, `daily_leaderboard`, `login_history`, `page_views`, `cgpa_profiles`, `cgpa_courses`, `ambassadors` — a fresh deployment would fail without a manual schema (verified by grep: 0 `CREATE TABLE` statements for these).

**Authentication:** bcrypt (10 rounds); session cookie 24 h, `secure`+`sameSite:none` in production, Postgres store. Admin login uses `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars compared via SHA-256-hashed constant-time comparison (`safeEqual`, app.js:553-557) and creates a synthetic session `{id: 0, is_admin: true}`.

**APIs:** ~130 routes (full inventory extracted). JSON APIs under `/api/*` return 401 when unauthenticated (`isAuth` detects XHR/JSON). Question answers are never sent to the client for the bank quizzes (`/api/questions/:subject_id` selects only id/text/options, app.js:1417-1428); arena scoring is server-side (app.js:3924-3930).

**Integrations:** Paystack (verify + webhook + inline), Gmail SMTP, Gemini/Groq/Cerebras/OpenRouter/Mistral AI, LlamaParse, Unstructured.io, YouTube (external search links only), Google Fonts/FontAwesome/MathJax/TikZJax CDNs, Google Search Console verification file.

**Payments implementation (detailed):**
1. Client (`upgrade.ejs`) optionally validates a coupon via `/api/coupon/validate` (checks `used_coupon`, `has_paid`, active/max-uses/expiry; computes ₦ floor of 50), then opens Paystack inline with the (possibly discounted) amount.
2. Callback `GET /verify-payment?reference=...` re-verifies server-to-server with Paystack, rejects non-success and amounts < ₦50, marks `users.has_paid=true`, records the payment row (ON CONFLICT reference), increments coupon usage, credits 15% of `PREMIUM_PRICE` to the ambassador whose `unique_code` the user signed up with.
3. `POST /paystack-webhook` independently verifies HMAC-SHA512 signature, is idempotent (skips already-paid users), and performs the same credit/coupon/commission steps (app.js:402-464).
4. Admin can toggle any student's `has_paid` manually (`/admin/students/toggle-status/:id`).

---

## 5. AI Functionality

**Providers and fallback chains (all in app.js):**
- **Google Gemini** — `callGeminiWithImage` (gemini-2.5-flash, keys PRIMARY/SECONDARY, app.js:2812-2847) and `callGeminiWithText` (tries 2.0-flash → 2.5-flash → 1.5-flash per key, app.js:2850-2887).
- **Groq** — `groqPrompt` (fast: llama-3.1-8b-instant; smart: llama-3.3-70b-versatile → 8b, app.js:5315-5343) and `groqStream` (SSE streaming, app.js:5345-5387).
- **Cerebras** — `cerebrasPrompt` (llama-3.3-70b → llama-3.1-70b, app.js:5286-5313).
- **OpenRouter** — free models: gemma-3-27b-it, mistral-7b-instruct, gemini-2.0-flash-lite (app.js:5389-5418).
- **Mistral** — `mistral-small-latest` as fallback for Daily Challenge generation (app.js:3871-3887).
- **LlamaParse + Unstructured.io** — document parsing before Gemini for timetable extraction (app.js:2890-2972).
- Orchestrators: `studyPromptSmart` (Cerebras → Groq-smart → OpenRouter → Gemini), `studyPromptJSON` (JSON-mode with extraction fallback + Gemini), `studyPromptFast` (Groq-fast → Cerebras → OpenRouter), `studyPromptAI` (app.js:5420-5483). Output sanitation: `cleanAiText` (markdown stripping that protects LaTeX), `cleanLatex` ($…$ → \(…\)), `extractJsonItems` (app.js:5248-5443).

**AI-powered features (all verified server-side):**
1. Daily Challenge question generation (15 MCQs, JSON mode).
2. Study Hub: subtopic list generation; full lecture writer (very long structured prompt with LaTeX rules, app.js:6000-6045); follow-up Q&A; tutor chat (streams via Groq but is buffered and returned as JSON, app.js:6134-6147); flashcard generation; quiz generation (MCQ/theory/mixed with answer-letter normalization, app.js:6219-6249); session note summarization; YouTube query generation.
3. CGPA: AI next-semester prediction; AI what-if advice; AI academic-advisor chat with profile context.
4. Timetable extraction from images/PDFs/docs (with known-course matching context).
5. Admin: university name auto-completion (`/admin/universities/ai-suggest`, app.js:1325); admin quiz generator (AI course list per CCMAS/BMAS + AI question writing, app.js:4303-4396).
6. Dead helper: `renaissanceAIAnswer` (app.js:7172) — defined, never called (its routes were removed).

**Model list summary:** gemini-2.5-flash / 2.0-flash / 1.5-flash; llama-3.1-8b-instant; llama-3.3-70b(-versatile); gemma-3-27b-it; mistral-7b-instruct; gemini-2.0-flash-lite; mistral-small-latest.

---

## 6. User Plans (free vs premium)

**Entitlement model (verified):** single boolean `users.has_paid`. There are no plan tiers, no subscriptions, no trials — one-time "recharge" unlocks everything.

- **Free-school students:** `has_paid = true` automatically at signup (app.js:665-668).
- **Paid-school students:** must pay the school's `universities.price` (falls back to global `premium_settings.recharge_price`, default `PREMIUM_PRICE` env or ₦2000) — enforced by `requirePaid` (app.js:516-540) and per-feature `featureLock(key)` (app.js:911-932, fails closed with 503 on DB error).
- **Legacy migration:** `/migrate-premium` grants free premium once (`migrated_free`); admin can lock migrated users out (`migrated_locked`) globally or restore them (app.js:817-979).

**Free tier (verified by middleware absence):** dashboard, notifications, subjects library + materials upload, daily challenge/arena, daily task planner, squads, games + XP, community (friends/chat/status/feed/profiles), suggestions/support, guide, library contributions.

**Premium tier:** Study Hub & AI (key `study`), Timetable (`timetable`), Reading Schedule (`reading`), CGPA Tracker (`cgpa`), AI Quiz Generator (`ai_quiz` — *currently dead, see §8*), History & Stats (`history`), Live Arena (`competition`), Deadlines (`deadlines`). Keys defined in `PREMIUM_FEATURES` (app.js:861-870); lockable globally (premium_settings) and per-school (universities.locked_features). The `/upgrade` page comparison table (upgrade.ejs:334-347) matches this split. Note: `/deadlines` GET is gated by `featureLock` only, while `POST /deadlines/add` separately checks `has_paid` (app.js:2247) — slight inconsistency.

---

## 7. Admin System

Separate credential login at `/admin/login` (env-based, rate-limited, constant-time compare). All admin routes guarded by `isAdmin` (session flag) or the local `isAdminQuiz` variant.

| Module | Routes | What it does |
|---|---|---|
| Dashboard | `/admin/dashboard` | KPIs (universities, students, premium, subjects, questions), 5 recent signups, login-notice editor |
| Universities | `/admin/universities(+add/config/ai-suggest)` | CRUD schools; set paid/free, price, locked features; AI name+slug suggestion |
| Students | `/admin/students(+toggle-status)` | Search/filter by school, premium/basic stats, toggle `has_paid` |
| Users | `/admin/users` | Simple list — **broken** (queries non-existent `username` column; see §8) |
| Coupons | `/admin/coupons*` | Create percent/fixed coupons, max uses, expiry, toggle, delete |
| Migrations | `/admin/migrations*` | List migrated users, lock/unlock, set recharge price + global locked features |
| Notifications | `/admin/notifications*` | Global announcements |
| Email | `/admin/email(+send)` | Bulk HTML email filtered by university / tier / group via Gmail SMTP (sequential send) |
| Groups | `/admin/groups*` | User groups + membership for targeted email |
| Ambassadors | `/admin/ambassadors`, `/admin/add-ambassador`, `/admin/payout-complete/:id` | Referral ledger, manual ambassadors, mark payouts |
| Withdrawals | `/admin/withdrawals(+update)` | Approve/complete/reject payout requests |
| Daily | `/admin/daily` | Arena leaderboard view, today's attempt count |
| Analytics | `/admin/analytics` | 7/30/90-day suite: totals, signup trend, most-active users, per-exam stats, hardest questions, weakest subjects, page traffic, coupon usage, revenue, today actives, streak leaders, arena top, signups per university |
| DB Manager | `/admin/db-manager*` | Table browser, row editor (identifier-sanitized), read-only SQL console (regex-blocked keywords; gated by `DB_MANAGER_PIN`+`DB_MANAGER_PASS`, disabled unless both set) |
| Suggestions | `/admin/suggestions*` | Support-chat threads with students, close/reopen |
| Library | `/admin/library*` | Verify/unverify/delete community resources |
| Forms | `/admin/forms*` | Public form builder (NAPS-style score collectors), responses viewer, Excel export |
| Quiz generator | `/admin/quiz-generator`, `/api/admin/quiz/*` | AI-generate course lists per university/level, approve courses, AI-generate questions, publish session |
| Login notice | `/admin/notice` | Global message + link shown on login page and dashboard |

---

## 8. Technical Status (evidence-based)

### 8.1 Removed-but-still-referenced feature set (most significant finding)
Commit `085f980` ("Add community feed, per-user notifications, calls, redesign dashboard and app drawer") deleted the routes for the **CBT practice quiz engine, the AI Quiz Generator, and the Renaissance mock-exam system** from `app.js`, but left everything else behind:

- **Orphaned views (14, never rendered):** `quiz-lobby`, `quiz-page`, `quiz-result`, `quiz-locked`, `setup-test`, `ai-quiz`, `renaissance`, `renaissance-exam`, `renaissance-result`, `admin/renaissance`, `admin/renaissance-print`, `ambassador-dashboard`, `ambassador-login`, `be-ambassador` (verified by diffing every `res.render()` target against `views/`).
- **Deleted routes (verified via `git diff 1ee4d73 085f980 -- app.js`):** `GET /setup-test`, `GET /ai-quiz`, `GET /renaissance`, `GET /renaissance/exam/:id`, `POST /renaissance/exam/:id/submit`, `GET /renaissance/result/:attemptId`, `GET /admin/renaissance`, `GET /admin/renaissance/.../print`, plus the quiz-flow and `/generate-ai-quiz`, `/save-ai-quiz-results`, `/api/ai-quiz/history` endpoints.
- **Broken inbound links (404s):** `views/subjects-library.ejs:272` → `/setup-test`; `views/how-it-works.ejs:243` → `/setup-test`; `views/admin/dashboard.ejs:537` → `/admin/renaissance`; `views/quiz-lobby.ejs:61` posts to `/live-exam`; `views/ai-quiz.ejs` fetches `/generate-ai-quiz`, `/save-ai-quiz-results`, `/api/ai-quiz/history`.
- **Dead backend code kept:** `renaissanceAIAnswer` (app.js:7172) and `getRenaissanceSetting` (app.js:7163) — defined, zero call sites; `renaissance_*` tables still created at boot and still queried by admin analytics (app.js:3973-4057); `ai_courses`/`ai_questions` tables still created (app.js:6879).
- **Dead endpoint:** `POST /upload-pdf` (app.js:4663) — its only consumer was the orphaned `ai-quiz.ejs`; no view references it anymore.
- **Docs drift:** README §Features still advertises CBT practice quizzes, the AI Quiz Generator, and Renaissance mock exams as live features; the `/upgrade` page still advertises "PDF-to-Quiz Generator" as a premium benefit.

### 8.2 Other verified issues
1. **`/admin/users` is broken:** queries `SELECT id, username, email … FROM users` (app.js:1457) but the users table uses `fullname` everywhere else; the catch clause silently redirects to the dashboard.
2. **Schema drift on `users`:** `/dashboard` selects `current_streak, quiz_attempts` from `users` (app.js:1520-1523) although streaks live in `login_streaks`; these columns are never created by the codebase — either they exist only in the production DB (unverifiable from the repo) or the dashboard errors into its catch → `/login` redirect.
3. **Core tables not bootstrapped:** `users`, `universities`, `subjects`, `questions`, `results`, `quiz_results`, `notifications`, `daily_leaderboard`, `login_history`, `page_views`, `cgpa_profiles`, `cgpa_courses`, `ambassadors` have no `CREATE TABLE` in the repo — fresh deployments require a manual/unknown migration (no migration files exist in the repo).
4. **Dead tables:** `weekly_analytics` (created app.js:250, never read/written) and `student_quiz_attempts` (created app.js:7065, never used by any route — the admin quiz generator "publishes" sessions but nothing student-facing consumes them).
5. **Stub endpoint:** `POST /auth/forgot-password` (app.js:4255) returns a fake success without doing anything, duplicating the real `POST /forgot-password`.
6. **Duplicated logic:** second nodemailer transport created inside `/admin/email/send` (app.js:2082) despite the global `transporter`; two global error handlers (app.js:6861 and 8520) — the first only covers routes registered above it; CGPA/degree-class computation duplicated in three places (`buildCGPA` app.js:4685, forecast app.js:6406, transcript app.js:6577/6622).
7. **Minor inconsistencies:** upload limit is 25 MB (app.js:33) but the error handler reports "Maximum size is 100MB" (app.js:6865); README says the daily challenge is "10-question" while the code generates 15 (app.js:3847-3892); `APP_URL` appears in README's env example but is never read by the code; `cookie-signature` (app.js:8532) is used directly but only declared as a transitive dependency; unused `const config = { maxDuration: 60 }` (app.js:6875).
8. **Serverless caveats (acknowledged in code):** in-memory rate limiting, `notifiedDeadlines` set, and all background jobs are per-instance and skipped on Vercel — deadline email reminders and the weekly leaderboard reset effectively do not run on the production serverless deployment; Socket.IO falls back to polling via the mounted engine (app.js:8504-8509) and WebRTC calls depend on it.
9. **Security-relevant observations (factual, not exploits):** account deletion is performed by a GET link (`/auth/delete-account`); helmet ships with CSP disabled; the DB-manager SQL console allows arbitrary single SELECT statements (regex-guarded); admin session uses synthetic `id: 0`.
10. **Stray artifacts:** `session-ses_e16a.md` (1 MB AI session log), `converted (1).md` (byte-identical duplicate of `Platform.md`), `public/uploads/podcasts/*.mp3` (5 files with no podcast routes anywhere), `renaissance-import-template.tex` (instructions for the removed admin importer), `public/roadmap.html` (internal checklist page served statically).

### 8.3 Explicitly unverifiable
- Actual contents/schema of the production database (columns like `users.username`, `users.current_streak`, `users.quiz_attempts`).
- Whether the deployed Vercel app exhibits the same 404s (code says it must, but the live deployment was not tested).
- Runtime behavior of AI providers (keys not present in the repo; no secrets are committed — `.env` is gitignored and no keys were found in tracked files).

---

## 9. Dependencies & Deployment

**Runtime dependencies (package.json):** express, ejs, pg, connect-pg-simple, express-session, bcryptjs, helmet, multer, nodemailer, dotenv, pdf-parse, pdfkit, exceljs, socket.io. All are used in `app.js` except that `cookie-signature` is required without being a direct dependency. No frontend build step; no test suite beyond `node --check app.js` (`npm run check`).

**Environment variables (all referenced in app.js; values are NOT in the repo):**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection (required) |
| `SESSION_SECRET` | Session signing (falls back to ephemeral random with a warning) |
| `NODE_ENV`, `PORT`, `VERCEL` | Runtime mode / port / serverless flag |
| `PREMIUM_PRICE` | Default premium price in naira (default 2000) |
| `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_SECRET_KEY` | Checkout popup + server verification/webhook |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Admin panel credentials |
| `EMAIL_USER`, `EMAIL_PASS` | Gmail SMTP for resets, deadline alerts, bulk email |
| `GEMINI_API_KEY_PRIMARY`, `GEMINI_API_KEY_SECONDARY` | Gemini vision/text |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` | LLM fallback chain |
| `LLAMAPARSE_API_KEY`, `UNSTRUCTURED_API_KEY` | Document parsing (optional) |
| `DB_MANAGER_PIN`, `DB_MANAGER_PASS` | Admin DB manager gate (optional; disabled if unset) |

**Deployment:** Vercel (`vercel.json` builds `app.js` with `@vercel/node`, all routes → app). Serverless constraints handled in code: memory-storage uploads persisted to Postgres BYTEA, background intervals skipped when `VERCEL=1`, Socket.IO engine mounted on the Express app for polling, Socket.IO client served from a resolved filesystem path (app.js:8478-8499). For full functionality (realtime chat/calls, deadline emails, leaderboard reset) the README notes a long-lived server is needed. Local dev: `npm install && npm start` (port 3000) with a `.env`.

**External services:** Neon Postgres, Paystack, Gmail, Google Gemini, Groq, Cerebras, OpenRouter, Mistral, LlamaParse, Unstructured, CDNs (Font Awesome, SweetAlert2, Google Fonts, MathJax, TikZJax).

---

## 10. Complete Feature Inventory

**Live & verified (route + view + DB path all present):**
1. Signup/login/logout/password reset/account deletion; login streaks
2. Student profile with aggregated stats
3. School-based premium (free/paid schools, per-school price & locked features)
4. Paystack one-time payment (inline + webhook + coupons + ₦50 floor)
5. Coupon system (admin CRUD + client validation)
6. Premium migration (one-time free unlock + admin lock/unlock)
7. Refer & Earn for paid schools (codes, 15% commission, withdrawals with 10% fee, admin payout queue)
8. Subjects library per university + personal study-material uploads (BYTEA)
9. Daily Challenge Arena (AI 15-Q daily, server scoring, monthly leaderboard, weekly reset job)
10. Study Hub: courses/topics/subtopics, AI subtopics, AI lectures (LaTeX/Mermaid), AI Q&A, AI tutor chat, AI flashcards, AI quizzes (MCQ/theory/mixed) with resume, study sessions with AI summaries, YouTube suggestions, timetable import, CGPA sync, JSON export
11. CGPA Tracker: profiles (4/5-scale), courses CRUD, CSV import/export, hide/show, what-if (single/bulk), scenario forecast, AI prediction, AI advisor chat, transcript JSON + branded PDF
12. Class timetable (manual + AI extraction from image/PDF/doc)
13. AI Reading Schedule (algorithmic generator + settings)
14. Deadline tracker + email reminder job
15. Daily Task dashboard (goals, tick-box tasks, auto-generation, weekly report API)
16. Games Hub: Sudoku, Word Scramble, Chess vs AI, Crossword; XP/levels; saved results & history; friends leaderboard
17. Community: friends (search/request/accept/remove), direct & group chat (text/image/voice, receipts, typing), WebRTC audio/video call signaling, status stories (24 h), feed with likes, public profiles, per-user notifications
18. Squads (check-ins + squad streaks)
19. Public Course Library (university→faculty→department→course→resources, search, community contributions, admin verification, UI seed script)
20. Support threads (/suggestions) with admin replies
21. Public score-collection forms (builder, responses, Excel export)
22. PWA (manifest, service worker, offline page, install page/banner), SEO suite (sitemap, robots, OG, page-view analytics)
23. Full admin panel (18 modules listed in §7) incl. DB Manager, Analytics, Email blasts, Groups, Login notice
24. Admin AI quiz generator (course/question generation + publish — backend complete, no student consumer)

**Present in repo but NOT reachable (orphaned after commit `085f980`):**
25. CBT practice quiz flow (`/setup-test`, quiz-lobby/page/result/locked views, `/live-exam`)
26. AI Quiz Generator user flow (`/ai-quiz`, `/generate-ai-quiz`, `/save-ai-quiz-results`, `/api/ai-quiz/history`, `/upload-pdf`)
27. Renaissance mock-exam system (student + admin, LaTeX/TikZJax rendering, print view, import template)
28. Legacy ambassador pages (`be-ambassador`, `ambassador-login`, `ambassador-dashboard`)

**Dead artifacts:** `weekly_analytics` & `student_quiz_attempts` tables, `renaissanceAIAnswer`/`getRenaissanceSetting` helpers, unused `config` const, `POST /auth/forgot-password` stub, podcast mp3 files, `converted (1).md`, session log.

---

*End of report. All claims are traceable to the cited files/lines; items marked unverifiable could not be confirmed from the repository alone.*
