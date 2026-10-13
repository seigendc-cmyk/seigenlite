# A joined device's Admin passcode comes from the main branch (design, Stage A)

Status: **design only. Nothing is built.** It's for the build after v20 (owner, 2026-10-13: "close the Admin-passcode gap … design it and tell me").

## The gap today (v20)

- A device that joins a business with a join code has **no Admin passcode**.
- **On a remote branch,** Settings is locked behind the Admin passcode. While none exists, the locked screen offers "Create Admin passcode" (`src/settings.js`, `createDeviceAdmin` in `src/staff.js`). **Whoever opens Settings first chooses it**: a cashier, or anyone holding the phone.
  - That Admin passcode also unlocks price edits, stock adjustments, DN cancels, returns, the End of Day changes and dispatch receiving choices (`findAdmin`).
- **On another till of the main branch,** Settings isn't locked at all, so anyone can add an Admin under Staff. That is the same gap in another form.

## Recommendation: the main branch's Admin sets it

**The rule:** a device that joined with a join code **can't create its own first Admin passcode**. Its Admin passcode is set **on a main-branch till, by someone who knows that till's Admin passcode**, and travels to the device through seiGEN. Only a check value travels, never the passcode itself (see "What travels").

### On the main till

**1. Issuing a join code** (Settings → Business & Terminals → Add a terminal) gets two new steps:
1. "**Main branch Admin passcode**": checked on the main till itself, as today (`findAdmin`). Without it, no code is issued.
2. "**Admin passcode for the new device**", typed twice (at least 6 characters; see Q3).

The code is issued with the device's Admin check value attached.

**2. A till that is already joined** (and so has no Admin passcode yet, or a forgotten one): Settings → Business & Terminals → that till → "**Set its Admin passcode**".
- It asks for the same two things.
- The device receives it at its next check-in.
- This also replaces "I forgot the remote's Admin passcode", which today has no way back except a new install.

### On the joined device

- **On the join screen (Set up a remote branch / Join an existing branch):** nothing new to type. When the join succeeds, the device stores its Admin from the check value it received. Its first screen says "Admin passcode: set by your main branch".
- **The locked Settings screen with no Admin yet** (old joins, or codes from an older main build) no longer offers "Create Admin passcode". It says:
  > "This device's Admin passcode is set from your main branch: on a main-branch till, Settings → Business & Terminals → <this till> → Set its Admin passcode. Then open this screen while online."
  - It checks in when opened, so it picks the passcode up straight away.
- **On another till of the main branch:** Staff → Add, with the Admin role, needs an existing Admin's passcode. A first Admin comes only from the main branch's T1, as above. The main branch's first device (T1) keeps creating its own Admins as today, because it is the owner's device.
- **Changing it later on the device:** it needs the current Admin passcode, as today.

### What travels, and why it's safe enough

The main till makes the check value itself:
- a random 16-byte salt;
- **PBKDF2-SHA-256 with 150,000 rounds** (WebCrypto in the phone and desktop apps; for the file app, opened from disk, this is to be checked in the build, with a fallback to the app's own SHA-256 code if WebCrypto isn't there);
- the result.

**seiGEN stores only the salt and the result,** never the passcode, and hands them to that one device:
- in the join answer;
- or in the check-in answer, delivered once and then marked delivered.

**The device compares on its own**, offline, with the same rounds. So the unlock works offline as today.

**The honest limit:** someone with read access to the database could try every short passcode against the check value. 150,000 rounds and a 6-character minimum make that slow, not impossible. The device already keeps passcodes in plain text in its own database today; this design keeps them out of plain text on new devices.

### Server (one migration)

**Tables:**
- `cl_branch_join_codes` gets `admin_salt`, `admin_check`, `admin_rounds`.
- `cl_terminal_admin_seeds` is new: `terminal_id`, salt, check, rounds, `set_by_terminal`, `created_ts`, `delivered_ts`. One pending per till; a newer one replaces it.

**Functions:**
- **`cl_branch_issue_join_code`** takes the check value: optional for an older main build, required once all mains are on the new build (Q4).
- **`cl_terminal_admin_set`** (new) is for main-branch tills only: terminal auth plus the target till, which must be in the same business. It is logged in `cl_activity_log` as `terminal_admin_set`, without the value.
- **`cl_terminal_join`** returns the code's check value.
- **`cl_device_checkin`** returns a pending seed for its own till and marks it delivered.
- **The rollback** drops the columns, the table and the new function, and restores the three changed functions.

### App (the build after v20)

- **`staff`** gets `passcode_salt`, `passcode_check`, `passcode_rounds`.
- **`findAdmin`** and the Settings unlock (which today has its own plain-text query) both go through one compare that understands both the plain passcode and the check value.
- **`createDeviceAdmin`** is no longer offered on a joined device.
  - A device counts as joined if it has `terminal_joined=1`. This is new; it is set by `joinBusiness`, and set at boot for an existing till that isn't its business's main T1.
- **The main till:** the two new steps on Add a terminal, and "Set its Admin passcode" on a till's row.

### Tests

- **Database (PGlite):**
  - only a main-branch till can set a seed;
  - not for another business's till;
  - it is delivered once;
  - a newer seed replaces it;
  - the join answer carries it;
  - nothing in any table or log holds the passcode;
  - grants;
  - the rollback.
- **App harness:** join → the device unlocks with the passcode the main set, offline; the wrong passcode is refused; a cashier on the joined device can't create an Admin; "Set its Admin passcode" reaches an already-joined till at check-in; old plain-text Admins still unlock.
- **Browser, 390 and 1280 px:** the two new steps on the main till, the new locked screen, and the join success line.

## Other ways I looked at (not recommended)

- **(B) Confirm with the main's own Admin passcode on the joined device.**
  - The main till would put its Admin passcode's check value on seiGEN, and the joined device would ask for it before creating its own.
  - It works, but the main's own passcode then has to be typed on every branch device, by the person setting it up. That spreads the one passcode that controls the main branch.
- **(C) Set it on the join screen, by whoever does the join.**
  - It is the smallest change, and the person holds a code the owner gave them.
  - But it only moves "whoever opens Settings first" to "whoever types the join code", often the same cashier.

## Questions for you

1. **A as recommended?** That is: the main's Admin sets the new device's passcode when issuing the code, or later on that till's row.
2. **Also for extra tills of the main branch?** A first Admin there only from the main branch's T1. I recommend yes; otherwise the gap stays open on those tills.
3. **A minimum of 6 characters** for passcodes set this way (4 today)?
4. **Codes from an older main build** (no check value): accept them, with the device waiting for "Set its Admin passcode" (recommended while everything is on previews)? Or refuse them once the server has this migration?
