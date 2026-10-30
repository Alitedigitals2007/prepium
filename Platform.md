PREPIUM COMPLETE PRODUCT UPGRADE

Competitive Improvement, Premium Redesign, Dashboard Redesign & PWA Implementation

Project: Prepium
Live Website: https://theprepium.vercel.app
Objective: Transform Prepium into a polished, mobile-first, AI-powered academic platform built specifically for Nigerian university students.

You are working on the existing Prepium codebase. This is a full product improvement and redesign task, not a request to build an unrelated application from scratch.

Your responsibility is to inspect the existing application, understand its architecture and current functionality, implement the improvements below, and verify that the final product works correctly.

Do not merely produce a plan, mockup, or static UI. Implement the changes in the actual codebase.

---

1. CRITICAL IMPLEMENTATION RULES

Before making changes:

1. Inspect the existing project structure, package configuration, framework, routing, components, database schema, authentication, API endpoints, payment integration, and deployment configuration.
2. Identify all existing features and preserve their functionality.
3. Reuse existing database tables, API routes, authentication providers, and payment services wherever appropriate.
4. Do not replace working integrations with mock data.
5. Do not remove features simply because they are not mentioned in this specification.
6. Do not expose API keys, secrets, service-role credentials, or private environment variables to the client.
7. Do not create fake testimonials, fake university partnerships, fake usage statistics, or misleading premium claims.
8. Implement responsive layouts for mobile, tablet, and desktop.
9. Use the existing stack and design system where possible. Introduce additional dependencies only when they provide a clear benefit.
10. Make changes incrementally and test each major area before proceeding.

If the project already contains an implementation of a requested feature, improve it rather than creating a duplicate.

2. COMPLETE VISUAL REDESIGN

Redesign Prepium to feel like a premium, modern educational technology product.

The application should look intentionally designed, not like a generic AI-generated dashboard or a collection of unrelated cards.

Design direction

Use a visual identity that communicates intelligence, focus, academic excellence, reliability, and modern technology.

Requirements:

- Establish a consistent primary colour palette based on the existing Prepium brand.
- Use a clean, readable typography system.
- Establish consistent spacing, border radii, shadows, icons, button styles, and component dimensions.
- Use restrained gradients and subtle visual effects.
- Create clear visual hierarchy between primary actions and secondary information.
- Use polished empty states, loading states, skeleton screens, success messages, error messages, and confirmation dialogs.
- Use consistent iconography instead of mixing unrelated emoji and icon styles.
- Avoid excessive gradients, oversized headings, unnecessary cards, and decorative elements that reduce usability.
- Include accessible colour contrast and visible keyboard focus indicators.
- Respect reduced-motion preferences.
- Use smooth, restrained animations only where they improve the experience.

The result must be professional enough to compete with established international study platforms while remaining practical for Nigerian students using mobile devices.

3. COMPLETELY REDESIGN THE PREMIUM EXPERIENCE

The existing premium page must receive a complete visual and user-experience overhaul.

Do not simply change its colours or add more feature cards. Rethink the entire presentation, layout, hierarchy, and conversion journey.

Premium page structure

A. Premium hero section

Create a compelling hero section that clearly communicates the value of Prepium Premium.

Include:

- A strong headline about studying smarter and preparing more effectively for examinations.
- A concise explanation of the premium benefits.
- A prominent primary CTA: "Unlock Premium".
- A secondary CTA: "Explore Features".
- A polished visual preview of the premium student dashboard or AI study workflow.
- Clear and accurate pricing information.

Do not use fake countdown timers, fake scarcity, invented discounts, or misleading claims.

B. Free versus Premium comparison

Create a clear comparison section showing the actual differences between the existing free and premium plans.

Possible comparison categories include:

- AI tutor usage.
- PDF-to-quiz generation.
- AI-generated flashcards.
- Personalised study planning.
- Academic performance insights.
- Study history and progress tracking.
- Advanced revision features.
- Other premium tools already implemented in the application.

Inspect the existing entitlement system and use the real plan capabilities. Do not advertise a feature as unlimited unless the backend actually supports it.

Make the differences easy to understand on small screens.

C. Premium feature showcase

Present premium features through carefully designed sections with realistic interface previews.

Prioritise:

1. AI study assistant.
2. PDF-to-quiz generation.
3. Smart flashcards and revision.
4. Personalised study planner.
5. Academic progress and weak-topic analysis.
6. CGPA tools and academic forecasting, where applicable.
7. Advanced study and challenge features already supported by the application.

Each feature should explain the practical academic problem it solves.

Avoid repeating the same marketing message in multiple sections.

D. Pricing and payment experience

Preserve the existing advertised ₦2,000 one-time premium offer only if it remains the actual configured price.

The page must clearly state:

- What the payment unlocks.
- Whether the payment is one-time or recurring.
- Whether there are AI usage limits.
- Whether premium access expires.
- What happens after a successful payment.
- What happens if a payment fails or is abandoned.

Integrate with the existing payment provider.

Payment requirements:

- Verify transactions on the server.
- Never grant premium access solely because the frontend receives a success response.
- Prevent duplicate transaction processing.
- Make the checkout experience mobile-friendly.
- Show clear pending, successful, failed, and cancelled payment states.
- Keep premium entitlement checks consistent across the application.

Do not invent a new payment integration if a working one already exists.

E. Premium FAQs and trust

Add concise answers to common questions:

- What is included in Premium?
- Is payment one-time or recurring?
- How do AI usage limits work?
- How do I access Premium after payment?
- What happens to my saved study materials?
- How can I get help with a payment problem?

Use only accurate information from the existing implementation.

F. Premium access states

Handle these states correctly:

- Unauthenticated visitor.
- Authenticated free user.
- User with an active premium entitlement.
- Payment pending.
- Payment successful.
- Payment failed.
- Previously premium user whose access has expired, if expiration exists.

Do not show the purchase CTA to a user who already owns the relevant entitlement unless the action is explicitly for renewal or another purchase.

Create a polished premium success screen with a clear action to start using the unlocked features.

4. COMPLETELY REDESIGN THE STUDENT DASHBOARD

Redesign the main student dashboard as a personalised academic command centre.

The dashboard should help students answer five questions immediately:

1. What should I study today?
2. What deadlines or examinations are approaching?
3. How am I performing academically?
4. Which topics do I need to improve?
5. Which tool should I use next?

Do not turn the dashboard into an overcrowded grid of unrelated cards.

A. Desktop dashboard layout

Create a cohesive desktop layout with:

- A compact left sidebar.
- A clean top navigation bar.
- A personalised welcome section.
- A primary study recommendation.
- A focused overview of academic progress.
- Upcoming academic activities.
- Quick access to important tools.
- Recent study activity.

The sidebar should support active-route highlighting, sensible grouping, and collapsible behaviour where appropriate.

Use the existing routes and features. Do not create dead navigation links.

Suggested navigation groups:

Overview

- Dashboard.
- My Study Plan.
- My Progress.

Study

- AI Study Assistant.
- PDF Quiz Generator.
- Flashcards.
- Practice Quizzes.
- Course Materials.

Academics

- CGPA Calculator.
- Timetable.
- Tasks and Deadlines.
- Exam Preparation.

Community

- Daily Challenge.
- Leaderboards, if supported.

Account

- Profile.
- Settings.
- Premium.

Only display links for features that actually exist. Where a feature is planned but not implemented, do not present it as operational.

B. Mobile dashboard layout

Mobile experience is a major priority.

Design for small Android screens first, including narrow devices.

Requirements:

- A compact header with the Prepium identity and essential account actions.
- A prominent "Continue Studying" or "Study Now" action.
- Today's study plan.
- Upcoming deadlines.
- A compact academic progress overview.
- Easy access to AI tools.
- A bottom navigation bar with a small number of primary destinations.
- A "More" menu for secondary tools.
- Touch targets of approximately 44 by 44 CSS pixels or larger.
- No horizontal overflow.
- No desktop sidebar permanently occupying mobile screen space.
- Forms and modals that remain usable when the virtual keyboard opens.
- Appropriate safe-area spacing on supported devices.

Do not simply shrink the desktop dashboard to fit a phone. Design a genuinely mobile-oriented experience.

C. Personalised study section

Create a prominent section that recommends the student's next action.

Examples:

- Continue the last unfinished practice quiz.
- Revise a topic with a low quiz score.
- Review flashcards due today.
- Prepare for an approaching examination.
- Complete a pending study task.

Recommendations must use real available data.

If the user has no study history, display an onboarding state that encourages them to choose a course, add a timetable, or begin their first quiz.

Never fabricate activity or academic performance.

D. Academic progress

Display relevant metrics such as:

- Quizzes completed.
- Average practice score.
- Study streak.
- Flashcards reviewed.
- Study-plan completion.
- CGPA, when provided by the user.
- Strongest and weakest topics, when enough assessment data exists.

Use accurate calculations based on saved data.

Do not treat practice quiz performance as an official examination result.

Explain empty states when there is insufficient data.

E. Dashboard performance

Ensure the dashboard does not issue unnecessary repeated database queries.

Where appropriate:

- Fetch related data efficiently.
- Use existing caching strategies.
- Avoid rendering large datasets unnecessarily.
- Paginate or limit recent activity.
- Handle failed requests gracefully.
- Keep sensitive information private to the authenticated user.

5. ADD A SEARCHABLE NIGERIAN UNIVERSITY COURSE LIBRARY

Develop or improve a structured academic resource library to make Prepium useful even when students are not using AI tools.

Start with University of Ibadan where practical, but architect the library to support other Nigerian universities.

Required structure

University → Faculty → Department → Level → Semester → Course.

Each course should support relevant fields such as:

- Course code.
- Course title.
- Department.
- Level.
- Semester.
- Course description.
- Available study materials.
- Past questions.
- Solutions or explanations.
- Resource contributor or source.
- Verification status.

Resource features

Implement:

- Search by course code and title.
- Filtering by university, department, level, and semester.
- Resource categories.
- Download or view actions where permitted.
- Clear labels for verified and unverified content.
- Resource submission or contribution workflow, if appropriate.
- Helpful empty states when no resources are available.

Use the existing database and storage system where possible.

Do not fabricate academic documents, claim official university approval without evidence, or expose copyrighted materials without appropriate permission.

If the library already exists, improve its discoverability, search, metadata and mobile experience rather than creating a competing second library.

6. IMPROVE THE AI STUDY WORKFLOW

Connect the existing AI tools into a more coherent learning experience.

PDF-to-quiz workflow

The ideal journey should be:

1. Upload a supported lecture note or document.
2. Validate the file type and size.
3. Extract the relevant text.
4. Choose a topic, question count, difficulty and question type where supported.
5. Generate questions using the existing AI integration.
6. Allow the student to attempt the quiz.
7. Grade answers using appropriate answer keys and evaluation rules.
8. Explain incorrect answers.
9. Save the attempt and results.
10. Recommend topics for revision.

Preserve the original uploaded document and generated results according to the existing data-retention policy.

Handle scanned PDFs and unreadable documents gracefully. Do not pretend extraction succeeded when it did not.

AI tutor

Improve the tutoring interface with:

- A clean conversation layout.
- Course or topic context.
- Clear explanations.
- Mathematical notation support where applicable.
- Follow-up questions.
- Relevant citations or document references when available.
- A way to return to previous study sessions.
- Helpful loading, retry and error states.

Do not invent citations or claim the AI has read a document that was not supplied.

Weak-topic analysis

Where sufficient assessment data exists:

- Identify topics with consistently low scores.
- Show the evidence behind each recommendation.
- Recommend relevant materials or practice quizzes.
- Track improvement over time.
- Let students dismiss or complete recommendations.

Do not draw strong conclusions from a single question or a very small sample.

7. ADD PROGRESSIVE WEB APP (PWA) SUPPORT

Implement a proper installable PWA so Prepium can behave more like an app on Android and other supported devices.

This must be a functional implementation, not merely a manifest file or an install button that does nothing.

A. Web app manifest

Create a valid web app manifest with appropriate values for:

- Application name: Prepium.
- Short name: Prepium.
- Description.
- Start URL.
- Scope.
- Display mode: standalone, where appropriate.
- Theme colour matching the Prepium brand.
- Background colour matching the app launch experience.
- Correct application icons.
- Suitable icon sizes, including 192 × 192 and 512 × 512.
- Maskable icon support where appropriate.
- Orientation only if a restriction is genuinely necessary.

Use the correct production origin and routing configuration.

Generate or adapt application icons from the actual Prepium branding. Do not use a random placeholder logo.

B. Service worker

Implement a service worker using the existing framework's recommended PWA approach.

If this is a Next.js project, choose a solution compatible with its current version and deployment configuration.

Requirements:

- Cache the application shell and suitable static assets.
- Use sensible caching strategies for static assets and public resources.
- Support an offline fallback page.
- Handle service worker updates safely.
- Prevent stale cached application code from persisting unnecessarily.
- Avoid caching private authenticated responses in shared caches.
- Do not cache sensitive user data, payment responses, private API responses, or authentication tokens inappropriately.
- Do not intercept payment, authentication, or other security-sensitive requests with unsafe caching rules.
- Provide a clear update experience when a new application version is available.

Use a network-first strategy for appropriate dynamic content and a cache-first strategy for suitable versioned static assets, adjusting strategies according to the resource type.

Do not aggressively cache everything.

C. Installation experience

Implement a polished installation prompt.

On supported browsers:

- Detect the available installation event.
- Display a dismissible "Install Prepium" prompt when appropriate.
- Trigger the browser's installation flow from a real user interaction.
- Handle accepted and dismissed installation prompts.
- Detect whether the app is already installed or running in standalone mode.
- Avoid repeatedly showing prompts after dismissal.
- Provide instructions for browsers that do not expose a programmatic installation prompt.

Do not display an installation button that falsely claims to install the app.

If the browser does not support the installation API, show appropriate manual installation instructions.

D. Offline experience

Provide meaningful offline behaviour.

At minimum:

- Show a branded offline fallback.
- Allow the application shell to load when its required assets are cached.
- Make previously cached, explicitly public study resources available offline where appropriate.
- Preserve unfinished local work safely where practical.
- Clearly indicate when network access is required.

AI generation, authentication, payment processing, and uncached server data must not be represented as available offline when they are not.

If saved quizzes or study materials can be safely supported offline, implement the required storage and synchronisation logic with conflict handling.

Never silently overwrite newer server data with stale offline data.

E. PWA metadata and compatibility

Ensure:

- Correct page metadata.
- Appropriate theme colours.
- Compatible icon paths.
- Valid manifest MIME type.
- Correct HTTPS production deployment.
- No conflicting service workers.
- No duplicate manifests.
- No unnecessary permissions.

If iOS support is relevant, include the appropriate Apple web app metadata and document its installation differences.

F. PWA verification

Test:

1. Manifest accessibility.
2. Icon loading.
3. Service worker registration.
4. Installation availability in supported browsers.
5. Standalone launch.
6. Offline fallback.
7. Application updates.
8. Authentication after installation.
9. Payment flows with the service worker active.
10. Mobile responsiveness and navigation.

Document any browser-specific limitations honestly.

8. DATABASE, SECURITY AND DATA INTEGRITY

Review all changes for correctness and security.

- Preserve the current authentication system.
- Verify ownership of student records on the server.
- Validate user input on the server.
- Apply file upload restrictions.
- Enforce premium entitlements server-side.
- Protect administrative functions.
- Prevent users from accessing other students' private data.
- Keep secrets server-side.
- Use appropriate rate limits for costly AI endpoints.
- Prevent duplicate payment fulfilment.
- Avoid exposing private storage URLs or unrestricted database access.
- Add database migrations only where needed.
- Preserve existing production data.

If new tables are required, create migrations that are safe to apply and document them.

Do not reset the production database or overwrite user records to make the redesign easier.

9. PERFORMANCE AND ACCESSIBILITY

Optimise the experience for students who use mobile devices and may have limited data or slower internet connections.

Implement:

- Responsive images.
- Appropriate image sizes and formats.
- Lazy loading where suitable.
- Efficient client-side JavaScript.
- Route-level code splitting where appropriate.
- Reduced unnecessary network requests.
- Accessible forms and labels.
- Semantic page structure.
- Keyboard navigation.
- Clear error messages.
- Loading indicators for long-running tasks.
- Appropriate empty states.
- Reduced-motion support.

Avoid introducing a large dependency merely to implement a small UI feature.

Test important routes at narrow mobile widths and desktop widths.

10. SEO AND PUBLIC LANDING PAGE

Improve the public homepage while retaining the existing Prepium brand.

Ensure the homepage clearly explains:

- Who Prepium is for.
- The academic problems it solves.
- Its key study features.
- How the AI study workflow works.
- The free and premium options.
- How students can get started.
- How to access course resources.

Improve relevant metadata, page titles, descriptions, canonical URLs and social sharing previews.

Create discoverable public pages for genuine course resources where useful.

Do not expose private dashboards, personal study records, or authenticated pages to search indexing.

Avoid duplicate pages and misleading SEO content.

11. TESTING AND ACCEPTANCE CRITERIA

The implementation is not complete until the following checks have been performed.

Existing functionality

- Authentication works.
- Existing user records remain intact.
- Existing AI features still work.
- Existing CGPA calculations remain correct.
- Existing quizzes and study data remain accessible.
- Payment and premium entitlements work correctly.

Premium redesign

- The new page is fully responsive.
- Pricing is accurate.
- The free-versus-premium comparison matches actual entitlements.
- Purchase and already-premium states work correctly.
- Failed and pending payments are handled properly.

Dashboard redesign

- Desktop navigation works.
- Mobile navigation works.
- All displayed links lead to valid destinations.
- Metrics use real data.
- Empty and loading states are polished.
- There is no horizontal overflow on small screens.

Course library

- Search and filters work.
- Course metadata is consistent.
- Resource access respects permissions.
- Empty results are handled correctly.

PWA

- The manifest is valid.
- Icons load correctly.
- The service worker registers successfully.
- Installation works in supported browsers.
- Offline fallback works.
- Cached content does not expose private data.
- Updates are handled safely.
- Payment and authentication remain functional.

Quality

- Run the project's existing lint, type-check and build commands.
- Fix errors introduced by your changes.
- Test critical user journeys.
- Do not claim a test passed if it was not run.
- Do not leave broken buttons, fake interactions, placeholder content or dead links.

12. IMPLEMENTATION ORDER

Follow this sequence:

Phase 1: Inspect the project and document the existing architecture and features.

Phase 2: Establish reusable design tokens and shared components.

Phase 3: Redesign the premium page and verify its real purchase flow.

Phase 4: Redesign the student dashboard for desktop and mobile.

Phase 5: Improve the course library and academic resource discovery.

Phase 6: Improve AI study workflows and progress insights.

Phase 7: Implement the PWA manifest, icons, service worker, installation flow and offline experience.

Phase 8: Review security, performance, SEO, accessibility and responsive behaviour.

Phase 9: Run tests, build the production application and fix regressions.

Phase 10: Provide a concise implementation report.

Do not stop after producing the architecture plan. Continue implementing the changes in the actual repository.

If a required service, credential, external integration or deployment permission is missing, complete the portions that can be implemented safely and clearly identify the specific remaining requirement.

13. FINAL DELIVERY REPORT

When finished, report:

1. Features implemented.
2. Premium-page changes.
3. Dashboard changes.
4. Course library changes.
5. AI workflow improvements.
6. PWA capabilities implemented.
7. Database migrations, if any.
8. Security and performance improvements.
9. Tests actually executed and their results.
10. Any unresolved issues or external configuration required.
11. Files and routes changed.
12. Deployment steps, if required.

Final quality standard: Prepium should feel like one coherent, high-quality academic product. The premium page should communicate value and convert users honestly. The dashboard should help students take their next academic action immediately. The PWA should install and behave reliably within the limits of the browser and device. All existing working functionality and user data must be preserved.
