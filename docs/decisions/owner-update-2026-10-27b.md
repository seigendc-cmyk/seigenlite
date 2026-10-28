# Owner update, 27 Oct 2026 (evening): F-0 upgrade from the Growth Financial Engine spec v2

**For Claude Code:** save this file as `docs/decisions/owner-update-2026-10-27b.md`.
1. **Merge** the five decisions below (A–E) into `docs/decisions/post-build-29-decisions.md`, numbered **after the repo's last number** (58–62 if the doc ends at 57). Same rules as before: keep the repo's numbering, and **STOP** if any content conflicts.
2. **Update Part 3 (F-0) and the roadmap** in `docs/prompts/next-builds-v36-v38.md` with the "F-0 additions" below, so that F-0 = the original items **plus** these.
3. Commit both by name. **Don't start F-0 before Part 2 (v37) is done.**

The spec itself is saved by the owner at `docs/financial-engine/00_GROWTH_FINANCIAL_ENGINE_SPEC_v2.md`. It is **the design reference for Finance**. Where it conflicts with the decisions doc, **the decisions doc wins**. Report any conflict; don't resolve it silently.

## Decisions to add

**A. Posting in both places** (replaces "seiGEN posts", decision 27, where they differ):
- The **same posting rules run on the till** (a **provisional** local journal, so reports work offline) **and on seiGEN** (the **official** books), from the same synced events with the same ids. They must match.
- The official P&L, Balance Sheet, Trial Balance and Cash Flow come from seiGEN. The till marks its figures **"provisional until synced"**.
- Any difference between the till's and seiGEN's journal for the same event is an integrity failure: flagged, never silently fixed.

**B. F-0 captures the data Finance needs** (spec §9, §18, §30, §44, §50, §58). Built in F-0:
1. **Dimensions on every money and stock event:**
   - branch, till/seat, operator, product, category, customer, supplier, and **sales channel** (counter retail / wholesale / iTred order);
   - an optional **cost centre** on payouts.
2. **Exchange rate and its source** on every money event: the rate used, and whether it's the owner's street rate or the official rate.
3. **Accounting policy record per business:**
   - functional currency;
   - **fiscal year start**;
   - inventory method (weighted average, decided);
   - rounding;
   - reserve policy.
   Every change is audited, and changing it needs Owner approval.
4. **Inventory integrity check** per till and seat: opening + received − sold − adjusted = closing, at both last cost and WAC. Mismatches are flagged.
5. **Keep both costs** (last cost and WAC) on every sale line permanently, for the later replacement-cost analysis (spec §30).
6. **Inter-branch flag** on dispatch, GRV and internal transfer events, so the business-wide books can cancel them out (spec §18).

**C. F-0 reports and proposes; nothing changes without the owner's approval:**
7. **History-edit audit (spec §47):** list every place where the app lets someone **edit or delete** a sale, payout, payment, GRV, stock record or customer balance (file:line). For each, propose the "reverse and redo" alternative. **Each change is a logic change, approved case by case.**
8. **Tax check (spec §5, §43):** report whether and how the app records VAT or tax today. **Don't invent tax rules** (the jurisdiction layer is later).
9. **Other money in (spec §7, §14):** propose how to record non-sale money coming **in**: capital introduced, loans received, other income, customer deposits. Screens, rights and events. **Proposal only.**

**D. Finance Phase 0 replaces "Finance screen designs":**
- Before any F-1 code, Claude Code writes the **financial source-of-truth documents** listed in spec §60 (`docs/financial-engine/01_…` to `24_…`: accounting principles, chart of accounts, accounting events, journal rules, subledgers, inventory accounting, AR/AP, statements, management accounting, COGS reserve, working capital, economic state, multi-currency, growth capacity, trajectories, scenarios, Decision Lab, Seith, jurisdiction, audit, offline sync, security, reporting, acceptance tests), **plus screen designs** for the Finance module (decision on Finance's own UI).
- **The owner approves them before F-1 starts.**
- They must be **based on the real app and the decisions doc**, and say clearly what exists today and what's new.
- **Phase order follows the spec §61:**
  - F-1: the double-entry core, subledgers and statements;
  - then working capital;
  - then management accounting;
  - then economic state, growth, scenarios and the Decision Lab;
  - **Seith last**.

**E. RPN onboarding pack and secrets (owner decision, 28 Oct 2026):**
- At setup, the RPN may write the vendor's **Admin passcode and secret phrase** on the **Vendor Private Recovery Sheet** (page 5 of the Vendor Onboarding Pack, form VO-1).
- That sheet is **handed to the vendor**. The RPN keeps **no copy, photo or message** of it, never sends it by WhatsApp or SMS, and never asks for these details after setup. Staff PINs are never written down.
- This replaces "never ask for or write down a vendor's Admin passcode, PINs or secret phrase" wherever that rule appears (RPN conduct, the RPN Field Guide content, the Help desk plan).
- The pack is saved at `docs/rpn/vendor-onboarding-pack.html`. **Before it's used in the field,** compare its setup steps (page 3–4) with the real app: button names, the secret-phrase screen and its word count, the order of setup screens. Report every difference as a list; don't change the app to match the pack.

## F-0 additions (for Part 3 of the prompt)
- **Build items 1–6** above, with the original F-0 items. All are additive; old records stay readable with the new fields empty.
- **Tests to add:**
  - every new event carries the dimensions and the rate source;
  - a policy-record change needs Owner approval and is audited;
  - the inventory check balances on the test data and flags a forced mismatch;
  - both costs are kept;
  - inter-branch events are flagged.
- **The report must include items 7–9** as separate sections (findings and proposals), plus any conflict between the spec and the decisions doc.
- Stops are unchanged: **"apply"**, then the **costing comparison** for the owner's approval before the WAC switch.
