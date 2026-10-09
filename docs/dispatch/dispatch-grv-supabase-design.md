# Dispatch & GRV through Supabase: Stage A design

Status: **design only, nothing built.** Waiting for "go Dispatch-B".
Date: 2026-10-09. Facts come from the repo (file:line) or from live (read-only). It follows the owner's six decisions of 2026-10-09.

---

## A1. What exists today (VERIFIED)

### The flow today: file-based, numbered, never twice

**Sender: the Dispatch screen** (src/dispatch-out.js, 556 lines; one screen for phone and desktop; desktop adds the hamburger drawer).
- It picks the destination from the **branch register** (`branch_register` table, maintained on the main branch and merged to others, src/dispatch-out.js:5-7).
- It reserves a **DN number** and makes the **DN file**.
- **Stock leaves the sender at dispatch:** `moveStock({ delta:-qty, kind:"dispatch", docType:"dn", docUid:dnUid … })` (src/dispatch-out.js:212).

**DN file** (src/dnfile.js):
- Canonical JSON with a SHA-256 checksum.
- **Deliberately no cost or selling price** in it, "Remote branches must never see costs" (:10-11).
- v3 adds till codes and "replaces".

**Receiver: import, review, accept or report a variance** (src/receive-in.js, src/dnreceive.js).
- **The receiver can never edit a quantity.**
  - Accept adds **exactly** the DN's quantities, at the moment the GRV number is reserved (`moveStock({ delta:l.item.qty, kind:"receive", docType:"grv" … })`, src/receive-in.js:46-66).
  - If the count differs, the receiver files a **variance report**: **no stock moves and no GRV number is used** (:81-98).
- **Receiving never creates a product.** Every line must match exactly one product, by code, else by a unique exact name. Otherwise the whole receipt is blocked (src/dnreceive.js).

**The sender imports the GRV file back** (src/grv-import.js). The DN becomes `received`. Stock is never touched there.

**Cancel, reissue, close as loss** (src/dn-cancel.js, src/dncancel.js):
- **Only the dispatching device, with the Admin passcode.**
- Notice and confirmation files go back and forth. Stock is posted only when confirmed, in one transaction: restore, replacement, write-offs.
- Write-offs are **ADJ** documents (`stock_adjustments`, src/adjust.js: a reason, the Admin passcode, a note).

**Local tables** (src/db.js:107-232):
- `dispatch_docs`, keyed by **(dispatch_branch_id, dn_no)**, with `direction` in/out, status, GRV number, variance JSON and cancel fields;
- `dn_events` (`event_key` UNIQUE);
- `dn_cases`;
- `stock_adjustments`;
- `stock_received` (the "received" ledger);
- `stock_movements` (the item ledger, with `docUid`);
- `doc_counters`.

**Protection against double import:** the `dispatch_docs` 'in' row for (dispatching branch id, DN number) (src/receive-in.js:13, 117). A second import of the same DN is answered "already received as GRV…".

**Numbering** (src/docnum.js):
- **DN** per dispatching device; **GRV** per receiving device;
- the display adds the till code: DN-T1-0012, GRV-T2-0007, ADJ-T1-0003, CXL-T1-0002;
- 4 digits, growing past 9999.

**Reports** (src/report-writer.js):
- **Stock Received** (:32);
- **Stock Dispatched** (:167);
- **Stock Movements**, the item ledger (:189, main branch only);
- DN status from `dn_events` (src/dnstatus.js: received, variance, awaiting, cancelled…).

**Permissions today:**
- **any signed-in staff** may dispatch and receive;
- **the Admin passcode** is needed to cancel, reissue, close, write off and adjust;
- staff roles are **Admin** or **Cashier** (src/staff.js:37).

### Supplier purchases today (src/purchasing.js, "Purchasing & Receiving")

- **Main branch only.** Cost data is hidden from remote branches.
- Each line: product (search or **create a new one**), qty, unit cost.
- **It overwrites `products.cost` with the latest unit cost** (no averaging).
- It writes a `purchases` row and a `stock_received` row, and `moveStock(kind:"purchase")` (:95-140).
- **No invoice number, no supplier list** (free-text supplier), **no delivery cost, no duplicate check, no sync.**

### Product identity across branches

- **Catalogue-synced products** (Phase 3a) carry `cat_uid` locally. On the server they're `cl_catalogue_products (business_id, product_uid)`.
- Branch-only products have no `cat_uid`.
- The DN file matches by **code, then name**, never by `cat_uid` today.

### Shared stock (Phase 3b)

- On a shared-stock till, `moveStock` is **intercepted** (src/shared-stock.js:91-110) and goes to the server (`cl_stock_move`, 20261007120000:413). Branch-only products keep local stock.
- **Live:** 1 branch is in `shared` mode (test data) and 11 are `local`.
- **Never start shared stock on real branches** (unchanged).

### Server plumbing to reuse

- **Device auth:** `cl_install_vendor` / `cl_catalogue_caller` (install ID + phrase + device key), `terminalRpc` (src/terminal.js:64). Device RPCs answer refusals as data, not errors.
- **Business, branches, tills:** `cl_businesses`, `cl_branches`, `cl_terminals` (join codes).
- **Check-in hooks:** devicecheckin.js already runs `rpnAfterCheckin` and `marketAfterCheckin`. A `dispatchAfterCheckin` fits the same pattern.
- **The sync.js outbox** suits small records. Dispatch and GRV documents are small: ≤ 500 lines of text.

### On live (read-only)

- **No dispatch, transfer, GRV or supplier tables or RPCs exist.**
- Related: `cl_stock_events` (23), `cl_branch_stock` (2), `cl_catalogue_products` (15), `cl_branch_prices` (0), `cl_till_allowance` (4).
- **Test business with two joined branches:** Mandie Babyware, **Harare (main: T1, T2, T3) → Murehwa (T1)**.

---

## A2. Design

### Principle: the server holds the documents; each device's stock follows the documents exactly once

- **The server is the authority** for a dispatch and its GRV (decision 1).
- **Local stock stays where it lives today:** on the device, or on the server for a shared-stock branch.
- **Every stock change is tied to a document uid.** A device applies a document's stock **only if its own item ledger has no movement for that uid**, and it re-applies it after a restore if the server says the document stands.
- **The rule is the same everywhere: exactly once.**

### 1. The flow (B1)

Only for **branches of the same business joined with join codes**. Anything else is refused: "You can only dispatch to branches of your own business. Ask that branch to join with a join code."

1. **The sender creates the Dispatch:**
   - destination branch;
   - lines (catalogue uid if any, code, name, qty, **unit cost**);
   - **delivery cost** (amount, currency, optional carrier and reference).
   - It reserves **DN-T1-0012** as today, and **stock moves out at once** into "in transit (ours)", tied to the dispatch uid.
2. **Sending:** `cl_device_dispatch_send(…, p_dispatch jsonb)`.
   - **Idempotent by the dispatch uid**, and unique on (sending terminal, DN number).
   - Offline: it's queued (outbox) and sent on reconnect or after a check-in.
3. **The receiver sees it** in **Incoming dispatches**: `cl_device_dispatch_pull` after a check-in or Refresh, and when the device comes back online.
4. **The receiver counts each line:** received, short, damaged, extra, and a note. **The receiver may now enter what it counted.** That's new: today it can only accept or report a variance.
5. **Posting the GRV:** `cl_device_grv_post(…, p_dispatch_uid, p_grv_uid, p_grv_no, lines, price_changes)`.
   - **One GRV per dispatch, first wins.**
   - It's **idempotent by GRV uid**.
   - Received (and extra, see §3) quantities come into the receiver's stock **at that moment**.
6. **The sender sees the result** at its next pull: **received in full**, or **received with differences**, line by line.

**Server tables:**
- `cl_dispatches`: uid, business, from/to branch, from terminal, DN display and sequence, delivery cost, status, timestamps, GRV uid/number/terminal/time;
- `cl_dispatch_lines`: line, catalogue uid, code, name, qty, unit cost, received / short / damaged / extra, note;
- `cl_dispatch_issues`: shortages, damage and extras to resolve;
- `cl_interbranch_charges`: §14.

**Access:**
- **Device RPCs only:** the sender's terminal, or a terminal of the receiving branch.
- Staff read through a Console RPC (§11).
- No API access to the tables.

### 2. Stock timing (decision 3): sender-owned while in transit

| When | Sender | Receiver |
|---|---|---|
| **Dispatch** | sellable stock **−qty** (movement `dispatch`, document = dispatch uid) | nothing |
| **In transit** | **"In transit (ours)"** = the sum of unposted dispatch lines, valued at cost. Shown on the sender's stock reports (In-transit list; Stock value: on hand + in transit). | **"Incoming (not ours yet)"**, shown, not counted in stock |
| **GRV** | the dispatch is closed, or has issues to resolve | sellable stock **+received** (movement `receive`, document = GRV uid) |

**On a shared-stock branch:** the same movements go through `cl_stock_move` with the same document uids. No local change.

### 3. Differences (decision 4)

**Short or missing:**
- At the GRV, short quantities go to `cl_dispatch_issues` (kind `short`).
- At its next pull, the **sender's device returns them to its sellable stock** (movement `dispatch_return`, document = issue uid). They're now out of transit.
- The issue shows in the sender's **Shortages to resolve** list, with two options:
  - **Write off:** an ADJ document, reason, Admin passcode and staff name, using the existing adjustment code (src/adjust.js), linked to the issue. Stock goes −qty; the issue closes.
  - **Found / re-dispatch:** a new dispatch of the found quantity, linked to the issue. The issue closes.

**Damaged:**
- **Recommendation: the same path as short** (back to the sender on paper, then written off by the sender).
- The issue is flagged **"damaged: the goods are at the receiver"**, so the sender knows where they physically are.
- **Reason to differ (your call):** physically the damaged goods sit at the receiver. If you'd rather, the receiver writes them off at the GRV. **I recommend the sender path, as decided,** because the sender owns them.

**Extras** (received more than sent):
- At the GRV, the extra comes **into the receiver's stock**: the goods are there and can be sold.
- An `extra` issue goes to the sender: **"Confirm the extra"** takes it off the sender's stock (movement `dispatch_extra`), because it was really sent.
- **"Dispute"** keeps it open for the two managers to settle.

**Audit:** every issue keeps who, what, when and why. The activity shows on both sides and in the Console view.

### 4. Cancel and correct

**Cancel before the GRV:** `cl_device_dispatch_cancel`, only the sending device (Admin passcode, as today).
- If the server has **no GRV yet**: cancelled, and the sender's stock comes back (movement `dispatch_cancel`). The receiver's Incoming list drops it.
- **If a GRV is already posted, the cancel is refused:** "Already received as GRV-T1-0007".
- An offline cancel that arrives after a GRV is refused the same way, and the sender is told.

**After the GRV: never an edit.** A **return dispatch** (receiver → sender) linked to the original carries goods back. Wrong counts are fixed by the issue flow.

**The old file-based cancel, reissue and close** (dn-cancel.js) stays only for file-only DNs.

### 5. Product matching

1. **Catalogue uid first**, when both sides have the product from the catalogue.
2. **Then code, then a unique exact name**, as today.
3. **Missing at the receiver:**
   - **With a catalogue uid:** **create the local product from the catalogue** automatically (name, code, catalogue price), linked. It's the same business's catalogue, so nothing is invented.
   - **Without one:** the line is **flagged**. The receiver picks an existing product or **creates it from the dispatch data** (name, code; selling price entered), with the **Admin passcode**.
   - Remote branches may do this only here: a narrow exception, as the old transfer receive already had.

### 6. Costs and prices

- **The unit cost travels on the server record.** Today's rule says remote branches never see costs, so **the cost is shown only where costs are shown today**: main-branch devices and the Console.
- **On a remote receiver**, costs are applied to the item cost silently and **not displayed** (question 1).
- **The receiver's item cost** becomes the landed unit cost (§14). It overwrites, as purchases do today (no averaging). That's a question for later.
- **Selling price:** §16.

### 7. Numbering

- **No change** to how numbers are made: DN per dispatching device, GRV per receiving device, ADJ for write-offs.
- **The DN number shows on both sides** and on every GRV, issue and report.
- **The server enforces uniqueness:** (sending terminal, DN sequence); (receiving terminal, GRV sequence).

### 8. Offline and conflicts: never twice

| Case | What happens |
|---|---|
| **Both offline** | Each side does its part locally. The sender's dispatch is queued. The receiver can't receive what it hasn't pulled yet; it waits. |
| **The same dispatch sent twice** (retry, double tap) | Same uid → "already have it" |
| **Two tills of the receiving branch both post a GRV** | The first to the server wins. **The second device is told and reverses its own local receipt automatically** (movement `receive_reversed`, linked), with a notice. |
| **A reinstalled device** | It pulls by branch, so incoming dispatches reappear. Stock is applied only for documents this device hasn't applied: **its ledger is checked by document uid.** |
| **A restored backup** | After a restore, the device reconciles. For every server document of its branch that it posted (dispatch, GRV, return, write-off), it re-applies the stock **only if its ledger has no movement for that uid**, and **removes nothing that's there**. So it's once, whatever the restore point. |

### 9. The file

- **A DN file stays an alternative** for sharing and for branches that aren't registered.
- **A DN v4 file carries the dispatch uid.**
- **Importing a file for a dispatch the server already holds is refused:** "This Delivery Note already arrived through seiGEN (GRV-T1-0007)" or "…is waiting in Incoming dispatches".
- For older files, the match is (dispatching branch id, DN number) from the server.

### 10. Reports

| Report | What changes |
|---|---|
| **Stock Dispatched** | adds the server status (sent, received, received with differences, cancelled) |
| **Stock Received** | adds the source (dispatch or supplier) |
| **In transit** (new) | per destination, lines, value at cost (on cost-visible devices) |
| **Differences** (new) | short, damaged, extra; resolved or open; write-off ADJ numbers |
| **Item ledger** (Stock Movements) | new movement kinds: `dispatch_return`, `dispatch_cancel`, `dispatch_extra`, `receive_reversed`, `write_off` (ADJ), `supplier_grv` |

### 11. The Console

- **Recommend: a small read-only "Dispatches" view per business**, for support, built with B1: list, status, lines, issues. No actions.
- It's cheap, and helps when a shop phones in. It can wait if you prefer.

### 12. Permissions in the app

| Action | Who |
|---|---|
| Dispatch | any signed-in staff (as today) |
| Receive and post a GRV | any signed-in staff (as today); the counts are recorded with their name |
| Cancel a dispatch | Admin passcode, sending device (as today) |
| Write off a shortage or damage | **Admin passcode** on the sending branch (question 3) |
| Change a selling price at a GRV | **Admin passcode** (§16) |
| Create a missing product at the receiver | Admin passcode |

### 13. Tests, risks, rollback

**Tests:** every item in your Stage B list, including:
- stock exactly once across retries, double taps, a reinstall, a restore, and two tills posting the same GRV;
- the existing dispatch, DN-file, receive, cancel and docnum tests all still pass.

**Risks:**
- Changing how stock moves is the riskiest work in the app. It's mitigated by document-uid reconciliation, PGlite tests on the server side, and browser tests on two simulated devices.
- Receivers may now enter counts. That's new behaviour; today they can only accept or report a variance. Training note needed.

**Rollback:** drops the new tables and RPCs. **It refuses while dispatches exist.** The local app keeps the file flow throughout.

### 14. The delivery cost (decision 2)

**Recommendation: both.**
- **Landed cost:** the delivery cost is **spread over the received lines by value** (by quantity when there are no costs) and added to the receiver's unit cost.
- **Inter-branch charge:** recorded on the server (`cl_interbranch_charges`: receiving branch owes the sending branch the amount and currency, linked to the dispatch), shown on both branches' reports.
- **Short delivery:** the **whole** delivery cost still lands on what was received. The carrier was paid for the trip. It isn't split back to the sender.
- **Shown on:** the Dispatch screen (entered), the GRV (shown, and its per-unit effect where costs are visible), the In-transit and Differences reports, and the inter-branch charges list.

### 15. Supplier GRVs (B2, decision 5)

- **Suppliers:** a **shared list per business** (`cl_suppliers`: name, phone, notes), pushed and pulled like the catalogue (question 5).
- **A supplier GRV on the device:**
  - supplier;
  - **invoice number** (required);
  - lines (product, qty, unit cost);
  - delivery cost (landed by value);
  - optional selling-price changes (§16).
  - **Stock comes in on posting**, tied to the GRV uid.
- **Sync:** `cl_device_supplier_grv_post`.
  - **Idempotent by GRV uid.**
  - **A duplicate invoice is refused:** the same supplier + invoice number within the business. "Invoice INV-123 from Acme Supplies was already received as GRV-T1-0004 on 8 Oct".
  - A device that posted offline and is refused **reverses its local receipt** with a notice, as in §8.
- **What changes from today's Purchasing screen:**
  - the supplier picker comes from the list;
  - the invoice number is required;
  - delivery cost is added;
  - creating a new product stays (main branch).
  - It stays **main-branch only** unless you say otherwise: costs again.
- **Reports:** Stock Received by supplier; Purchases by supplier and invoice.

### 16. Selling-price change at a GRV (decision 6)

- **Who:** the **Admin passcode**.
- **Shown:** current → new price, and the margin on the landed cost (where costs are visible).
- **Where it applies: the receiving branch only** (question 6).
  - On a registered branch it's written as a **branch price** (`cl_branch_prices`, which exists and is empty on live), so **every till of that branch gets it** at its next catalogue pull.
  - On an unregistered device it applies locally.
- **Audit:** a price-change line on the GRV (old, new, who), the local `audit_log` and the business activity. The item ledger shows it as a zero-quantity "price change" row.

**Build order:**
- **B1:** dispatch and GRV, issues, delivery cost, the Console view.
- **B2:** suppliers and supplier GRV, price changes.
- Each part has its own migration and its own "apply".

---

## Questions for you (each with a recommendation)

1. **Costs on remote branches:** today remote branches never see costs. Keep that, so landed cost is applied but not shown on remote devices? **[Recommend: keep it.]**
2. **The delivery cost:** both (landed cost + inter-branch charge), and **not split** on a short delivery? **[Recommend: both; not split.]**
3. **The write-off:** only with the **Admin passcode** on the sending branch? **[Recommend: yes.]**
4. **Damaged items:** like shortages (back to the sender, then written off), flagged as "at the receiver"? **[Recommend: yes, as decided.]**
5. **Suppliers:** one shared list per business? **[Recommend: yes.]**
6. **Selling-price change at a GRV:** the receiving branch only, as a branch price? **[Recommend: yes.]**
7. **Receivers may now enter what they counted** (received / short / damaged / extra) instead of only accepting or reporting a variance. **[Recommend: yes, needed for decision 4.]**
8. **Dispatches to another business later?** **[Recommend: not now.]**
9. **Supplier GRV on remote branches?** Today purchasing is main-branch only. **[Recommend: keep main only for now.]**
10. **Ambiguities in today's data:**
    - The `branch_register` destination list is free text. Server dispatch uses joined branches instead, so a destination not joined to the business can only use the file.
    - A shared-stock test branch exists on live. It's test data, nothing to do.

**STOP: waiting for "go Dispatch-B" and your answers.**
