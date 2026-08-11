# Prepium — Your AI-Powered Study Companion

Stop juggling WhatsApp groups, USB drives, and photocopy shops. Prepium puts everything you need in one app on your phone.

**Live App**: https://theprepium.vercel.app

---

## Features

| Feature | Free |
|---------|------|
| Practice Quizzes (CBT) | ✅ Unlimited |
| AI Quiz Generator (from PDF) | ✅ |
| Study Hub (AI tutor, flashcards, quizzes, Pomodoro) | ✅ |
| CGPA Tracker & AI Advisor (what-if, predict, chat) | ✅ |
| School Timetable (with AI image extraction) | ✅ |
| AI Reading Schedule | ✅ |
| Deadline Tracker (email reminders) | ✅ |
| Daily Task Dashboard | ✅ |
| History & Analytics | ✅ |
| Daily Challenge (Leaderboard) | ✅ |
| Competition Arena | ✅ |
| Feedback / Suggestions | ✅ |

### All Features Free

Every account that registers **automatically gets full access to all features** — unlimited quizzes, AI tutor, AI quiz generator, CGPA tracker, study library, timetables, live arena, and competition mode. **No payment required. No paywall. No subscriptions.**

---

## What You Can Do

### AI Quiz Generator
Upload any PDF lecture note → AI creates custom multiple-choice, theory, and fill-in-the-blank questions from that exact material.

### Study Hub
Create courses, chat with an AI tutor, generate flashcards, take topic-specific quizzes, track study time with a Pomodoro timer.

### CGPA Tracker
Set up your profile (4 or 5-point scale), add courses, see real-time CGPA. Use the **What-If Builder** to add multiple hypothetical courses and see their combined impact. AI predicts your next semester GPA.

### Practice Quizzes
Pick subjects, difficulty, and number of questions. Instant grading with explanations.

### Daily Challenge
Free daily 10-question challenge with leaderboard (resets weekly).

### Timetable & Reading Schedule
AI generates weekly schedules from your courses and available hours. Timetable supports AI extraction from images/PDFs.

### Deadlines
Track assignments/exams with email reminders 1 hour before.

### Daily Task Dashboard
Tasks, goals, deadlines, and weekly reports in one place.

### Admin Panel
Full admin suite: student management, university management, coupon system, email blasts, user groups, withdrawal processing, analytics dashboard, AI quiz generator for exams, and database manager.

---

## Getting Started

1. **Sign up** at https://theprepium.vercel.app/signup
2. **All features are unlocked automatically** — no payment needed
3. **Explore** — use the [User Guide](https://theprepium.vercel.app/guide) inside the app for a full walkthrough of every feature

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Frontend | EJS + CSS3 (glassmorphism, canvas animations) |
| Database | PostgreSQL (Neon Serverless) |
| Auth | bcryptjs + express-session |
| AI | Google Gemini API |
| Email | Nodemailer |
| Animations | Custom Canvas API (Framer-like flowing lines, particles, cursor glow) |

---

## Development Setup

```bash
git clone https://github.com/Alitedigitals2007/prepium.git
cd prepium
npm install
```

Create a `.env` file:

```env
DATABASE_URL=postgresql://...
GEMINI_API_KEY_PRIMARY=...
GEMINI_API_KEY_SECONDARY=...
EMAIL_USER=your@email.com
EMAIL_PASS=your-app-password
APP_URL=http://localhost:3000
```

```bash
node app.js
# → http://localhost:3000
```

---

## Questions?

**Email**: michaelbrainny842@gmail.com
**In-app Guide**: /guide (after login)

---

*Built for Nigerian students, by Nigerian developers.*
