# Console: "Issue licence" screen (spec)

For the Commerce Console codebase, which is not in this repository. It must ship **before** app v11 reaches production. Until then, `tools/licence/issue.js` does the same job from the command line. Background: `activation-v2-design.md` ("Owner decisions" wins).

## Access
- The menu item is shown to staff with the **Activation Codes** module (`cl_modules.key = 'activation_codes'`) or sysadmin. The database enforces this anyway: hiding the item is only for tidiness.
- The screen uses the staff member's existing `cl_login` token. It never holds a signing key.

## Issue
| Field | Rules |
|---|---|
| **For** | Choose **Device** or **Business**. |
| Device code | `ABCD-K7Q2`: the install ID, a dash, then a 4-character tag. Upper-case it, strip spaces, and check `^[A-Z0-9]{4,8}-[A-HJ-NP-Z2-9]{4}$` before sending. If the server answers `DEVICE_CODE_MISMATCH`, show "These 4 characters don't match that device. Check them with the shop." |
| Business | A searchable list (`cl_businesses`). Issues one licence per **active** till. Tills the server has no device key for come back in `skipped`: list them as "needs one check-in first". |
| Days | 30 / 90 / 365. Default 30. |
| App | Phone app / Desktop app (only changes the link's host). |
| Note | Optional. |

Button: **Issue licence**. It calls `POST {SUPABASE_URL}/functions/v1/issue-licence` with `Authorization: Bearer <staff token>` and `apikey: <anon key>`, and a body of `{ device_code | business_id, days, note }`.

## Result (per licence)
- Device code, business / branch / till, licence #, valid until.
- A **WhatsApp message** box, with Copy and **Open WhatsApp** (`wa.me/<shop number>?text=`). The text matches `whatsappMessage()` in `tools/licence/issue.js`: the link (`https://mobilepos.seigendc.workers.dev/#lic=…` or `desktoppos…`), the long code, and the short code.
- "The short code is shown only now." The server keeps only its hash.

## Errors to show
| Server answer | Text |
|---|---|
| 401 / 403 | "Your account doesn't have the Activation Codes permission." |
| `Device code not recognised` | "No device with that install ID has checked in." |
| 500 "signing is not configured" | "Licence signing isn't set up on the server. Tell the administrator." |

## Licences list
- Calls `cl_licence_list(p_install_id, p_business_id, p_limit)`, newest first.
- Columns: #, device, business / till, days, valid until, status (issued / redeemed / revoked), redeemed via, issued by, issued at, note.
- Filters: device, business.
- **Revoke** (needs a reason) calls `cl_licence_revoke`. It stops the short code and check-in delivery. A device that already holds the licence keeps it until it expires (Q7: revoking on the device itself comes later).
- **Copy message again**: the link and long code only (the short code can't be shown again).

## Repeat installs (Q8)
`cl_vendor_repeat_installs(p_days)` lists groups of installs that share a shop phrase. Each group is labelled by a hash, never the phrase. Show it as a panel, "Possible reinstalls", with install IDs, business names, first and last install, and the number in the last 90 days.

## Billing
`cl_licence_attach` writes the automatic `cl_ledger_entries` charge: the current activation rate × days / 30. The Collections ledger shows it as "Auto-charged: licence #N (D days)".

## Later
- Granting the Activation Codes module to RPNs: RPN accounts can't hold modules today (Staff Access grants modules to `cl_staff` only).
- Revocation on the device itself, through check-in.
