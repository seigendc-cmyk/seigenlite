# POS fixes: cart layout, customer combo, wholesale prices, stocktake search (Stage A design)

Status: **Stage A, design only. No app code, database or deploy has changed.** Stage B starts on "go POS-fixes-B".
Date: 2026-10-10. Branch: `activation-v2`.

Evidence labels:
- **VERIFIED**: I read the code, or measured it in a real browser.
- **ASSUMED**: my inference; it needs confirming.
- **UNVERIFIED**: not checked.

**Before screenshots and measurements:** `reports/shots/pos-fixes-before/` (gitignored).

They were taken with Chromium (Playwright) on unobfuscated copies of today's phone and desktop builds, made from `src/` the way `test/licence-e2e.test.js` does it. Each run used 320 products, a 40-line cart and Digital Commerce faked (`test/dc-fake.js`).

---

## 1. The cart layout

### 1.1 What's there (VERIFIED)

**The phone and PWA build** (`dist/`, `dist-pwa/` → mobilepos):
- The cart is a fixed drawer: `.drawer`, z 50, max-width 400 px ([src/styles.css:172-180](../../src/styles.css#L172-L180)).
- Its parts:
  - a list (`.drawer-body`, flex 1, scrolls);
  - a footer (`.drawer-foot`, **`max-height:60vh; overflow-y:auto`**).
- The footer holds, in this order ([src/router.js:156-187](../../src/router.js#L156-L187)):
  - the discount reason and approver;
  - the payment reference;
  - the document reference;
  - the customer name and phone;
  - the voucher;
  - exchange;
  - subtotal and total;
  - the currency selector;
  - Cash, EcoCash, Bank, Credit;
  - Split.

**The desktop build** (`dist-tauri/` → desktoppos):
- `.desktop-sales` is a flex row with `align-items:stretch; min-height:calc(100vh - 55px)` ([src/desktop/desktop-sales.css:6](../../src/desktop/desktop-sales.css#L6)).
- `.ds-cart` (380 px) is a flex column with the head, a scrolling body, and the foot ([:9](../../src/desktop/desktop-sales.css#L9), [:43-59](../../src/desktop/desktop-sales.css#L43-L59)).
- The markup is at [src/desktop/sales-desktop.js:45-76](../../src/desktop/sales-desktop.js#L45-L76) and [:109-190](../../src/desktop/sales-desktop.js#L109-L190).

**The header:** `.topbar` is `position:sticky; top:0; z-index:20` ([styles.css:31-37](../../src/styles.css#L31-L37)).

### 1.2 The cause (VERIFIED, measured)

**Desktop:**
- **Nothing limits the cart panel's height.** `align-items:stretch` makes the cart as tall as the product table beside it, and the page itself scrolls.
- So the cart body never scrolls on its own: its `flex:1` region simply grows.
- The foot (Pay buttons) ends up at the bottom of a panel that is as long as the product list.
- The cart head scrolls away with the page, up under the sticky header.

| Desktop build, 320 products, 40 lines | Cart panel height | Cash button | After scrolling 1,500 px |
|---|---|---|---|
| 1280×800 | **19,067 px** | at y = **18,975** (off screen) | cart head at y = −1,437 (gone under the header) |
| 1920×1080 | 19,067 px | at y = 18,975 | the same |
| 768×1024 | 39,579 px | at y = 39,487 | the same |

Screenshots: `desktop-build-1280-top.png`, `desktop-build-1280-scrolled.png` (and the 768 and 1920 ones).

**Phone:**
- When the drawer opens, Cash is visible (390×844: y = 725).
- But the footer takes 60% of the screen and **scrolls inside itself**. Its fields push the Pay buttons down: at 390 px the Split button is already cut off.
- Each further reveal moves Pay out of sight inside the footer's own scroll:
  - the discount reason and approver (when any line has a discount);
  - a voucher;
  - an exchange;
  - the currency selector;
  - split tender.
- At the same time, the list of 40 lines gets only about 270 px.
- Measured footer scrolling: true at 360, 390 and 1280; false at 768 and 1920.
- The page under the drawer is 24,871 px tall and can still scroll behind it (no scroll lock).

Screenshot: `phone-build-cart-390.png` (plus 360, 768, 1280 and 1920).

### 1.3 The header and floating menus (VERIFIED)

Every element that floats, and its stacking level:

| Element | Where | z | Problem |
|---|---|---|---|
| `.topbar` (page header) | styles.css:36 | 20 | |
| `.navbar` (bottom tabs) | styles.css:102 | 20 | |
| `.kebab-menu`: More tab dropdown, EOD row menus | styles.css:236/248; router.js:287; eod.js:646 | **30** | **Measured:** with the More dropdown open, a 120 px scroll leaves its top at y = 37, and the header (bottom at 63) is under it. `elementFromPoint` on the header returns the menu. Screenshots `menu-moretab-after-scroll-390.png` and `-1280.png` |
| `.popmenu`: the ⋮ row and Excel menus (`showMenu`) | utils.js:215-228; styles.css:68-70 | **200**, fixed | Its top is clamped only to ≥ 8 px, not below the header, so it can sit on the header. **Measured:** it doesn't move or close when the page scrolls: after a 180 px scroll it stays put, detached from its row. Screenshot `menu-row-after-scroll-390.png` |
| `.overlay` / `.drawer` (cart, requests, desktop nav) | styles.css:170-177 | 40 / 50 | Full-height panels that cover the header on purpose (the drawer pattern) |
| `.sync-toast` | styles.css:219 | 60 | Fixed at top 14 px: **over the header** (ASSUMED harmless; it's a short notice) |
| `.modalOverlay` | styles.css:212 | 70 | A full-screen dimmer (intended) |
| Field guide top, nav, search | fieldguide.css:26/81/99 | 30 / 30 / 60 | Its own pages and header; not the POS header |
| PWA update bar | pwa-extras.js:87 | 9999 | Bottom of the screen (intended) |

There is **no shared stacking scale**: each rule picks its own number.

### 1.4 Design

**A. One stacking scale in `styles.css`.** CSS variables, each used by every rule of its kind:

| Variable | Value | Used by |
|---|---|---|
| `--z-content-menu` | 10 | page menus that scroll with the page |
| `--z-header` | 20 | `.topbar` and `.navbar` |
| `--z-popover` | 25 | fixed pop-up menus, kept below the header line |
| `--z-overlay` | 40 | overlay |
| `--z-drawer` | 50 | drawer |
| `--z-toast` | 60 | toast, placed below the header |
| `--z-modal` | 70 | modal |

Content menus and pop-up menus are then always under the header. Drawers and modals stay above it, as full-screen layers.

**B. `showMenu()` (one place, so every ⋮ menu gets the fix):**
- **Placement:** below the header's bottom edge (`.topbar` rect) and inside the viewport; it opens upwards when there isn't room below.
- **Closing:** it closes on scroll, resize and route change.
- **The More dropdown and EOD menus (`.kebab-menu`):** they take the content-menu level, so the header covers them while scrolling. They close on scroll the same way.

**C. Desktop Sales: a fixed-height work area.**
- `.desktop-sales{height:calc(100dvh - var(--header-h)); overflow:hidden}`.
- `.ds-main{overflow-y:auto}`: the product list scrolls on its own.
- `.ds-cart{height:100%; display:flex; flex-direction:column}` with:
  - `.ds-cart-head{flex:none}`, so the head always stays at the top;
  - `.ds-cart-body{flex:1; min-height:0; overflow-y:auto}`;
  - `.ds-cart-foot{flex:none}`, so checkout is always visible.
- **The checkout fields:**
  - These go into a **"Sale details" section that folds**: discount reason and approver, payment reference, document reference, voucher, exchange.
  - It opens automatically when one of them is needed: a line discount, EcoCash or Bank chosen, a voucher available.
  - What stays always visible: Customer, Total, the Pay buttons.
- `--header-h` is measured once from `.topbar`, so the layout doesn't depend on a hard-coded 55 or 63 px.

**D. Phone drawer** (the same drawer pattern, kept):
- **Three parts:**
  - the head (fixed);
  - **one** scrolling middle: the cart lines, then the folding "Sale details";
  - **the Pay bar pinned at the bottom**: Customer, Total, the Cash/EcoCash/Bank/Credit buttons and Split, with `padding-bottom: env(safe-area-inset-bottom)`.
- **Body scroll lock** while the drawer is open (`overflow:hidden` on `<html>`), so the page under it doesn't move.
- **Height:** `100dvh`, so the mobile browser bar doesn't hide the Pay bar.
- Split tender's own panel opens inside the scrolling middle. Its "Complete" button joins the pinned Pay bar.

**E. Tablet and PWA at 768–1920 px** (the phone build on a big screen): unchanged pattern, a right-side drawer of max 400 px with the pinned Pay bar.

ASSUMED: you don't want the side panel on the phone build too. Say if you do.

**F. Audit (Stage B):** every route, at 360, 390, 768, 1280 and 1920, with a script that opens every menu and scrolls and checks that `elementFromPoint` on the header row never returns a menu.

**The routes:** Sell, Products, Credit, Reports, Marketing, More and each More tab, the lock screen, Start. The list of what was fixed goes in the Stage B report.

**Risk:**
- The cart HTML is shared with split tender, FX preview, exchange and vouchers. The anti-focus-loss rule must hold: patch values, never rebuild an input while typing ([src/pos.js:100-128](../../src/pos.js#L100-L128)).
- The existing jsdom and Playwright tests (cart-drawer, line-item-discount, split-tender-focus, browser-audit) are kept and extended.

---

## 2. The customer combo with "Add new"

### 2.1 What's there (VERIFIED)

**The table:** `customers` ([src/db.js:98-100](../../src/db.js#L98-L100)) holds:
- `id`, `name`, `phone`;
- added later: `branch`, `address`, `town_city`, `suburb` ([db.js:361-364](../../src/db.js#L361-L364));
- `uid` (`SYNC_UID_TABLES`, [db.js:631](../../src/db.js#L631)).

There is **no type, no credit limit and no national ID.**

**Per device:**
- A customer is stored with `branch = currentBranch()`, which is one branch per device.
- Customers **don't sync** through any server: nothing queues them and no `cl_` table holds them.
- They travel only through backup merge, matched by uid, else by name + phone ([src/backup.js:377-382](../../src/backup.js#L377-L382)).

**In the cart:**
- **Fields:**
  - the phone drawer has free text "Customer name (optional, required for Credit)" plus "Customer phone" ([router.js:167-170](../../src/router.js#L167-L170));
  - the desktop has the name only ([sales-desktop.js:165-166](../../src/desktop/sales-desktop.js#L165-L166)).
- **At checkout:** `completeSale` reads the typed text ([pos.js:537-541](../../src/pos.js#L537-L541)) and calls `findOrCreateCustomer(name, phone)` ([pos.js:144-152](../../src/pos.js#L144-L152)). **Any typed name silently creates a customer record**, matched by name + phone.
- **Shared-stock tills:** the sale waits for the server, then finishes with the typed inputs it carried along ([pos.js:573-578](../../src/pos.js#L573-L578)).

**Vouchers:**
- The voucher preview looks the customer up by exact name (`findMatchingCustomer`, [pos.js:134-138](../../src/pos.js#L134-L138); [router.js:226-260](../../src/router.js#L226-L260)).
- Frequent-customer vouchers count sales by `customer_id` ([pos.js:229-242](../../src/pos.js#L229-L242)).

**Credit:**
- The balance is `customerBalance(cid)`: Credit payment lines minus credit payments minus credit-note refunds ([pos.js:159-168](../../src/pos.js#L159-L168)). It reads **this device's sales only**.
- **There is no credit limit today.**

**Creating and editing:**
- Credit → Directory → "+ New Customer" (`newCustomerModal`, [src/credit.js:1-26](../../src/credit.js#L1-L26)) asks for name, then optional phone, address, town and suburb.
- `editCustomerModal` ([credit.js:28-58](../../src/credit.js#L28-L58)) lets anyone edit or delete.

**Staff:**
- Roles are **Admin and Cashier only** ([src/staff.js:37](../../src/staff.js#L37), [:101-102](../../src/staff.js#L101-L102)). There are no per-permission flags.
- The signed-in staff member is known only when PIN sign-in is used (`sessionStaffId`, `currentStaff()`, [staff.js:29](../../src/staff.js#L29)). Otherwise there's just a typed name.

**Where customers show:**
- Customer reports show name, phone and balance only ([src/report-writer.js:153-158](../../src/report-writer.js#L153-L158), [src/reports.js:377](../../src/reports.js#L377)).
- Receipts print the customer ([src/printing.js:612](../../src/printing.js#L612), [:646](../../src/printing.js#L646)).

### 2.2 Design

**The combo** (one component, used in the phone drawer and the desktop cart):
- It replaces "Customer name" and "Customer phone".
- **Typing** filters by name (word starts) or phone (digits, normalised the same way as the trial rules: `07…` = `+2637…`). It shows up to 8 matches as name · phone · type badge.
- **Picking one** sets `cartCustomer = {id, uid, name, phone, type}`.
- **"+ Add new customer"** is always the last row, prefilled with what was typed.
  - It's enabled when the signed-in staff member has **Create customers**, or is Admin.
  - When nobody is signed in with a PIN, choosing it asks for the **Admin passcode** (the same `findAdmin` unlock used for price edits).
  - Without either, it's disabled and reads "Ask an admin to add customers".
- **No silent creation any more:** text that isn't a picked customer isn't saved as a customer.
  - Cash, EcoCash and Bank sales without a customer are walk-ins.
  - Credit still needs a picked customer: "Pick the customer, or add them, for a credit sale."
- **The voucher and frequent-customer logic** use the picked customer's id instead of the exact-name lookup. The behaviour is otherwise unchanged.
- **Shared-stock checkout** carries `customer_id` through its waiting inputs, instead of the typed name and phone.

**The "Add new customer" modal:**
- **Fields:**
  - Name (required);
  - Phone (required, normalised);
  - Customer type (Retail, the default, or Wholesale);
  - Credit limit (empty = no limit);
  - Address;
  - National ID number.
- **A duplicate phone** (in this business's list) is refused: "A customer with this phone already exists: <name>." It offers **Select <name>**.
- **On save,** the new customer is selected in the cart (and re-priced, §3).

**The permission:**
- A new `staff.can_create_customers` column (default 0), with a "Can create customers" checkbox in the staff form.
- **Admin always has it.**
- The same permission governs these in Credit → Directory:
  - editing type, credit limit, address and national ID;
  - deleting a customer.

  Today anyone can edit or delete there. **That is a behaviour change; please confirm.**

**Privacy:**
- National ID and address show only to Create-customers staff or Admin (Directory, the edit modal).
- Never on receipts; the receipt prints the name only.
- Never in reports, which stay name, phone and balance.
- **A new admin-only "Customer export (full)"** in Reports, behind the Admin passcode, includes them.
- **Not fixable without encryption:** the full-database backup file (`.sqlite`) contains everything, as it does for every table today. Encrypting backups is out of scope.

**The credit limit:**
- On a sale with a Credit line: if `customerBalance + credit part of this sale > credit_limit`, a warning shows: "<name> would owe $X, over their limit of $Y."
- **Continuing needs the Admin passcode.** The approval is written to the audit log (`logAudit`).
- **This is harder than it looks:** the balance is **this till's** balance only. Sales don't sync between tills, so a customer can be under the limit on each till and over it in total.
  - Sharing balances would need credit sales and payments to sync: a separate, larger change (out of scope; the credit accounting is out of scope).
  - **Recommend:** warn against this till's balance, and say so in the message ("on this till").

### 2.3 One customer list per business (needs a database change)

**Recommend:**
- one shared list per business, synced like the B2 supplier list (`cl_suppliers`, 20261018120000), with **any till** allowed to add customers, not just main;
- **standalone (unregistered) devices** keep a local list, as today.

**Server (the SQL outline; full SQL, rollback and tests come in Stage B, then backup, the SQL shown, and your "apply"):**

```sql
create table public.cl_customers (
  business_id uuid not null references cl_businesses(id) on delete restrict,
  customer_uid text not null,                 -- the app's customers.uid
  name text not null, phone text not null, phone_norm text not null,
  customer_type text not null default 'retail' check (customer_type in ('retail','wholesale')),
  credit_limit numeric(14,2) check (credit_limit is null or credit_limit >= 0),
  address text, national_id text,
  active boolean not null default true,
  change_seq bigint not null, created_by_install text, updated_by_install text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (business_id, customer_uid),
  unique (business_id, phone_norm)
);  -- RLS on, no direct grants (like cl_suppliers)
-- device RPCs (install ID + phrase + device key, cl_install_vendor):
--   cl_device_customer_save(row)   idempotent by uid; a phone already in the business
--                                  -> {error:'DUPLICATE_PHONE', existing:{uid,name}}
--   cl_device_customers_pull(cursor) -> rows changed since the cursor (change_seq)
-- delete guard: cl_business_delete_guard also counts cl_customers
```

**In the app:**
- A queue, like `srv_pending` and `cat_outbox`, sends new and changed customers. A pull runs after every check-in and every 5 minutes, like the catalogue.
- **When two tills add the same phone offline,** the second takes the first one's record, and its local sales are re-pointed. This is the B2 supplier rule.
- **Existing local customers:** pushed on first sync.
  - Those without a phone stay local, because they can't be compared.
  - A phone clash at first sync is **not merged silently**: it is listed in Settings → "Customers to check" for an Admin to merge or keep apart (e.g. a family sharing one phone).
- **National ID on the server:** stored in `cl_customers`, readable only by the business's own devices through the RPC. It is not shown in the Console.
  - **Recommend syncing it,** so another branch can check identity for credit.
  - The alternative is to keep the ID on the device that captured it.

---

## 3. Wholesale and retail prices

### 3.1 What's there (VERIFIED)

**Product prices:**
- One price: `products.price`.
- Main's price is kept as `cat_main_price` on catalogue-synced tills; branch prices are in `cat_branch_prices` / `branch_prices`.
- The till's selling price comes from `catEffectivePrice(main, uid)` and the branch's price mode ([src/catalogue-sync.js:51-66](../../src/catalogue-sync.js#L51-L66)).
- Product form: one Price box ([src/products.js:92](../../src/products.js#L92)).
- Price changes on remote branches go through `openPriceEditModal`, with the Admin passcode in branch-edits mode ([products.js:173-176](../../src/products.js#L173-L176), [:211](../../src/products.js#L211)).

**The cart line:**
- It takes `price: p.price` when added ([pos.js:16-22](../../src/pos.js#L16-L22)).
- The sale writes `sale_items.price` ([pos.js:612-616](../../src/pos.js#L612-L616)).
- The receipt prints qty × name = price × qty ([printing.js:300](../../src/printing.js#L300), [:307](../../src/printing.js#L307)).

**Discounts and markup** ([pos.js:58-96](../../src/pos.js#L58-L96)):
- A **line discount is a dollar amount**, capped at that line's `price × qty` (`lineDiscount`).
- `sales.discount` is the sum; any discount needs a reason (approver optional, which sets `discount_status`).
- A voucher is capped at subtotal − discount.
- **Cart-time markup was removed:** `sales.markup` is always written as 0 and kept for history only.

**Catalogue sync** ([20261006120000_catalogue_sync.sql](../../supabase/migrations/20261006120000_catalogue_sync.sql)):
- `cl_catalogue_products` has `price`, and `cl_branch_prices` holds per-branch prices.
- Push (`cl_catalogue_push`, :146) and pull (`cl_catalogue_pull`, latest in [20261009120000_branch_business_day.sql:77](../../supabase/migrations/20261009120000_branch_business_day.sql#L77)) **list their columns explicitly**.
- The app marks a product dirty through a trigger on `name, sku, price, cost, …` ([db.js:545](../../src/db.js#L545)).

**Excel import:** column synonyms are in `IMPORT_COLUMN_MAP` ([src/import.js:31-41](../../src/import.js#L31-L41)), e.g. price = "price", "selling price".

**Plans:** nothing in the app is gated by plan. Lite and Business get the same app.

**Sales on the server:** sales and sale lines **don't sync to the server**. They live on the till only, so the price level on a sale needs no server change.

### 3.2 Design

**Products:**
- New `products.wholesale_price REAL` (null = retail applies).
- **The product form:** "Wholesale price (optional)" under Price. The same Admin rule as Price, wherever Price needs it.
- **Remote branches:**
  - **follow main's wholesale price;**
  - no per-branch wholesale price in this change (recommended; see the questions);
  - in branch-edits mode, only retail is editable at the branch.

**The price level:**
- `priceFor(product, level)`: wholesale if `level = 'wholesale'` and the product has one, else the till's retail (effective) price.
- The cart keeps `cartPriceLevel`: `'wholesale'` when the picked customer's type is Wholesale, else `'retail'`.
- **Changing the customer re-prices every line** and shows a short notice: "Prices changed to Wholesale" or "… to Retail".
- Each line carries `level` (which price it actually got), so a product with no wholesale price shows "retail" on a wholesale sale.

**Discounts on top:**
- A line discount stays the dollar amount that was typed. It is still capped at the **new** line gross by `lineDiscount` (no change to that function).
- If re-pricing makes a typed discount larger than the line, the notice adds "a discount was reduced to the line total".
- The discount reason and approval rules are unchanged.
- Vouchers and exchanges work on the re-priced totals as today.
- **Before changing anything,** here is the interaction: no code change to the discount math is needed. Only `c.price` changes.

**The sale record:**
- `sales.price_level TEXT DEFAULT 'retail'`.
- `sale_items.price_level TEXT DEFAULT 'retail'`, plus `sale_items.retail_price REAL`, the retail price at the time, so a report can show what wholesale saved.
- Returns and credit notes refund `sale_items.price`, so the price actually paid: correct as is.

**The receipt:** "Wholesale prices" under the receipt number on a wholesale sale (HTML, USB, Bluetooth). Lines print the price used.

**Reports:**
- The Sales report, Discount report and report writer get a **Price level filter**: All, Retail or Wholesale.
- Sales rows show the level.

**Excel import:**
- `wholesale: ["wholesale price","wholesale","trade price","bulk price"]`.
- **Values:** a blank cell clears the wholesale price only when the column is present; a missing column leaves it unchanged (the import's existing rule).
- **The template and export** get the column.

**Catalogue sync (needs a database change):**
- Add `cl_catalogue_products.wholesale_price numeric(14,2)` (null allowed).
- Replace `cl_catalogue_push` to store it and `cl_catalogue_pull` to return it. The change from today's bodies is marked line by line, as in earlier migrations.
- The app trigger also watches `wholesale_price`.
- **Older till builds** ignore the extra key in the pull. A till on an older build pushing a product sends no `wholesale_price`; **the push keeps the stored value when the key is missing** (an explicit `null` clears it). Only main pushes.

This can go in **the same migration as the customer list**: one backup, one "apply".

---

## 4. Stocktake and POS search: every term must match

### 4.1 What's there (VERIFIED)

There are two different matchers in [src/utils.js](../../src/utils.js):

| Matcher | Used by | Rule | Wrong result |
|---|---|---|---|
| `matchesAnyOrder` ([:19-24](../../src/utils.js#L19-L24)) | POS Sell (`searchProducts`, [pos.js:1-7](../../src/pos.js#L1-L7)), desktop Sales ([sales-desktop.js:33](../../src/desktop/sales-desktop.js#L33)), Products ([products.js:170](../../src/products.js#L170), [:333](../../src/products.js#L333)), purchasing, dispatch-out pickers | Every term must be a **substring** of name + SKU + keywords | "5" finds "15lt" and "500ml"; "aint" finds "Paint" |
| `rankProductsBySearch` ([:42-62](../../src/utils.js#L42-L62)) | **Stocktake** ([src/stocktake.js:142](../../src/stocktake.js#L142), [:151](../../src/stocktake.js#L151)) | **Any one** term is enough (ranked by how many matched) | "5 paint" finds every paint and every product containing "5" |

- The non-product lists (customers in Credit, Help, Reports, DN history) also use `matchesAnyOrder`.
- **There is no barcode field.** A scanned barcode is the **SKU** (the scanner types it, [src/scanner.js](../../src/scanner.js)).
- **The current tests pin the old rules:** `test/stocktake-search.test.js:97-115` expects the partial match ("Toyota Hilux 2015" returns Corolla too). Those assertions change with the owner's rule.

### 4.2 Design: one matcher, `productSearch(products, query)` in utils.js

**How a product is split up:**
- Its name, SKU and search keywords are lower-cased and split into words at spaces and punctuation.
- Each word is also split where letters and digits meet:
  - "5lt" → number **5** with unit "lt";
  - "duran5lt" → "duran", 5, "lt";
  - "2.5kg" → 2.5 with unit "kg".
- "5 kg" also links the number to the next word as its unit.

**Query terms** (split at spaces; every term must match; any order; case-insensitive):

| Term | Matches | Examples |
|---|---|---|
| a word (letters) | the start of any product word | "pai" → Paint; "dur" → DURAN; not "aint" |
| a number | a whole number in the product, never part of a bigger one | "5" → 5lt, 5 kg, 5kg; not 15lt, 50kg, 500ml. "2" → Sugar 2kg; not 12kg |
| a number + unit ("5lt", "2kg") | that number with a unit starting with the typed unit | "5lt" → 5lt, "5 lt" and 5ltr; not 15lt; not 5kg |
| a code (letters and digits mixed with a dash, e.g. "HLX-2015"), or 6+ digits | the start of the SKU or of any product word | the SKU and barcode scanner case; "600123" → barcode 6001234567890 |

**Order of results:**
1. Name starts with the first term.
2. All terms found in name or SKU, ahead of keywords-only matches.
3. Alphabetical.

**Used by:**
- Stocktake (replacing `rankProductsBySearch`);
- Sell (phone and desktop);
- the Products list;
- the receive, purchasing, dispatch and supplier-GRV product pickers.

`matchesAnyOrder` stays for the non-product lists (customers, Help, Reports, DN history).

**Exact SKU scan:** pickers that already prefer an exact SKU match keep doing that first ([src/dispatch-out.js:342](../../src/dispatch-out.js#L342)).

**The examples to test:**
- "duran 5lt paint" finds "Paint DURAN 5lt";
- "5 paint" doesn't find "Paint 15lt";
- "sugar 2" finds "Sugar 2kg" but not "Sugar 12kg".

Also tested: "pai" finds "Paint", "5" doesn't find "500ml", "HLX-2015" finds that SKU, and a 13-digit barcode finds its product.

---

## 5. Database changes (yes, one migration)

One migration, `…_customers_wholesale.sql`, plus a rollback and a PGlite test:
1. `cl_customers` and two device RPCs, and the delete-guard update.
2. `cl_catalogue_products.wholesale_price`, and `cl_catalogue_push` / `cl_catalogue_pull` replaced, with the changes marked.

Order: the migration on "apply" → app v17 to the previews.

**The app can ship before the migration:**
- customer sync waits, showing "waiting to send to seiGEN", as B2 did;
- wholesale prices work on each till, and only their sync to other tills waits.

**The app's own (SQLite) changes** go in `db.js` migrations:
- `customers`: `customer_type`, `credit_limit`, `national_id`, `phone_norm`;
- `products.wholesale_price`;
- `sales.price_level`;
- `sale_items`: `price_level`, `retail_price`;
- `staff.can_create_customers`.

## 6. Risks to existing sales and stock

| Risk | Mitigation |
|---|---|
| The cart HTML is rebuilt on every change, and the focus bugs fixed before (line discount, split tender) could come back | Keep the patch-don't-rebuild rule; the existing focus tests, plus the same tests on the combo |
| Silent customer creation goes away: a typed name on a cash sale no longer becomes a customer | That is intended. Vouchers still work for picked customers; the change is noted in Help |
| Re-pricing touches `c.price` on cart lines | Only when the level changes. Discount math is untouched; tests cover discount + wholesale + voucher + split + exchange |
| Shared-stock checkout resumes with the saved inputs | `customer_id` and the price level are carried explicitly; a test on a shared-stock till |
| The search rule changes everywhere products are searched | A deliberate change; the old tests are updated and the owner's examples added. Typing inside a word ("aint") no longer finds it |
| Customer sync merges | No silent merge of an existing phone clash; an Admin decides |
| Older tills and the catalogue | The pull's extra key is ignored, and a missing key on push keeps the value |
| Credit limit is per till | Said in the warning; shared balances are out of scope |
| National ID in backups and on the server | Device RPC only, not in the Console; backups as today (no encryption) |

## 7. Questions (with my recommendation)

1. **Customers per business, shared and synced?**
   **Recommend yes**, like the B2 supplier list. Any till may add customers, existing phone clashes wait for an Admin, and the national ID is synced. It needs the migration in §5.
2. **Does the wholesale price sync through the catalogue?**
   **Recommend yes**, main's wholesale price to every till, in the same migration. No per-branch wholesale price for now.
3. **Credit limit: block, or warn?**
   **Recommend: warn, and continue only with the Admin passcode** (your rule), checked against **this till's** balance and saying so. A hard block isn't possible to make correct until credit balances are shared.
4. **Ambiguities:**
   - **a. Walk-in names:** today any typed name becomes a customer. **Recommend:** only picked or added customers are saved; others are walk-ins.
   - **b. Who may edit or delete customers in Credit → Directory:** today anyone can. **Recommend:** Create-customers staff or Admin only.
   - **c. No PIN sign-in:** with no PIN sign-in, the app doesn't know who is at the till. **Recommend:** "Add new customer" asks for the Admin passcode then.
   - **d. Phone build on a big screen** (tablet or desktop browser): **Recommend** keeping the drawer, now with the pinned Pay bar. The side-by-side panel stays desktop-build only.
   - **e. Search:** **Recommend** keeping the hidden "Search keywords" in the search, so it still works.
   - **f. Long digit runs (6 or more):** **Recommend** treating them as codes (start-of-SKU match) for barcodes. Shorter numbers are whole numbers.
   - **g. Wholesale on remote branches in branch-edits mode:** **Recommend** following main's wholesale price for now.
   - **h. Customer list rows:** **Recommend** not showing the type badge or limit to staff without the permission. They see name, phone, and Retail/Wholesale only (needed to understand the prices).
5. **Order with Trial rules:** Trial-B waits for these fixes. These fixes don't touch activation, so the two don't conflict in code. Both bump the app build: POS fixes = v17, Trial rules = v18.
