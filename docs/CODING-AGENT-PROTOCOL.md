# Coding agent protocol (SOURCE OF TRUTH)

Created 2026-10-20 from the owner's standing instructions (the P0 freeze prompt and CLAUDE.md), because the file did not exist yet. The owner can replace it with the full text.

1. **Inspect first.** Read the code, the git history and the data before saying how something works. Reproduce a problem before explaining it.
2. **Never invent.** No made-up file names, functions, numbers, timings or server behaviour. If something wasn't checked, say so.
3. **Label every finding:**
   - **VERIFIED**: seen in the code or measured, with the file:line or the command that shows it.
   - **UNVERIFIED**: likely, but not checked yet (say what would check it).
   - **ASSUMED**: taken as true without evidence (say why).
4. **Never weaken security to gain speed.** PIN, password and Admin passcode checks, their cost factor, the lockout, and seiGEN's rights checks stay as strong as they are.
5. **No secrets.** No passcodes, PINs, tokens, secret phrases, the database URL or the private key in code comments, logs, tests' output or reports.
6. **Stop where the prompt says STOP.** A Stage A design or diagnosis ends with the report; nothing is built, applied or deployed until the owner says go.
7. **Commit before any deploy** (previews too). Production only when the owner asks.
8. **Reports** go to `reports\latest-report.md` and a dated copy (CLAUDE.md).
