# Office seat by invite: Stage A design

Status: **design only, nothing built.** Written 2026-10-20 on `activation-v2`, after v31 (seiGEN `20261108120000`) was applied.
The owner's decisions of 20 Oct are the brief; anything here that departs from them is called out as a recommendation.
Labels follow `docs/CODING-AGENT-PROTOCOL.md`: **VERIFIED** (seen in code, with file:line), **UNVERIFIED** (not checked yet; says what would check it), **ASSUMED** (taken as true; says why).

---

## 0. The five things that shape the design (read these first)

1. **Every device authenticates with the business secret phrase today, and the phrase is shown in Settings.**
   - Each device RPC sends `install_id + secret_phrase + device_key` (`src/terminal.js:83-85`).
   - Joining checks the phrase against the business's hash (`20261023120000_admin_passcode_from_main.sql`, `cl_terminal_join`: the `PHRASE_MISMATCH` check).
   - Settings shows the phrase in an ordinary text box (`src/settings.js:100-104`). VERIFIED.
   - **A seat must never learn the business phrase.** That phrase is also what makes activation codes.
   - **Proposal:** at join, seiGEN makes a random per-device phrase for the seat and returns it once. This works without changing any other RPC, because `cl_install_vendor` checks a device against **its own** stored phrase, not the business's (`20261004120000_multi_terminal_identity.sql`, `cl_install_vendor`: `v.shop_secret_phrase` vs `p_phrase`). VERIFIED.
   - On a seat, the "Activation secret phrase" card is hidden.
2. **Dispatch only goes between different branches.**
   - `cl_dispatches` has `check (from_branch_id <> to_branch_id)` (`20261017120000_dispatch_grv.sql:94`).
   - The app also refuses "your own branch" (`src/dispatch-out.js:314`). VERIFIED.
   - So **a seat at main cannot today move stock to main's own tills.**
   - A stores point that receives supplier goods needs that move (store room → shop floor). This needs a decision: see §2.4 and Q7.
3. **Selling, payments and End of Day run on the device, offline.** No sale or EOD reaches seiGEN, except a sale in shared-stock mode (`cl_stock_sale`).
   - "seiGEN refuses them" can therefore only mean two things:
     - (a) seiGEN refuses the calls that do reach it;
     - (b) **the signed licence** tells the app that this device is a seat, so a changed setting can't turn a seat into a till.
   - The licence already carries a 16-bit `features` field, always 0 so far (`src/activation.js:117`; `20261010120000_activation_licences.sql:67`). VERIFIED.
   - **Proposal:** feature bit 1 means "Office seat: no selling, payments or EOD". seiGEN sets it from the device's kind, and Ed25519 signs it.
4. **seiGEN checks the person's rights on only a few calls today.**
   - It checks them on staff management, other branches' reports and DN costs (`20261107120000_shop_roles.sql:33-58`, header).
   - GRV, dispatch, stock and catalogue calls trust the device. A device that sends no staff token "gets exactly what it got before". VERIFIED.
   - **Proposal:** for a seat, seiGEN requires a staff token with the matching right on **every** call except check-in. That is stricter than for a till; see §3.
5. **When nobody is signed in, the app allows everything.** `can()` returns true when `currentRights()` is null, that is in single operator mode (`src/roles.js:82`). VERIFIED.
   - **Proposal:** a seat never runs without a signed-in person. Single operator mode can't be switched on there, and with nobody signed in only the PIN screen shows.

---

## 1. Today's join flow (VERIFIED)

| Step | Where |
|---|---|
| Main registers the business, its main branch and T1 | `src/terminal.js:88-95` → `cl_branch_register` (`20261004120000_multi_terminal_identity.sql`, §3) |
| "+ Add a terminal" on a main till (shown only on an active main-branch till) | `src/terminal.js:233-237`, modal at `:353` |
| Main issues a join code for an existing branch or a new one; seiGEN refuses unless the caller is an active main-branch till | `src/terminal.js:111-117` → `cl_branch_issue_join_code` (latest: `20261023180000_update_app_first_message.sql`, from about line 35) |
| Code format: 8 characters from a 31-character alphabet without 0/O/1/I/L, about 39.6 bits, shown `ABCD-EFGH`; seiGEN keeps only its SHA-256 | `cl_new_join_code` (`20261004120000…:198-204`); `cl_branch_join_codes.code_hash` (`:124-133`); `formatJoinCode` (`src/terminal.js:197`) |
| Validity: 24 h by default, 1–72 h allowed | `cl_branch_issue_join_code`: `make_interval(hours => greatest(1, least(coalesce(p_valid_hours, 24), 72)))` |
| The new device types the **business phrase** and the code | `src/setup.js:19-22, 101-146`; Settings card `src/terminal.js:210-216` |
| Join: lockout of 10 wrong codes per install per hour; code lookup by hash; phrase check; single use (`used_by_terminal`); expiry; app build ≥ 21; Admin passcode seed; Lite branch limit; then the till row | `cl_terminal_join` (`20261023120000…`, from line 153) |
| **What decides branch and till:** the code's `branch_id` (main picks the branch when issuing); till code = the next `T<n>` of that branch | `cl_next_till_code` (`20261004120000…:206-209`); `cl_terminals.till_code check '^T[0-9]{1,3}$'` (`:116`) |
| The device stores business, branch, `is_main`, terminal and till | `storeTerminal` (`src/terminal.js:45-56`) |
| Business & Terminals list: branches → tills, last seen, Deactivate/Reactivate, "Set its Admin passcode" | `loadTerminalList` (`src/terminal.js:276-300`) → `cl_branch_list` |
| A deactivated till can still sell offline | `TERMINAL_INACTIVE_TEXT` (`src/terminal.js:157`) |

**How licences and billing count devices (VERIFIED):**
- Each device has its own signed licence.
- The price comes from `cl_plan_price` (`20261013120000_price_plans.sql:188-227`). The device's role is `main` if it is the lowest-numbered active till of the main branch, `branch` if the lowest of another branch, and `till` otherwise. The fee is that role's (Business 15/7/3, Lite 6/–/3).
- The Console's per-business bill is `cl_plan_accounts` (`:400` on), which adds `cl_plan_price` over every terminal of the business.
- The app shows **this device's** role and fee only: `licencePlanText` / `cl_licence_terms` (`src/activation.js:565-590`). There is no business total in the app today.
- **UNVERIFIED:** where "due-date banner" text names a price. I found no amount in the banner code. To check: read `refreshLicenceLock` and the banner render in `src/activation.js`.

**Reuse:** an invite is a join code with more columns: a kind, a person, a role, revoked and approval fields. It is issued and redeemed through the same table and the same hash-and-single-use logic, not a parallel system.

---

## 2. The seat as a device type

### 2.1 Data model
- `cl_terminals.kind text not null default 'till' check (kind in ('till','seat'))`.
- A seat gets the till code `S<n>` (its own sequence per branch).
  - The till-code check becomes `'^[TS][0-9]{1,3}$'`.
  - Every `substr(till_code, 2)::int` still works.
  - But every **ranking** of tills must filter `kind = 'till'`. Otherwise a seat could become the "main" device ($15) when T1 is deactivated.
  - Places that rank tills: `cl_plan_price` (role), `cl_plan_accounts` (order), `cl_next_till_code`. **VERIFIED** by grep: `substr(…till_code, 2)` appears only in `20261004120000` (1 place) and `20261013120000_price_plans.sql` (3 places). Other lists only sort by till code (`20261024120000:168`, `20261106120000:134`), and a seat's `S…` code sorts after the `T…` codes.
- Seats only on the **main branch**: seiGEN refuses a seat invite for any other branch.

### 2.2 In the app (what the seat hides)
- **Signed licence features bit 1 = seat**, plus a `terminal_kind = 'seat'` setting from the join. The licence bit wins: a seat setting without the bit, or the bit without the setting, both mean seat.
- **Hidden on a seat:**
  - Sell, Credit (it takes payments), End of Day, iTred orders (they sit under `m.sell`, `src/roles.js:89`) and the cash drawer;
  - the "Activation secret phrase" card;
  - single operator mode.
- **The seat's effective rights** = the person's role rights **minus** `m.sell, m.credit, m.eod, void_return, credit_over_limit`. This removal is fixed in the app and on seiGEN, whatever the role says.
- **The home screen** is "Office" (Products / Product List, Stock by branch, Receive, Supplier GRV, Dispatch, Stocktake, Adjustments, Reports, Report Writer, Directory, Settings → Staff & Roles, Business & Terminals), each shown only if the person's rights allow it.

### 2.3 On seiGEN (what's refused)
- `cl_stock_sale` (shared-stock sale) refuses a seat with `SEAT_NO_SELLING`.
- Any future sale or EOD upload refuses it the same way.
- `cl_branch_issue_join_code` for tills or branches: allowed only for the Owner or an Admin signed in on the seat (§3).
- `cl_device_checkin` and `cl_licence_*` behave as for a till, but the licence carries the seat bit.
- Every other call requires a staff token with the call's right (§3).

### 2.4 Stock: holding, main's total, and moving it
- **Holding.** A seat holds its own stock exactly like a till: its own local database, its own figures pushed with `cl_device_stock_levels_push`. Main's total is the **sum of main's active devices**, seats included, with each device's own figure under it (the rule is in the header of `20261024120000_branch_stock.sql`). VERIFIED. Nothing new is needed beyond a "Seat" label next to the figure.
  - `cl_bs_enabled` (2+ active tills) should count seats. **ASSUMED:** the owner wants a T1 plus a seat to show per-device figures. A seat is a second stock holder.
- **Moving stock from the seat to a main till (store room → shop floor).** This is not possible today (§0.2). Options:
  - **A (recommended): an "internal transfer"** between two devices of the **same branch**, through seiGEN. It is a Delivery Note with `from_branch = to_branch` and a target terminal, received on that till like an incoming dispatch. Main's total is unchanged, and each device's figure moves.
    - It needs a new table, or a `to_terminal_id` column plus the change of the `from_branch_id <> to_branch_id` check to "or a target terminal is set". The DN numbering is reused.
    - No costs move, and no inter-branch charge is raised.
  - **B: no moves.** The seat only receives and dispatches to other branches; main's tills receive their own supplier goods. This is simpler, but the "stores point" can't feed main's own shop floor.
  - The recommendation is **A**, as part of Seat-B. It is its own migration and test set, and it is the largest piece of Seat-B.

### 2.5 Stocktake on a branch with several tills plus a seat (proposed rule)
- Today a stocktake counts the device's own stock: one open stocktake per branch **on that device**, and other branches are read-only (`src/stocktake.js:7-15, 53-62`). VERIFIED.
- **Rule:** each device counts and posts **only the stock it holds**.
  - The seat counts the store room. Each till counts its own shelf or counter.
  - The stores clerk on the seat posts the seat's count only. They can't post into a till's figure, because they don't hold that stock.
  - For a full count of main, every device of main counts on the same day. The seat shows a **"Main branch count" checklist**: each device of main, the date of its last closed stocktake, and its "last updated" time. It is read-only, from seiGEN's per-device figures.
- **Why:** each figure has one owner. Posting into another device's stock would make two writers of one figure and break "absolute figures, never movements" (`20261024120000_branch_stock.sql`, header).

---

## 3. Rights

- **Who can use a seat:** anyone whose role is allowed at main. Since v31 that is home branch main, "also works at" main, or Owner/Admin/Staff right (`20261108120000_shop_managers_everywhere.sql:50-57`). VERIFIED, applied today.
- **What each built-in role sees on a seat** (role rights minus the seat removal; `src/roles.js:33-39`):

| Role | On a seat |
|---|---|
| Owner, Admin | Everything except Sell, Credit, EOD; Staff & Roles; Business & Terminals (invites, approvals) |
| Manager | Everything except Sell, Credit, EOD, Settings, Staff, Terminals |
| Stores | Products, Dispatch, Receive, Adjust, Incoming, Product List, Stocktake, Purchasing/Supplier GRV, Reports, Report Writer |
| Cashier | Product List, Directory, Requests, Reports. **Recommend:** seiGEN refuses a seat invite for the Cashier role. |
| Custom (e.g. "Bookkeeper") | Its own rights minus the seat removal |

- **seiGEN checks every action.** On a seat, every device RPC except check-in, licence and staff sign-in requires `p_staff_token`. seiGEN checks it with `cl_shop_session` (`20261108120000…:60-73`) and maps each call to a right:
  - GRV → `m.receive`;
  - supplier GRV → `m.purchasing`;
  - dispatch → `m.dispatch`;
  - stock levels → `m.stocktake` / `m.adjust`;
  - catalogue push → `m.products`;
  - prices → `edit_prices`;
  - and so on.
- **What this changes:** on tills, these calls trust the device today; on a seat they would also check the person. This is new server code in about 15 functions. **UNVERIFIED:** the exact list; to check, use the RPC inventory in §7.

---

## 4. Billing

- **Seat = $3 per 30 days on both plans:** a new role `seat` priced at the plan's `till_fee`.
  - `cl_plan_price`: `v_role := 'seat'` when `te.kind = 'seat'`; ranks count `kind = 'till'` only.
  - This makes `cl_plan_accounts` (the Console) right with no change beyond its role text (`PLAN_ROLE_TEXT` in the Console's `index.html`, used at lines 1556, 1658, 1695: add `seat: "Office seat"`).
- **The app:**
  - `LICENCE_ROLE_TEXT` gets `seat: "Office seat"` (`src/activation.js:568`).
  - **New:** a "Your business's bill" line in Settings → About, the activation screen and the due-date banner, from a new device RPC `cl_business_bill` (Owner/Admin token). It shows each device's role and fee and the total, so seats are visible to the vendor. Today the app shows only its own fee.
- **Double billing:** one seat is one `cl_terminals` row is one licence. A seat re-joining on the same install answers with the same row (the existing retry rule in `cl_terminal_join`).
- **Lite plan:** recommend **allowed, $3**. A seat is at main, so Lite's one-branch limit isn't touched, and Lite's `till_fee` is already $3.

---

## 5. The invite and the install page

### 5.1 The code and the link
- **The code:** the same 8-character, 31-symbol alphabet as join codes, shown `K7Q4-M9TX`. seiGEN keeps only its SHA-256.
  - It is single use, valid 24 h, and tied to **one named person** (a `cl_shop_staff` row: existing, or created with the invite) and **one role**.
  - The code is not a secret phrase, a passcode or a key. It is a one-time ticket that can do nothing without the Owner's or Admin's approval.
- **The link:** `https://<the app's own address>/#seat=K7Q4M9TX`.
  - The code goes in the **`#` fragment**, which the browser never sends to any server. This is the same pattern as the activation link `#lic=` (`src/activation.js:356-366`). VERIFIED.
  - The address is the app's own (today `mobilepos-preview…` for phones and PCs).
  - Nothing else is in it: no business id, no name, no phrase.
- **The lockout:**
  - **5 wrong codes per install in 1 hour** lock joining for an hour. This is stricter than the 10 for tills.
  - A per-business limit isn't possible, because a wrong code doesn't say which business it was aimed at.
  - **Recommendation:** per-install 5/hour only. A new install ID gets around a per-install limit, so the real protection is the 39.6 bits of entropy, the 24-hour validity and the approval step.
  - **UNVERIFIED:** whether seiGEN can read the caller's IP address (`request.headers`) to add a per-address limit. To check: one test call on the preview.
- **Revoke:** in the invite's row on Business & Terminals ("Revoke"). Used, expired and revoked invites stay listed for 30 days.

### 5.2 Screens (wireframes; the screenshots come in Seat-B)

**Create invite** (Business & Terminals → "+ Invite an Office seat"; Owner or Admin, signed in, online)
```
390 px                                   1280 px: the same fields in a 520 px modal
┌──────────────────────────────┐
│ Invite an Office seat        │
│ For the main branch. No till:│
│ no selling, payments or EOD. │
│ Person  [Tendai ▾ | + New]   │
│ Role    [Bookkeeper ▾]       │
│ $3 per 30 days, like a till. │
│ [ Create invite ]            │
└──────────────────────────────┘
```
Then: the code in large type, **Share on WhatsApp**, **Copy message** and **Copy code**, "Valid until <time tomorrow> · one use · for Tendai only", and **Revoke**.

**The WhatsApp message** (the only text that is shared):
```
Hi Tendai, you're invited to <Business> on seiGEN Commerce Lite as an Office seat (Bookkeeper).
1. Open this link in Chrome (Android/PC) or Safari (iPhone): https://mobilepos-preview.seigendc.workers.dev/#seat=K7Q4M9TX
2. Install the app, then open it.
3. Your code: K7Q4-M9TX (one use, valid until <date time>).
Don't forward this message.
```

**The install page** is the app's own first screen when it opens with `#seat=`. It is not a separate site, so it is always on the right address. It adjusts to the device:

| Device | What it shows |
|---|---|
| Android, Chrome | "Join <Business> as an Office seat" · **Install** (when Chrome offers it) · the code with **Copy code** · "After installing, open the app from your home screen: the code is filled in." |
| PC, Chrome or Edge | the same; "or the install icon in the address bar" |
| iPhone/iPad, Safari | the steps "Share ⬆ → Add to Home Screen", then "Open the app and paste the code" · **Copy code** |
| WhatsApp/Facebook in-app browser | ⚠ "You're inside WhatsApp's browser. Tap ⋮ → Open in Chrome (iPhone: Open in Safari)." · the code with **Copy code** · **no Join button** |
| Windows .exe | (no link) Setup → "Join as an Office seat" → type the code |

- **The install prompt is not guaranteed:**
  - The browser decides whether `beforeinstallprompt` fires (`src/pwa-extras.js:65-69`, VERIFIED). So the code is always on screen, and joining never depends on the prompt.
  - "Code filled in" works by the page saving the code (only the code) in this address's storage. The installed app reads it at first launch and then deletes it.
  - **ASSUMED:** installed PWAs on Android Chrome and desktop Chrome/Edge share storage with the browser at the same address, and iOS home-screen apps don't. That is why iPhone pastes the code. **UNVERIFIED** on the devices: Seat-B tests it on each.

**Joining is allowed only where the data will live:**
- inside the installed app (`display-mode: standalone`, `src/pwa-extras.js:17-21`), or in the .exe;
- **never in a browser tab.**

This blocks in-app browsers by construction, so it doesn't rely on detecting them. The in-app browser detection is only there to explain what to do. **UNVERIFIED:** the detection itself, by user-agent markers: `FBAN`/`FBAV`/`FB_IAB`/`Instagram`, and `WhatsApp` where present. WhatsApp's markers vary by version, so Seat-B tests the real apps.

**Join** (in the installed app): the code, then "Tendai, Bookkeeper at <Business>", then **Set your PIN** (4–6 digits, twice), then:
- **Waiting for approval:** "Waiting for approval by the Owner or an Admin. Ask them to open Business & Terminals on a main till. This screen updates by itself." It checks every 30 s while online.

**Approve device** (Business & Terminals, on any device of the Owner or an Admin; a banner "1 Office seat waiting for approval"):
```
┌──────────────────────────────┐
│ Office seat waiting          │
│ Tendai · Bookkeeper          │
│ Joined 10:42 from Android    │
│ Chrome · invite by <Admin>   │
│ Device check: 4F-9A          │
│ [ Approve ]   [ Refuse ]     │
└──────────────────────────────┘
```
- The "device check" is 2×2 characters derived from the seat's device key. **It is shown on both screens**, so the approver can confirm by phone that it is Tendai's device. This is a recommendation.
- After approval, the seat downloads main's data: catalogue, staff and roles, branches, then its first stock levels. Then "Ready".

**Revoke / remove a seat:** the invite row "Revoke" before use. After use, the seat row has "Deactivate", as for tills.

---

## 6. Offline

- **Offline, a seat can:** GRV, Receive, Adjust, Stocktake (counting and posting), Products (if the right allows), Reports and Report Writer on its own data, and sign-in with the PIN (offline sign-in, `src/roles.js:130`). Its stock shows "last updated <time>", like a till.
- **It needs seiGEN for:**
  - joining, approval, invites, revoking;
  - supplier GRV and suppliers (seiGEN-backed today), dispatch send/receive, internal transfers;
  - other branches' figures, and the staff and role pull.
- **If the seat's licence expires,** it locks like a till. **ASSUMED:** the same `refreshLicenceLock` rules apply.

---

## 7. Database outline (migration `20261109120000_office_seats`, after the latest applied `20261108120000`)

- **`cl_terminals`:** add
  - `kind ('till'|'seat')`;
  - `approved_ts`, `approved_by_staff`, `approval_status ('pending'|'approved'|'refused')`, defaulting to `'approved'` for every existing row;
  - the till-code check `'^[TS][0-9]{1,3}$'`.
  - A pending or refused seat is refused by every device RPC except `cl_seat_status` (new) and `cl_device_staff_set_pin` for its invited person.
- **`cl_branch_join_codes`:** add
  - `kind ('till'|'seat')`, `staff_id`, `role_id`;
  - `issued_by_staff` (the session's person), `revoked_ts`, `revoked_by_staff`.
- **`cl_seat_join_failures`** (install_id, ts): the 5/hour limit, or a `kind` column on `cl_join_failures`.
- **The seat's device phrase:** `cl_vendors.shop_secret_phrase` is set to a random 32-byte value at join and returned once. The column already exists. **UNVERIFIED:** whether a hash would be safer. Today the column holds the phrase as typed, used by `cl_install_vendor`.
- **New RPCs:**
  - `cl_device_seat_invite_create` (Owner or Admin token, main-branch device, online);
  - `cl_device_seat_invites` (list), `cl_device_seat_invite_revoke`;
  - `cl_seat_join` (code + install + device key, **no phrase**) → the seat row (pending), its device phrase, the person and the role;
  - `cl_seat_status` (pending, approved or refused);
  - `cl_device_seat_approve`, `cl_device_seat_refuse` (Owner or Admin token);
  - `cl_business_bill` (Owner or Admin token).
- **Changed RPCs:**
  - `cl_plan_price` (role `seat`, ranks by tills);
  - `cl_licence_prepare` (features bit 1 for a seat);
  - `cl_stock_sale` (refuses a seat);
  - `cl_next_till_code` (per kind);
  - the device RPCs that a seat may call, which require a staff token with the right (§3);
  - `cl_branch_list` (kind and approval on each device).
- **Audit:** `cl_activity_log` rows for invite created, revoked, wrong code (per install), joined, PIN set, approved, refused, and seat deactivated. They hold no code, no phrase and no PIN.
- **RLS:** new tables RLS on with no policies, as for the other `cl_` tables. The functions are `security definer` with fixed `search_path`; the helpers are revoked from anon and authenticated.
- **Rollback:** drops the new functions and columns and restores the changed functions. A refused or pending seat row would be removed by the rollback only if it has no licence.

---

## 8. Risks

| Risk | What protects against it |
|---|---|
| A forwarded link or code | The invite names one person; the joiner sets **their** PIN; the approver sees the name, the device type and the device check, and confirms by phone. Without approval the seat gets no data. |
| A stolen code within 24 h | The same approval step; single use (the real person's join then fails with "already used", which tells the Admin something is wrong); revoke; 5 wrong codes per install per hour; audit. |
| A seat with old stock | "Last updated" on its figure on main; a banner on main when a seat hasn't pushed for 48 h (**recommendation**); main's total uses each device's last push, as for tills. |
| Double billing | One install is one terminal row is one licence; a retried join answers the same row; the Console's list labels seats. |
| A new way into the business | The seat never gets the business phrase; it has its own random device phrase, its PIN and seiGEN's token checks on every call; the licence's seat bit (a seat can't become a till by changing settings); approval by Owner/Admin only; invite creation by Owner/Admin only; everything audited. |
| The seat's data lives at one address | See §9 (the domain move). |

## 9. The .exe, and the domain move

- **.exe:** **recommend that seats don't use it.** It can't open the link, and it can't update itself. The installed web app in Chrome or Edge on a PC does everything a seat needs and updates by itself. The .exe keeps "Join as an Office seat" with a typed code only for shops that insist.
- **Domain move to `seigencom.africa`:**
  - A seat's data (its stock above all) lives at the preview address. Opening the new address starts empty.
  - **Proposal:** before the move, each seat uses Backup → Replace on the new address. Alternatively, a "move this device" join with a new invite that seiGEN binds to the **same** seat row, with no new licence and no new bill, after which the seat restores from a backup file.
  - **UNVERIFIED:** whether Backup → Replace keeps the device's own identity correctly at a new address. `DEVICE_OWN_SETTINGS` lists `install_id, device_key, secret_phrase` (`src/backup.js:185`); to check, read how Replace treats them.
  - **I found no domain-move plan in the repo** (`docs/` has none). This ties in when that plan exists.

---

## Questions (each with a recommendation)

1. **Single operator mode never on seats?** **Yes.** A seat is shared by admin people with different rights, and `can()` allows everything when nobody is signed in (§0.5). On a seat, with nobody signed in only the PIN screen shows.
2. **Supplier GRV on a seat?** **Yes.** A seat is main, and supplier GRV is main-only (`src/supplier-grv.js:29, 60`, `isRemote()`). It also needs the `m.purchasing` right.
3. **Who creates invites?** **Owner and Admin only**, not every holder of the Staff right. An invite is a new device in the business and a new $3 line on the bill, which is more than managing people. Approving is also Owner and Admin only.
4. **Seat → till, or till → seat?** **Not in Seat-B.** It would change the licence bit, the price role and the stock holder. To change, deactivate one and join the other. Later, perhaps, as a seiGEN-staff action.
5. **Seats on Lite?** **Allowed, $3** (§4).
6. **Store room → main's tills (internal transfer)?** **Build it in Seat-B** (§2.4 A). Without it the seat can't feed main's shop floor. If not, Seat-B still works, but stock received on the seat stays on the seat until it is dispatched to another branch.
7. **Cashier role on a seat?** **Refuse** (§3).
8. **Ambiguous:**
   - (a) "Accounts and payroll later": no rights exist for them yet, and nothing is planned here.
   - (b) "Due-date banner shows the bill": I found no amount in the banner today (§1 UNVERIFIED). The proposal is to add the business total there.
   - (c) "5 wrong codes lock joining **for a while**": the proposal is 1 hour, per install.
   - (d) Does a seat count towards `cl_bs_enabled` (2+ devices: per-device figures)? The proposal is **yes**.
