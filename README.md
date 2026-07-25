# Prepium — Smart Exam Mastery Platform

CBT practice engine for Nigerian university students.

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-ISC-lightgrey)

---

## Features

| Feature | Description |
|---------|-------------|
| **Practice Quiz** | Timed CBT exams with real-time scoring and LaTeX formulas |
| **Quiz Generator** | Upload any PDF — AI parses it into a full CBT question set |
| **Daily Challenge** | Compete live with peers on 10 daily questions |
| **Study Hub** | Courses, topics, AI‑generated explanations, flashcards, quizzes, YouTube search, AI tutor chat (streaming) |
| **Timetable AI** | Upload timetable PDF/image — auto‑extracts courses with AI |
| **Reading Schedule** | AI‑generated weekly study plan based on your courses |
| **CGPA Tracker** | Target calculator, what‑if analysis, AI advisor chatbot |
| **Deadline Tracker** | Assignment/exam milestones with push notifications |
| **Pomodoro Timer** | Focused study sessions with history tracking |
| **Live Arena** | Real‑time scoreboards and ranking panels |
| **Competition Mode** | Head‑to‑head quiz battles |
| **Student Dashboard** | Personalized greeting, live clock, motivational quotes, stats |
| **Referral Program** | 15% commission per referral (₦300 per premium activation) |
| **Admin Console** | Full user, question, subject, and analytics management |
| **Ambassador Portal** | Referral system with commission tracking and withdrawals |

### Premium (₦2,000 one‑time)

Unlocks Quiz Generator, CGPA Tracker, Study Hub, Timetable, Reading Schedule, Live Arena, Pomodoro, and Competition mode.

---

## AI Engine

| Provider | Model | Use | Speed |
|----------|-------|-----|-------|
| **Cerebras** | Llama 3.3‑70B / Llama 3.1‑70B | Long content, quiz generation, summaries | ~700 ms – 1.5 s |
| **Groq** | Llama 3.1‑8B‑Instant (fast), Llama 3.3‑70B‑Versatile (smart) | Chat, flashcards, explanations, advice | ~150–700 ms |
| **Groq (streaming)** | Llama 3.1‑8B‑Instant | AI Tutor chat — streaming SSE | First token < 300 ms |
| **OpenRouter (fallback)** | Gemma 3‑27B‑it free | Last‑resort fallback if above keys absent | ~2–5 s |

All study‑hub AI routes (flashcards, quiz generation, content generation, chat, advice, YouTube search) route through a priority chain: **Groq fast → Cerebras 70B → Groq smart → OpenRouter**.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 |
| Frontend | EJS + CSS3 (glassmorphism, CSS animations, MathJax LaTeX) |
| Database | PostgreSQL (Neon Serverless) |
| Auth | bcryptjs + express‑session |
| AI | Cerebras, Groq, Google Gemini, Mistral, OpenRouter |
| PDF | pdf‑to‑text, LlamaParse, Unstructured.io |
| Payments | Paystack |
| Email | Nodemailer |
| PWA | manifest.json + Service Worker |

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
CEREBRAS_API_KEY=csk-...
GROQ_API_KEY=gsk-...
GEMINI_API_KEY_PRIMARY=...
GEMINI_API_KEY_SECONDARY=...
OPENROUTER_API_KEY=...
MISTRAL_API_KEY=...
LLAMAPARSE_API_KEY=...      # optional, improves PDF extraction
UNSTRUCTURED_API_KEY=...    # optional, improves DOCX/PPTX extraction
EMAIL_USER=your@email.com
EMAIL_PASS=your-app-password
APP_URL=http://localhost:3000
```

```bash
node app.js
# → http://localhost:3000
```

### Obtaining API keys (free tier)

| Provider | Sign‑up | Free limit |
|----------|---------|------------|
| **Cerebras** | cloud.cerebras.ai | 30 RPM, no card |
| **Groq** | console.groq.com | 30 RPM, no card |
| **Gemini** | aistudio.google.com | 15 RPM, 1,500 req/day |
| **OpenRouter** | openrouter.ai | varies per model |

---

## API Keys Used

| Env var | Used by | Purpose |
|---------|---------|---------|
| `CEREBRAS_API_KEY` | `cerebrasPrompt()` | Long‑form AI content, quiz generation |
| `GROQ_API_KEY` | `groqPrompt()`, `groqStream()` | Chat, flashcards, explanations, streaming chat |
| `GEMINI_API_KEY_PRIMARY` | `callGeminiWithImage/Text()`, daily challenge | Timetable AI extraction, daily question gen |
| `GEMINI_API_KEY_SECONDARY` | Same (failover) | Fallback for Gemini |
| `OPENROUTER_API_KEY` | `openRouterPrompt()` | Last‑resort fallback AI |
| `MISTRAL_API_KEY` | `generateDailyChallengeQuestions()` | Daily challenge fallback |
| `LLAMAPARSE_API_KEY` | `callLlamaParse()` | Optional PDF text extraction (higher quality) |
| `UNSTRUCTURED_API_KEY` | `callUnstructured()` | Optional DOCX/PPTX text extraction |

---

## Dashboard

- **Stats row**: Quizzes done, Avg score, Study sessions, AI Quizzes (history from `/api/ai-quiz/history`)
- **Quick actions**: Daily Task, History, Challenge
- **Feature grid**: Quiz Generator (name changed from "AI Test"), Study with AI, Practice Quiz, Timetable, Reading Schedule, CGPA Tracker, Deadlines, Daily Challenge, Live Arena, Feedback

---

## Pitch to Schools

> **One Platform. Every Department. Zero Paper.**

Prepium delivers:
- Unified question bank across all departments
- Auto‑graded CBT exams with instant results
- Performance analytics per student, per subject, per session
- AI‑powered quiz generation from your existing lecture PDFs
- No infrastructure cost — works on any phone with a browser

Trusted by students at UI, UNILAG, OAU, Babcock, FUNAAB, FUTA, FUTO, and LeadCity University.

📧 **Partnership inquiries**: [michaelbrainny842@gmail.com](mailto:michaelbrainny842@gmail.com)

---

## Pitch to Students

> **Stop cramming. Start mastering.**

- Practice like the real exam — timed CBT with actual question formats
- AI that reads your PDFs — upload any lecture note and get instant questions
- Track your CGPA — know exactly what grade you need
- AI Tutor chat with streaming responses — ask questions about any subtopic
- Flashcards, quizzes, explanations generated by AI
- Compete & win — daily challenges and live arena rankings
- **Just ₦2,000 once** — no subscriptions, no hidden fees

---

## Links

- **Live App**: [https://prepium.com](https://prepium.com)
- **Sign Up**: [https://prepium.com/signup](https://prepium.com/signup)
- **Email**: [michaelbrainny842@gmail.com](mailto:michaelbrainny842@gmail.com)

---

*Built for Nigerian students.*
