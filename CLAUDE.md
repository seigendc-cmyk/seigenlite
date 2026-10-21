# CLAUDE.md

Owner decisions and roadmap: docs/decisions/post-build-29-decisions.md — read it before any task; it overrides older design docs unless the task prompt says otherwise.

## NO SILENT LOGIC CHANGES (owner control rule, 21 Oct 2026)
Never change, remove, bypass or weaken existing logic without telling the owner first and getting an explicit "approved".
"Logic" includes: business rules, calculations (prices, stock, credit, totals, tax, COGS), validations and limits, permissions/rights and server checks, sign-in and passcode checks, sync and offline behaviour, licensing/billing, receipts and documents, defaults and settings, menu/screen flows, and any existing feature.
This applies even if the logic looks wrong, unused or outdated, or if changing it would make a test pass or a fix easier.
Before any such change, STOP and report:
  1. What logic, where (file:line).
  2. What it does today, and what you propose instead.
  3. Why.
  4. Who/what is affected (screens, data, other apps, existing records).
  5. Alternatives that keep the current logic.
Then wait for the owner's "approved". Without it, keep the current logic and work around it, or mark the task BLOCKED.
Tests: you may fix a test's timing, setup or harness, but never change what a test expects the business outcome to be unless the owner approved that rule change.
Pure refactors are allowed only if behaviour is identical; say so and prove it with tests.
Every report must include a "Logic changes" section listing each behaviour change and the approval it rests on, or "None".

## Reports
- At the end of every task, and whenever you stop to wait for me (Stage A designs, "waiting for apply", "waiting for post", blockers), save your full report to C:\seigen-commerce-lite-refactor\reports\latest-report.md (overwrite), plus a dated copy reports\YYYY-MM-DD-HHMM-<short-task-name>.md.
- Use the same folder for Console work (don't create a second reports folder in D:\SCL Console).
- reports/ must be in .gitignore. Never write secrets, tokens, passcodes, the database URL or the private key into a report.
- End your chat reply with the line: "Report saved: reports\latest-report.md".
