# Prepium — AI-Powered Study Companion for Nigerian Students

Prepium is an all-in-one learning platform built for Nigerian university students: CBT practice, AI-generated quizzes from your own lecture notes, a study hub with an AI tutor, CGPA tracking with an AI advisor, timetables, daily challenges, live competition arena, and timed mock exams with LaTeX/TikZ diagrams.

**Live App**: https://theprepium.vercel.app

---

## Features

### Learning & Practice
- **Practice Quizzes (CBT)** — pick subjects, difficulty, and question count. Instant grading with explanations.
- **AI Quiz Generator** — upload any PDF lecture note; AI creates multiple-choice, theory, and fill-in-the-blank questions from that exact material.
- **Daily Challenge** — free daily 10-question challenge with a weekly leaderboard.
- **Competition Arena** — real-time rankings across students.

### Mock Exams (Renaissance)
- Timed mock exams with a question editor that supports **LaTeX and TikZ (circuitikz)** diagrams, imported from images/PDFs.
- One-by-one review screen after each attempt: every option highlighted correct/wrong, verdicts, and theory explanations.
- Per-attempt results history from your dashboard.

### Study Hub
- Courses, topics, and subtopics with an **AI tutor chat**, flashcards, topic quizzes, Pomodoro study timer, YouTube search, and CGPA sync.

### CGPA Tracker
- 4- or 5-point scale, per-course logging by level and semester.
- **What-If Builder** (add hypothetical courses to see combined CGPA impact) and **AI next-semester prediction**.
- **Transcript export as PDF** (official-style document with semester tables, SGPA, classification, and reference number).

### Productivity
- **Timetable** with AI extraction from images/PDFs; **AI Reading Schedule**; **Deadline tracker** with email reminders; **Daily Task dashboard**.

### School-Based Premium Model
- Admin marks each university as a **free school** (students get premium automatically) or a **paid school** (students must pay the school's price to unlock premium).
- Per-school **price** and **locked features** are fully configurable by the admin.
- **Refer & Earn** is available to students from paid schools — refer friends and earn real money (withdrawal via admin-approved payouts).

### Admin Panel (`/admin`)
- Dashboard with live KPI analytics: revenue, most active users, hardest questions, per-exam stats, weakest subjects, page traffic, and more.
- **University management** with AI-assisted school-name entry (type a hint, AI completes the official name + slug).
- Coupon system, free-migration management, email blasts, user groups, student management, DB manager, and a customizable **login notice** shown to every user (message + clickable link).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Frontend | EJS + CSS3 (glassmorphism, motion-design intro animations) |
| Database | PostgreSQL (Neon Serverless) |
| Auth | bcryptjs + express-session (Postgres sessions) |
| AI | Google Gemini API (2.5-flash / 2.0-flash) |
| Payments | Paystack (with coupon discounts) |
| Email | Nodemailer |
| PDFs | pdfkit (official transcript generation) |
| Diagrams | TikZJax (LaTeX/circuitikz in mock exams) |

---

## Getting Started

1. **Sign up** at https://theprepium.vercel.app/signup
2. Pick your university — if it's a free school, every feature unlocks automatically. Paid schools require a one-time premium payment (price set by your school).
3. **Explore** — use the in-app **User Guide** (/guide) for a full walkthrough.

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
PAYSTACK_PUBLIC_KEY=...
PAYSTACK_SECRET_KEY=...
APP_URL=http://localhost:3000
```

```bash
node app.js
# → http://localhost:3000
```

---

## Admin Access

- Login at `/admin-login`, then manage everything from `/admin/dashboard`.
- **Universities** → set each school to paid/free, its premium price, and locked features (with AI-assisted name entry).
- **Login Notice** → publish a global message + link that all users see on the login page and dashboard.

---

## Questions?

**Email**: michaelbrainny842@gmail.com
**In-app Guide**: /guide (after login)

---

*Built for Nigerian students, by Nigerian developers.*