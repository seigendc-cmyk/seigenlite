# Price plans (Business / Lite), priced per till licence: design (Stage A)

Status: **design only, nothing built.** Stage B starts on "go Plans-B".
Inspected 2026-10-08: repo `activation-v2` @ `d465ab8`, Console `console-b` @ `c7edb0f`, live database read-only.

Status words: **VERIFIED** (read in code or the live database), **ASSUMED**, **UNVERIFIED**, **BLOCKED**, **PROPOSED** (this design; nothing is IMPLEMENTED yet).

Live examples below use labels (Business A, B, …) because this repository is public. The business names are in the Stage A report to the owner, not here.

---

## 0. What the owner should know first

1. **The live activation rate is USD 15, not USD 20 (VERIFIED).**
   - `cl_activation_pricing` has three rows, all set by the same staff member: USD 60 at 2026-09-30 19:19 UTC, USD 20 at 19:26 UTC the same day, and **USD 15 at 2026-10-08 08:16 UTC**.
   - Licence #1002, issued at 08:25 UTC today, was charged **USD 15.00**. Licence #1001, issued earlier today, was charged USD 20.00.
   - Plans replace this rate either way. Nothing already charged changes.
2. **`cl_vendors` is one row per device, not per business (VERIFIED).** The owner decided this at Multi-terminal Q1: no merging, and each install keeps its own billing history.
   - So a business with 6 tills has 6 vendor rows, and each till's licence charge lands on that till's own row (`cl_licence_attach` charges `cl_licences.vendor_id`).
   - This design keeps that rule. The Console adds the business total on top (§6).
3. **Most live installs share one shop secret phrase (VERIFIED):** 23 of 28 vendor rows, across 13 shop names. That looks like seiGEN's own test devices, not 13 real shops.
   - ASSUMED, to confirm: which vendors are real paying shops. It matters for the "Plan not set" list (§5).
4. **The signed licence already has a plan byte (VERIFIED).** It sits at payload byte 26, is always 0 today, and the app parses it (`src/activation.js:112`) but never uses it. It can carry the plan offline with no format change (§7).

---

## 1. How the licence charge is computed today, and what changes

| Piece | Today (VERIFIED) | Change (PROPOSED) |
|---|---|---|
| `cl_activation_pricing` + `cl_set_activation_rate` (sysadmin) | One flat rate; the newest `effective_from` wins. Three rows on live (see §0). | **Frozen.** Kept for history and nothing reads it after the migration. `cl_set_activation_rate` refuses with "The activation rate is replaced by Price plans (Console → Price plans)". The table and its rows stay. |
| `cl_licence_prepare` (staff, via the Edge Function) | Creates the licence rows and signs nothing. `p_plan` (the Edge Function passes `body.plan ?? 0`) goes into the payload byte. **No price.** | It works out each till's **role**, **plan** and **price** at issue time and stores them as a snapshot on the licence (§3). The payload plan byte becomes the plan's licence byte (Business 1, Lite 2), so `p_plan` is ignored. It refuses a Lite "branch" till and a deactivated till (§2, §4). The per-device 30-second duplicate guard (20261012120000) stays. |
| `cl_licence_attach` | Charges `round(rate × days ÷ 30, 2)` from the **current** `cl_activation_pricing` to `l.vendor_id`, with note `Auto-charged: licence #N (D days)`. | It charges the **amount snapshotted at prepare**, so the price can't move between prepare and sign. **The note text stays the same**, because the Console finds a licence's charge by that exact text (`index.html:1361`). The charge links to the licence through the existing `cl_licences.ledger_entry_id`. |
| `cl_issue_activation_code` (old codes; production Console until the cutoff) | Charges the flat current rate **once per code, whatever the dates**, note `Auto-charged: activation code issued`. | It uses the **same role and plan price** as a v2 licence for that vendor, × (valid_to − valid_from) ÷ 30. The Console always sends 30 days. The note text and the 30-second duplicate guard stay. **This changes what production charges for old codes, with no Console deploy.** Alternative: leave the old path on the frozen flat rate until the cutoff. Recommendation: use plan prices, so one shop never pays two different prices for the same till. |
| Edge Function `issue-licence` (`handler.mjs`) | Passes the RPC results through. | It stops sending `plan`, and adds `plan_name, till_role, unit_fee, amount, currency` to each licence in its reply. **Redeploying it is a live change.** It needs the owner's go in Stage B (it's on the shared Supabase project, so there is no preview copy). |
| CLI `tools/licence/issue.js` | Prints the WhatsApp message only. | Prints "Business plan · main till · USD 15.00 × 30/30 = USD 15.00" per licence. New `--quote` flag: shows the prices without issuing. |

**One pricing function, used by everyone (PROPOSED):** `cl_licence_quote_for(install_id, days)` (internal) returns plan, plan version, role, unit fee, amount and currency, or a refusal.
- Prepare, the old path, the new staff RPC `cl_licence_quote(p_device_code | p_business_id, p_days)` and the vendor card all call it.
- The Console form, the CLI `--quote` and the charge itself therefore cannot disagree.

---

## 2. A till's role at issue time

**Data (VERIFIED):**
- `cl_businesses` → `cl_branches` (`is_main`; one main per business) → `cl_terminals` (`till_code` `T1`, `T2`…, numbered per branch, never reused; `active`).
- A device code (`ABCD-K7Q2`) maps to its till through `install_id`: `cl_vendors.install_id` → `cl_terminals.install_id`. `cl_licence_prepare` already does this.

**Rule (PROPOSED):**

| Situation | Role |
|---|---|
| Device has **no** `cl_terminals` row (an unregistered shop) | **main** |
| Lowest-numbered **active** till of the **main** branch | **main** |
| Lowest-numbered **active** till of any **other** branch | **branch** (Lite: refused) |
| Any other active till | **till** |
| Till is **deactivated** | **refused**: "Till T1 of this business is deactivated. Reactivate it from a main-branch till first." Today a device-code issue for a deactivated till is not refused (`cl_licence_prepare` doesn't check `te.active`); business-wide issue already skips them. |

"Lowest-numbered" compares the number, so T10 comes after T9.

**Edge cases:**
- **The main branch's T1 is deactivated (on live: Business D, VERIFIED).** The next active till (T2) becomes the main till, priced 15, and T3 onwards cost 3 each. If the rule were "T1 only", that business would have no main till and would pay 5 × 3 = 15 instead of 15 + 4 × 3 = 27.
  - The main branch can't end up with no active till through the app: only an active main-branch till can deactivate tills, and a till can't deactivate itself (`cl_terminal_set_active`, VERIFIED).
- **A till moving branches:** there is no RPC for it (VERIFIED). `cl_terminal_join` answers ALREADY_JOINED, and till rows keep their `branch_id`. If one is ever added, the role is still read at issue time, and old licences keep their snapshot.
- **A licence re-issued for the same till** (early renewal, a lost code, a revoked licence): the role and price are worked out again, at the current price, with no proration (owner rule). The 30-second guard only stops repeated taps.
- **Roles that change mid-cycle:** say T1 is deactivated after its 30-day licence was paid. T2's next licence is priced as main, so that cycle pays two main fees. That follows from "priced at issue time, no proration". The Console shows it, and staff can credit it if they choose.
- **Whole-business issue** (`p_business_id`): each till's role comes from the database, not from the order in which tills are issued, so the licences add up to the monthly fee.

---

## 3. Data model (PROPOSED)

**`cl_price_plans`** (the plans themselves):
- `code text primary key`: `business` or `lite`.
- `licence_byte smallint unique`: 1 for Business, 2 for Lite. It goes in the signed licence.
- `created_at`.

**`cl_price_plan_versions`** (prices, with history):
- Columns:
  - `id`, `plan_code` (FK), `name` ("Business", "Lite");
  - `main_fee`, `branch_fee`, `till_fee`: `numeric(10,2) ≥ 0`, per 30 days;
  - `currency` (`^[A-Z]{3}$`); `max_branches int` (null means no limit);
  - `effective_from timestamptz`, `created_by` (staff), `created_at`, `note`.
- Rules:
  - The current version is the latest `effective_from ≤ now()`.
  - `effective_from` must be now or later, so the price history can't be rewritten after the fact.
  - Rows are never updated or deleted. An edit is a new version.
- Seed versions:
  - Business: 15 / 7 / 3 USD, no branch limit.
  - Lite: 6 / — / 3 USD, max 1 branch. Lite's `branch_fee` stays null.

**`cl_plan_assignments`** (which plan a shop is on, with history):
- Columns:
  - `id`; `business_id` **or** `vendor_id` (exactly one); `plan_code`;
  - `set_by_staff`; `set_by_rpn` (only if RPNs may set plans, Q2); `reason`; `created_at`.
- **Why on the business (or the vendor, for a shop with no business):**
  - The owner decided a business is `cl_businesses`, not the main device's vendor row (Q1, multi-terminal). A plan describes the whole business: the branch limit and the main/branch/till roles.
  - An unregistered single-device shop has no business row, so its plan sits on its vendor row.
  - A separate table rather than a column, because staff with the Vendors Register module can write **any** column of `cl_vendors` directly (policy `cl_vendors_write_staff`, VERIFIED). A plan column there would bypass the history and the permission rule.
- **How a till's plan is resolved:**
  1. its business's latest assignment;
  2. otherwise the business creator's own vendor assignment (a shop that was Lite before it registered keeps Lite, with no copying);
  3. otherwise its own vendor assignment (unregistered);
  4. otherwise **Business, flagged "not set"**.
- Changes take effect from the next licence issued. Nothing is prorated.

**`cl_licences`, new snapshot columns** (null on #1001, #1002 and on everything before this):
- `price_plan_code`, `plan_version_id` (FK), `plan_source` (`assigned` | `default`);
- `till_role` (`main` | `branch` | `till`);
- `unit_fee`, `amount`, `currency`.
- `days` and `ledger_entry_id` already exist.
- A trigger blocks changes to these columns once set, so the snapshot can't be edited later.

**Old codes:** `cl_activation_codes` gets no new columns. The charge's ledger row holds the amount, and the activity log detail gets the plan, role and fee.

**Access:** row-level security is on for all three tables, and `anon`/`authenticated` get no write grants, so writes go only through RPCs.
- Staff with Activation Codes, Vendors Register or Collections Ledger, and sysadmins, can read plans and assignments.
- Vendors and RPNs can't read either table. A device sees only its own terms (§7).

---

## 4. Lite's branch limit, enforced by the server (PROPOSED)

Where branches are created or joined (VERIFIED):
- `cl_branch_register` creates the business with its **main** branch only. **No check needed.**
- `cl_branch_issue_join_code(p_new_branch_name)` is the **only place a non-main branch is created**.
  - **Check here:** if the plan's `max_branches` is set and the business already has that many branches, raise `PLAN_BRANCH_LIMIT: Your plan allows one branch. Ask seiGEN to upgrade you to the Business plan.`
  - For a plan with a limit above 1, the message gives the number instead.
- `cl_terminal_join`, joining a **non-main** branch: the same check as a backstop, for branch rows made before a downgrade or by an old app. Joining the main branch is always allowed (extra tills cost 3 each).
- `cl_licence_prepare`: a Lite till whose role works out as **branch** is refused with the same message.

It's a **raise**, not an `{error:…}` reply, so older apps (v10, v11), which show unknown errors as "Digital Commerce couldn't do that (…message…)", still show the sentence. The new app maps `PLAN_BRANCH_LIMIT` to the plain sentence in `terminalProblemText` (`src/terminal.js`).

---

## 5. Changing a shop's plan (PROPOSED)

- `cl_set_plan(p_business_id | p_vendor_id, p_plan_code, p_reason)`. Who: §8 Q2. It is logged in `cl_activity_log`, and the reason is required.
- **Upgrade or downgrade** applies from the next licence issued. There is no proration, and nothing already charged changes.
- **Downgrade to Lite is refused** while the business has more branches with an active till than Lite allows: "This business has 2 branches with active tills. Lite allows 1. Deactivate the other branch's tills first."
- **"Plan not set"** means no assignment resolves (§3). It is priced as Business and listed for review. On live today that is every vendor (VERIFIED: the table doesn't exist yet).

---

## 6. Console (`D:\SCL Console`, preview only) (PROPOSED)

- **Price plans** (new screen):
  - The current version of each plan, with fees, currency, branch limit and effective date, and full history underneath.
  - **Edit** adds a new version with an "effective from" date, now or later; a future price shows as "from 1 Nov".
  - Who may edit: §8 Q1.
- **Vendors → vendor card:**
  - Plan with "not set" shown in amber, and **Change plan** (the reason is required; downgrades are refused per §5).
  - The business's branches and tills, each till's role and fee, and the **expected total per 30 days**: the sum of the active tills' role fees at today's prices.
  - The business balance: the sum across its tills' vendor rows.
- **Plan not set: review** list: businesses and unregistered vendors with no plan. Each row shows its tills and the price if it stays Business, with a one-tap "Set plan".
- **Licences → Issue:** the charge box calls `cl_licence_quote` and shows, per till, the plan, role, fee × days ÷ 30 and the total, before the existing "Tap again to confirm" step.
  - A refusal (Lite branch till, deactivated till) shows before anything is signed.
  - It replaces `licChargeHtml`'s client-side `cl_activation_pricing` maths.
- **Activation fee card** (old screen) shows "Replaced by Price plans", and its Set rate button is removed.
- **The old-code panel** (until the cutoff) shows the plan price too.

**Worked examples (Business plan):**
- **Main branch + 2 branches + 2 extra tills = USD 35 per 30 days:**
  - main till: 15;
  - two branch first tills: 7 + 7;
  - two extra tills: 3 + 3.
- **Business C on live** (main branch with 3 tills, a second branch with 1) = 15 + 3 + 3 + 7 = **USD 28**.
- **Business D on live** (main branch: T1 deactivated, T2–T6 active) = 15 + 4 × 3 = **USD 27**.

**Worked example (Lite):** 2 tills = 6 + 3 = **USD 9**.

**Days:**
- Prices for D days are fee × D ÷ 30, rounded to cents for each licence.
- Business main: 15 / 45 / 182.50. Branch: 7 / 21 / 85.17. Till: 3 / 9 / 36.50. Lite main: 6 / 18 / 73.00.
- Rounding each licence can make a 365-day total differ from the monthly total × 365 ÷ 30 by a cent or two. For example, Business 35 → 425.84 summed per licence (182.50 + 2 × 85.17 + 2 × 36.50), against 425.83 exact.

---

## 7. Vendor app: More → About (small) (PROPOSED)

- The licence card adds one line: "**Business plan** · main till · USD 15.00 per 30 days · licensed until 7 Nov 2026."
  - **Plan name, offline:** from the **signed** plan byte (1 Business, 2 Lite; 0 means "issued before plans", so the line is left out).
  - **Role and price:** from a new device RPC `cl_licence_terms(install, phrase, device_key)`, which returns this install's latest licence's snapshot (plan name, role, unit fee, amount, days, currency).
    - The app calls it when About opens and the device is online, and keeps the last answer.
    - It answers only for the calling device (install + phrase + device key, the same check as every device RPC).
- Nothing on the card is editable.
- The new app shows the plan-limit refusal plainly (§4). No other app change.

---

## 8. Questions for the owner (with recommendations)

- **Q1. Who can edit price plans?**
  - **Recommendation: sysadmin only.** It's the same rule as `cl_set_activation_rate` today. Prices are money, and there are two plans.
  - A "Price Plans" permission is easy to add later if someone else needs it.
- **Q2. Can an RPN set a vendor's plan at onboarding?**
  - **Recommendation: staff only for now.** Staff with **Vendors Register** (or sysadmin) set and change plans, and every change is logged.
  - The RPN puts the suggested plan in the onboarding note they already send (`rpn_onboarding_notes`), and staff confirm it from the "Plan not set" list.
  - Reason: an RPN choosing the plan of the shop they earn from is a conflict of interest. Today no live vendor has an RPN assigned (VERIFIED: 0 of 28). A plan picker in the Field Guide can come later.
- **Q3. Ambiguous cases on live** (labels here, names in the report):
  - **(a) Business A** is registered **twice**: two businesses with the same name and the same phrase, one main branch each (Bulawayo, Harare). As it stands, that's 2 × 15 = 30 on Business, or 2 × 6 = 12 on Lite.
    - If it is really one shop with two branches, it should be one business: 15 + 7 = 22. There is no RPC to merge businesses.
    - **Recommendation:** price as registered, and flag it in the review list for staff to talk to the shop. Re-joining the second device as a branch is a separate, later task.
  - **(b) Business D's main T1 is deactivated.** Rule §2: T2 is the main till, total 27. **Recommendation:** accept.
  - **(c) An unregistered device of a business.** Business B has a registered till and a separate unregistered vendor row with the same name and phrase. The unregistered one counts as a **main till (15)**, not an extra till (3), until it joins the business.
    - **Recommendation:** accept. Staff see it in the review list ("same phrase as a registered business") and ask the shop to join it.
  - **(d) The old-code path changes production's price** for old codes (§1). **Recommendation:** yes, use plan prices.
  - **(e) Mid-cycle role changes** (§2) can charge two main fees in one cycle. **Recommendation:** accept. It's what "priced at issue, no proration" means, and staff can credit it.

---

## 9. Tests, risks, rollback (PROPOSED for Stage B)

**PGlite tests** (`supabase/tests/price-plans-test.js`, built from the live shape):
- **Prices:**
  - every role × plan price;
  - 30/90/365 amounts;
  - a deactivated T1 → T2 becomes main;
  - a Lite branch till refused;
  - a deactivated till refused;
  - "not set" priced as Business and flagged.
- **History and snapshots:**
  - a price edit (a new version) doesn't change earlier snapshots or ledger charges;
  - a future-dated version isn't used until its date;
  - backdating is refused;
  - the snapshot columns can't be edited.
- **Branch limit:** a second branch on Lite refused at join-code issue and at join; downgrade refused while there are 2 active branches; upgrade allowed.
- **Plan resolution:** business → creator vendor → own vendor → default.
- **Old path:** priced by plan; the duplicate guard still holds.
- **The same price everywhere:** `cl_licence_quote` = the prepare snapshot = the ledger charge.
- **Who may do what:** anonymous, RPNs, staff without the permission and inactive staff are refused for every new RPC; a device sees only its own terms.
- **Rollback:** restores the exact live catalogue.

**Other tests:**
- The end-to-end test (`test/licence-e2e.test.js`) runs Console → Edge Function → app, checks the role and price, and checks that the app's About shows them.
- Console Playwright at 390 and 1280 px: Price plans, Change plan, the review list, the vendor card total, the issue-form breakdown, and the double-submit checks from the last task.

**Risks:**
1. Production's old-code charges change when the migration is applied (§1, Q3d).
2. The Edge Function needs a live redeploy for the new reply fields. Until then, licences are priced correctly but the CLI and Console show less detail.
3. The production Console's Activation fee card keeps showing USD 15 after plans go live, until a production Console deploy.
4. If role numbering is ever done by hand in the database, it could leave a main branch with no active till. The Console would show it as "no main till".

**Rollback:**
- It refuses while any licence has a plan snapshot or any assignment exists, so priced history can't be lost silently. Otherwise it drops the new tables and columns and restores the four changed functions byte for byte: prepare, attach, the old issue path and the rate setter.
- Restoring the changed device functions (join code, join) means the branch limit is gone again.

**Existing records:** licences #1001 and #1002, their USD 20.00 and USD 15.00 charges, the 7 old-code charges and the credits stay exactly as they are. The new snapshot columns are null for them, and the Console shows "issued before plans".
