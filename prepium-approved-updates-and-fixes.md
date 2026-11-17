# Prepium --- Approved Updates and Fixes

**Date:** 17 November 2026\
**Project:** Prepium\
**Repository:** https://github.com/Alitedigitals2007/prepium\
**Status:** Scope approved and locked

## 1. Purpose

This document records the approved Prepium development direction and the
specific codebase fixes identified for implementation. The existing
application must be improved incrementally. Do not rebuild the platform
from scratch or introduce duplicate features where existing
functionality can be extended.

## 2. Approved product scope

The goal is to make Prepium a complete university-student companion that
remains useful during academic sessions and holidays.

### Existing areas to improve

-   Dashboard and student command centre
-   Study Hub, AI tutor, lessons, flashcards and quizzes
-   CGPA tracker and academic records
-   Timetable, reading schedule, tasks and deadlines
-   Course Library and study materials
-   Daily Challenge and Games Hub
-   Community, messaging, squads and calling
-   Notifications, payments and administration

### Approved additions

1.  **Personal Academic Intelligence**
    -   Use the student's courses, academic activity, assessment
        results, CGPA records, timetable and goals.
    -   Identify topic strengths and areas needing attention when enough
        data exists.
    -   Recommend revision, study priorities and editable daily or
        weekly plans.
    -   Clearly distinguish insufficient data from poor performance.
    -   Do not invent grades or academic results.
2.  **Prepium Wrapped**
    -   Weekly, semester and annual learning summaries.
    -   Include verified activity, improvements, courses, topics,
        skills, projects, XP and achievements.
    -   Provide shareable cards with privacy controls.
    -   Never automatically expose CGPA or private academic information.
3.  **Skills Centre**
    -   Offer structured learning paths such as programming, web
        development, UI/UX, graphic design, video editing, digital
        marketing, entrepreneurship, public speaking, research and
        writing.
    -   Combine Prepium-created lessons with selected external learning
        resources.
    -   Include assessments, practical exercises, projects and progress
        tracking.
    -   Do not claim mastery based only on lesson completion.
4.  **Prepium Challenges**
    -   Expand the existing Daily Challenge and Games systems rather
        than creating a disconnected platform.
    -   Support daily, weekly, 7-day, 30-day and seasonal challenges.
    -   Include individual, friend, squad, department and faculty
        competitions.
    -   Award XP through a traceable ledger across all Prepium
        activities.
    -   Prevent duplicate or fraudulent XP awards. XP is not CGPA or
        money.
5.  **Holiday Mode**
    -   Allow students to activate it manually.
    -   Also allow Prepium to recommend it when reliable
        academic-calendar information supports the recommendation.
    -   Let students set goals for revision, skills, projects, reading,
        challenges, opportunities and community activity.
    -   Allow students to return to normal academic mode without losing
        progress.
6.  **Opportunities Centre**
    -   Include scholarships, bursaries, internships, fellowships,
        competitions, hackathons, graduate programmes, volunteering and
        leadership opportunities.
    -   Support saving opportunities, eligibility information,
        application tracking and reminders.
    -   Show source links, closing dates and verification status. Do not
        present expired or unverified opportunities as confirmed current
        opportunities.
7.  **Audio, video and group calling**
    -   Support one-to-one audio and video calls and group calls.
    -   Show accurate states: calling, ringing, connected, offline,
        busy, declined, missed, reconnecting and ended.
    -   Include incoming-call screens, local and remote video, mute,
        camera controls, speaker controls, participant grids, call
        history and missed-call notifications.
    -   Use WebRTC, TURN support and an appropriate SFU architecture for
        scalable group calls.
    -   Never pretend a call connected when the recipient is offline,
        has declined, lacks permissions or has no usable network.

## 3. Specific codebase fixes requested

These are explicit cleanup and correctness tasks. They should be
completed without changing unrelated behaviour.

### Fix 1 --- Duplicate error handlers

**Problem:** The application currently has two global error-handler
registrations in `app.js` (reported around lines 6861 and 8520). The
earlier handler only covers routes registered before it, which can
result in inconsistent error handling.

**Required update:** - Inspect both error handlers and every
route/middleware registration around them. - Consolidate error handling
into one intentional, central Express error-handling flow. - Ensure the
final error handler is registered after all routes and middleware that
may pass errors to it. - Preserve any necessary upload-specific,
database-specific or API-specific error responses through well-defined
handling inside the central flow. - Return appropriate HTTP status codes
and safe user-facing messages. - Log useful diagnostic details
server-side without exposing secrets, stack traces or sensitive data to
students. - Ensure asynchronous route errors are handled correctly with
the application's Express version. - Add tests for errors from early
routes, late routes, API endpoints, uploads and unexpected exceptions.

**Acceptance criteria:** - There is one clearly documented global
error-handler flow. - Errors from routes registered throughout the
application reach the intended handler. - API requests receive
consistent JSON error responses; page requests receive appropriate
user-facing error responses. - No duplicate handler silently masks or
bypasses another handler. - Existing successful routes continue to work.

### Fix 2 --- Duplicate CGPA calculations

**Problem:** CGPA and degree-class calculations are duplicated in
multiple places, including the main CGPA builder, forecast logic and
transcript generation.

**Required update:** - Identify every CGPA, GPA, grade-point,
credit-unit and degree-class calculation in the codebase. - Create one
shared, trusted calculation service/module. - Make the CGPA tracker,
what-if builder, forecasts, AI-advisor context and transcript generation
use the shared calculation logic wherever the calculation rules are the
same. - Preserve support for both 4-point and 5-point grading scales. -
Correctly account for course units, grades, carry-over balance and any
supported previous-semester records. - Keep hypothetical courses
separate from actual academic records. - Validate inputs and handle
missing, invalid or zero-credit data safely. - Ensure AI features
receive calculated values from trusted server-side logic rather than
independently calculating or inventing CGPA. - Add regression tests
comparing CGPA, forecast and transcript outputs for the same academic
record.

**Acceptance criteria:** - There is one authoritative implementation for
shared CGPA and degree-class rules. - The same student record produces
consistent values in the tracker, forecast and transcript. - Both
4-point and 5-point systems are tested. - What-if scenarios do not
accidentally modify actual student records. - Existing saved academic
records remain intact.

## 4. Foundation and reliability requirements

Before expanding the product: - Audit routes, views, APIs, database
tables and feature dependencies. - Reconcile application expectations
with the actual production database schema. - Introduce
version-controlled database migrations. - Fix confirmed broken routes,
links and database queries. - Review authentication, authorisation and
private-data ownership checks. - Review payment verification,
transaction ownership and idempotency. - Improve upload validation,
session security, rate limiting and Content Security Policy. - Move
production background jobs to reliable scheduled infrastructure. - Add
automated tests, structured logging and deployment checks. - Test
changes in a staging environment before production deployment.

Do not assume production database contents or deployed runtime behaviour
from repository code alone. Verify these separately.

## 5. Implementation approach

Implement in three integrated releases.

### Release 1 --- Foundation and reliability

-   Complete the code and database audit.
-   Fix critical route, query, security and data-integrity issues.
-   Complete the duplicate error-handler cleanup.
-   Complete the shared CGPA calculation refactor.
-   Establish migrations and automated tests.
-   Audit existing messaging and calling before extending them.

### Release 2 --- Integrated student experience

-   Improve the dashboard and existing academic tools.
-   Connect academic activity to Personal Academic Intelligence.
-   Introduce shared XP and achievements across Prepium.
-   Improve community and calling.
-   Implement Prepium Wrapped.

### Release 3 --- Growth and year-round engagement

-   Launch the Skills Centre.
-   Expand Prepium Challenges.
-   Launch the Opportunities Centre.
-   Implement Holiday Mode.
-   Connect skills, projects, opportunities and holiday activity to
    Wrapped and student progress.

## 6. Non-negotiable development rules

-   Improve the existing Prepium application; do not rebuild it from
    scratch.
-   Inspect existing code before changing it.
-   Reuse existing routes, tables, services and UI where appropriate.
-   Do not create duplicate systems for features that already exist.
-   Do not remove working functionality without an agreed reason.
-   Do not create fake buttons, placeholder actions or misleading
    statuses.
-   Protect student data and enforce ownership checks on private
    records.
-   Keep academic calculations deterministic and server-side.
-   Use migrations for database changes; do not make undocumented
    production schema edits.
-   Test each change and report exactly what was changed.
-   Do not claim a feature is complete until its acceptance criteria
    have been tested.

## 7. Completion reporting

For each task, record:

-   Files and modules changed.
-   Database migrations added, if any.
-   Routes, APIs and screens affected.
-   Tests performed and their results.
-   Any remaining limitations or production checks.
-   Whether the change is ready for staging or production.

**This document is the approved working brief for the Prepium updates
and fixes. Any material change to the locked product scope should be
agreed before implementation.**
