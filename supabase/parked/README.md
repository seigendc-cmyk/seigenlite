# Parked migrations: never applied, never to be applied

- `20260926160000_vendor_tokens_rpn_and_payment.sql`: it put the RPN on the old Publish Portal's `vendor_tokens` table and made new tokens carry a payment.
  - **It was never applied on live.**
  - **Retired 2026-10-09** (owner's decision, RPN commissions). RPN commission is now earned on Collections Ledger payments (`20261015120000_rpn_commissions.sql`). Token sales will go through the ledger in the Market publishing work.
  - It's kept here for reference only. It is outside `supabase/migrations/`, so no tool will run it.
