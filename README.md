# Prepium — Smart Exam Mastery Platform

> The ultimate CBT practice engine for ambitious students. Continuous Assessment Portal built for Nigerian universities.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-ISC-lightgrey)

---

## Features

| Feature | Description |
|---------|-------------|
| **Practice Quiz** | Timed CBT exams with real-time scoring and LaTeX formula support |
| **AI Quiz Bot** | Upload PDFs — AI parses them into full CBT exam sets |
| **Daily Challenge** | Compete live with peers on daily questions |
| **Study Library** | Course notebooks and structural references |
| **CGPA Tracker** | Target calculation and performance analytics |
| **Deadline Tracker** | Track assignment and exam milestones |
| **Pomodoro Timer** | Structured focus sessions with break management |
| **Live Arena** | Real-time scoreboards and ranking panels |
| **Competition Mode** | Head-to-head quiz battles |
| **Student Dashboard** | Personalized greeting, live clock, motivational quotes |
| **Admin Console** | Full user, question, and analytics management |
| **Ambassador Portal** | Referral system with commission tracking |

### Premium (₦1,000 one-time)

Unlocks AI Quiz, CGPA Tracker, Study Library, Live Arena, Pomodoro, and Competition mode.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 |
| Frontend | EJS + CSS3 (glassmorphism, canvas animations) |
| Database | PostgreSQL (Neon Serverless) |
| Auth | bcryptjs + express-session |
| AI | Google Gemini API |
| Payments | Paystack |
| Email | Nodemailer |
| Animations | Custom Canvas API (Framer-like flowing lines, particles, cursor glow) |

---

## Quick Start

```bash
git clone https://github.com/Alitedigitals2007/prepium.git
cd prepium
npm install
```

Create a `.env` file:

```env
DATABASE_URL=postgresql://...
PAYSTACK_PUBLIC_KEY=pk_live_...
PAYSTACK_SECRET_KEY=sk_live_...
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

## Pitch to Schools

> **One Platform. Every Department. Zero Paper.**

Dear Administrator,

Prepium transforms how your students prepare for Continuous Assessment Tests. Instead of scattered PDFs and manual grading, Prepium delivers:

- **Unified question bank** across all departments
- **Auto-graded CBT exams** with instant results
- **Performance analytics** per student, per subject, per session
- **AI-powered quiz generation** from your existing lecture PDFs
- **No infrastructure cost** — works on any phone with a browser

Prepium is already trusted by students at **UI, UNILAG, OAU, Babcock University, FUNAAB, FUTA, FUTO, and LeadCity University**.

**Get a custom school portal**: branded subdomain, dedicated question banks, admin dashboard for your HoDs, and bulk student upload.

> *"Strategic analytics helped me see exactly where I was failing. My scores jumped by 30%."* — Daniel O., Pharmacy

📧 **Partnership inquiries**: [michaelbrainny842@gmail.com](mailto:michaelbrainny842@gmail.com)

---

## Pitch to Students

> **Stop cramming. Start mastering.**

**Prepium** is the all-in-one exam prep platform built for the Nigerian university experience.

**Why students love Prepium:**

- **Practice like the real exam** — timed CBT sessions with actual question formats
- **AI that reads your PDFs** — upload any lecture note and get instant practice questions
- **Track your CGPA** — know exactly what grade you need to hit your target
- **Stay on schedule** — deadline tracker + pomodoro focus timer
- **Compete & win** — daily challenges and live arena rankings
- **Just ₦1,000 once** — no monthly subscriptions, no hidden fees

Works on any phone, any network. No app download needed.

> *"The LaTeX support for physics formulas is perfect. Finally, a platform that understands my curriculum!"* — Stephanie A., Physics Dept.

👉 **[Create your free account](https://prepium.com/signup)** — start with 2 free quizzes, no card required.

---

## Pitch to Ambassadors

> **Earn commissions while helping your classmates level up.**

**How it works:**

1. Sign up as a Prepium Ambassador
2. Share your unique referral code with friends and coursemates
3. Earn **₦200 per Premium sale** — paid directly to your bank account
4. Track your earnings, referrals, and withdrawals from your Ambassador Dashboard

**Who makes a great ambassador?**

- Class representatives and course reps
- Departmental association leaders
- Anyone active on campus WhatsApp/Twitter/Telegram groups
- Tech-savvy students who love helping others

**What you get:**

- Personalized referral dashboard
- Commission tracking in real-time
- Verified ambassador certificate
- Early access to new features
- Direct line to the Prepium team

> *"Being a Prepium ambassador helped me earn while adding real value to my department. Win-win."*

👉 **[Apply to be an Ambassador](https://prepium.com/be-ambassador)**

---

## DM Message Templates

### To a Student (Individual)

> Hey [Name]! 👋
>
> Are you prepping for your upcoming tests? I'm using Prepium — it's a CBT practice platform built for Nigerian uni students. You can take timed quizzes, upload PDFs and let AI generate questions, track your CGPA, and even compete with friends.
>
> It's just ₦1,000 **one-time** (no subscription). Wanna give it a shot? I can send you the link 🔗

### To a Class/Department Group

> 📢 *Study smarter, not harder.*
>
> Hey everyone! I just found this platform called **Prepium** — it's designed for Nigerian university students. You can:
> • Practice CBT exams with actual question formats
> • Upload your lecture PDFs and get AI-generated quiz questions
> • Track your CGPA and set grade targets
> • Compete on the daily challenge leaderboard
>
> All for **₦1,000 once** — no monthly fees.
>
> Check it out: [prepium.com](https://prepium.com)
>
> Use my code **PREP-XXXX** when you sign up 🚀

### To a School Department/SRC

> Good day Sir/Ma,
>
> I'd like to introduce **Prepium** — a Continuous Assessment Test (CBT) preparation platform designed specifically for Nigerian university students.
>
> Prepium offers:
> • Auto-graded practice quizzes across all departments
> • AI-powered question generation from PDF lecture notes
> • Student performance analytics per subject
> • No infrastructure cost — works on any phone
>
> We currently serve students at UI, UNILAG, OAU, Babcock, FUNAAB, FUTA, FUTO, and LeadCity University.
>
> Would you be open to a brief discussion about how Prepium can support your department's academic preparation?

### Ambassador Recruitment (to a potential ambassador)

> Hey [Name]! 👋
>
> I'm looking for campus ambassadors for **Prepium** — a CBT exam prep platform for Nigerian uni students.
>
> As an ambassador, you get:
> • ₦200 commission per premium referral
> • Personalized dashboard to track your earnings
> • Verified ambassador certificate
>
> If you're active on campus and love helping people, this is perfect. Interested? Check it out: [prepium.com/be-ambassador](https://prepium.com/be-ambassador)

### Follow-up / Reminder

> Hey [Name]! Just a quick reminder about Prepium — your free 2 quizzes are waiting. If you like it, Premium is just ₦1,000 once and unlocks everything forever. Let me know if you have any questions! 🤝

---

## Links

- **Live App**: [https://prepium.com](https://prepium.com)
- **Sign Up**: [https://prepium.com/signup](https://prepium.com/signup)
- **Become an Ambassador**: [https://prepium.com/be-ambassador](https://prepium.com/be-ambassador)
- **Email**: [michaelbrainny842@gmail.com](mailto:michaelbrainny842@gmail.com)

---

*Built with ❤️ for Nigerian students.*
