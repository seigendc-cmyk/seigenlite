seiGEN Commerce Lite



Growth Financial Engine — Accounting, Working Capital, Planning, Economic Intelligence & Growth Decision System



Application Development Specification · Version 2.0 · 25 October 2026



Document owner: Digital Commerce Product: seiGEN Commerce Lite Audience: Software architects, application developers, QA engineers, product management and financial operations Purpose: Define the functional behaviour, calculations, planning interface, controls and acceptance criteria for an integrated working-capital management engine.



1\. Executive summary



The Working Capital Management Engine will help business owners and staff understand whether the business can replace stock sold, collect money owed by customers, meet supplier obligations and fund operating expenses without compromising future trading.



It will integrate six management areas:



\* COGS Reverse reserve management.



\* Debtor and credit-sales management.



\* Creditor and credit-purchase management.



\* Cash-flow forecasting and payment scheduling.



\* Period-based financial planning spreadsheet.



\* Early-warning analytics and business-growth recommendations.



The engine must work with actual business transactions rather than maintain an independent, conflicting version of the accounting records.



Core operating principle



\> Every sale creates a commercial consequence. Every credit sale creates a collection risk. Every stock sale creates a stock-replacement requirement. Every credit purchase creates a future payment obligation. The system must make these consequences visible before the business commits its cash.



Expected outcome



The owner should be able to answer five questions at any time:



\* Can we replace the stock we have sold?



\* How much money are customers expected to pay, and when?



\* How much must we pay suppliers, and when?



\* Will available cash cover all obligations without compromising COGS Reverse?



\* What actions should we take now to reduce the risk of a cash shortage?



This specification describes expected functionality. Developers must inspect the actual repository, database schema, existing accounting rules and transaction workflows before implementation.



2\. Scope and system boundaries



2.1 In scope



\| Module               | Responsibilities                                                                                  |

\| -------------------- | ------------------------------------------------------------------------------------------------- |

\| COGS Reverse         | Reserve requirements, protected funding, shortages, diversions and recovery tracking.             |

\| Debtors              | Credit sales, invoices, receipts, ageing, collection plans and credit risk.                       |

\| Creditors            | Supplier invoices, payment terms, ageing, instalments and supplier payment plans.                 |

\| Cash-flow forecast   | Opening cash, expected receipts, planned payments, other cash movements and projected balances.   |

\| Planning spreadsheet | Period columns, editable forecasts, scenario planning, cash-gap detection and payment scheduling. |

\| Purchasing           | Credit limits, purchase commitments, supplier terms and stock-replenishment impact.               |

\| Analytics            | Working-capital KPIs, risk indicators, supplier performance and customer payment performance.     |

\| Notifications        | Upcoming obligations, overdue accounts, reserve shortages and unauthorised reserve use.           |

\| Audit                | Transaction history, changes, approvals, overrides and reconciliation.                            |

\| Seith integration    | Explanations, summaries and recommendations based on verified application data.                   |



2.2 Out of scope for the initial release



\* Autonomous borrowing or lending.



\* Automatic supplier payments without approval.



\* Automatic debtor collection promises.



\* Automatic changes to contractual credit terms.



\* Unverified AI-generated financial calculations.



\* A new general ledger that duplicates the existing accounting engine.



\* Automatic write-off of debts or automatic recognition of bad-debt losses without authorised accounting procedures.



2.3 Integration requirement



The engine should consume and reference existing sales, inventory, purchasing, cashbook, bank/cash accounts, branch and accounting records.



Developers must not create duplicate transaction sources merely to support the new dashboard.



3\. Fundamental financial rules



These rules must be agreed and tested before implementing the user interface.



3.1 Revenue is not cash



A credit sale creates a debtor balance, but no cash is received until payment actually occurs.



A forecast collection must never be treated as a completed receipt.



3.2 COGS remains relevant when a debtor is overdue



If stock costing $700 is sold on credit, the stock-replacement requirement is still $700 even if the customer fails to pay on time.



The sale does not become cost-free simply because the debtor has not paid.



3.3 Reserve requirement and reserve funding are separate



The engine must distinguish:



\* COGS Reverse requirement: the amount the business intends to protect for stock replacement.



\* COGS Reverse funded amount: actual cash allocated to that purpose.



\* COGS Reverse funding gap: the amount still needed to meet the reserve requirement.



\* COGS Reverse exposure: stock cost associated with sales whose cash has not yet been recovered, reported separately from the total reserve funding gap.



A business can have an adequate accounting reserve but insufficient actual cash. The dashboard must not confuse these conditions.



3.4 Supplier credit creates a liability, not cash



A credit purchase increases inventory and the supplier liability. It does not immediately increase cash.



3.5 Forecasts must not double-count money



\### 3.5 Forecasts must not double-count money



An expected debtor receipt must not be counted as available cash and also counted again as a bank receipt.



Similarly, a scheduled creditor payment must not reduce the actual cash balance until the payment is executed or otherwise confirmed as completed.



3.6 Profitability and liquidity are different



The engine must report separately:



\* Profitability.



\* Actual liquidity.



\* Reserve adequacy.



\* Working-capital exposure.



\* Future payment capacity.



A profitable business can still fail to meet its obligations because cash arrives too late.



4\. COGS Reverse management engine



4.1 Purpose



COGS Reverse is intended to establish the discipline of protecting money needed to replace stock sold.



The feature should be available to all relevant vendors, with configuration determining the required reserve policy, warning thresholds and approval controls.



The system should encourage reserve funding from the beginning of operations rather than waiting for a cash shortage.



4.2 Reserve calculation



For a reporting period:



R_t=R\_{t-1}+C_t-F_t+A_t



Where:



\* = required COGS Reverse reserve at period end.



\* = opening required reserve.



\* = new COGS reserve requirement generated by sales during the period.



\* = reserve requirement released under an approved accounting rule.



\* = authorised adjustments.



The calculation must use the business's configured reserve methodology and the cost assigned to the actual stock sold.



Important: is the required reserve, not the cash balance.



Actual funding must be calculated separately.



G_t=\\\max(0,R_t-P_t)



Where:



\* = reserve funding gap.



\* = eligible cash actually allocated to COGS Reverse.



Only verified, available cash should qualify as funding. Uncollected debtors, forecast sales, expected receipts and supplier credit must not qualify as funded reserves.



4.3 Reserve funding from cash and credit sales



The engine should separately report:



\* COGS generated by cash sales.



\* COGS generated by credit sales.



\* Cash collected against credit sales.



\* COGS associated with unpaid credit sales.



\* Cash allocated to COGS Reverse.



\* Total reserve requirement.



\* Total reserve funding gap.



Do not automatically assume that every cash sale fully funds its COGS. The money may have been used elsewhere or may not be physically available. Reserve funding must be based on actual allocation and eligible cash.



4.4 Reserve diversion detection



Whenever a transaction uses money allocated to COGS Reverse for a non-permitted purpose, the engine should:



\* Identify the transaction and funding source.



\* Determine the amount diverted.



\* Recalculate reserve coverage.



\* Recalculate the forecast cash position.



\* Generate a warning or approval requirement according to policy.



\* Record the user, time, reason and authorisation.



\* Create a recovery action where required.



Examples of non-permitted use include rent, salaries, owner withdrawals and discretionary purchases.



An authorised owner may be able to override certain controls, but the system must never silently erase the diversion history.



4.5 Reserve warning levels



\| Status          | Condition                                                               | Required response                                        |

\| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |

\| Healthy         | Funding meets configured reserve requirement.                           | Continue monitoring.                                     |

\| Watch           | Reserve coverage is declining or forecast to fall below target.         | Notify responsible manager.                              |

\| Action required | Material funding gap or planned diversion detected.                     | Prepare recovery plan and review discretionary spending. |

\| Critical        | Severe shortage threatens stock replenishment or essential obligations. | Escalate and apply configured payment restrictions.      |



Thresholds must be configurable by business. A warning should explain the underlying figures rather than display only a colour.



5\. Debtors and credit-sales management



5.1 Credit sale lifecycle



\* Customer credit profile and credit terms checked.



\* Credit sale approved and stock issued.



\* Invoice created and debtor balance recorded.



\* COGS requirement generated from the stock issued.



\* Expected receipt date added to the cash-flow forecast.



\* Payment reminders issued according to the collection schedule.



\* Receipt recorded and allocated to the relevant invoice.



\* Remaining debtor balance and COGS exposure recalculated.



\* Overdue or disputed balances escalated under the credit policy.



5.2 Debtor ageing



The dashboard should provide configurable ageing buckets, with a default layout of:



\* Not yet due.



\* 1–7 days overdue.



\* 8–30 days overdue.



\* 31–60 days overdue.



\* 61–90 days overdue.



\* More than 90 days overdue.



Ageing must use the contractual due date, not simply the invoice date.



5.3 Debtor collection forecasting



Every expected receipt should have:



\* Customer and invoice reference.



\* Outstanding principal.



\* Contractual due date.



\* Expected receipt date.



\* Expected receipt amount.



\* Currency.



\* Collection confidence.



\* Payment history.



\* Dispute status.



\* COGS associated with the unpaid sale.



\* Collection owner and next action.



Collection confidence should distinguish verified receipts from expected, uncertain and high-risk collections. Confidence levels should influence scenario forecasting, but must not change actual cash balances.



\### 5.4 Credit Sale COGS Exposure



5.4 Credit Sale COGS Exposure



Where partial payments exist, the engine must apply a defined allocation policy.



The recommended management metric is:



Unpaid-sale COGS exposure: the estimated COGS associated with the remaining unpaid debtor principal.



For a simple invoice-level allocation, where all invoice lines have the same payment status:



E_i=C_i\\\times\\\frac{O_i}{I_i}



Where:



\* = estimated unpaid-sale COGS exposure.



\* = original COGS for the invoice.



\* = remaining unpaid principal.



\* = original invoice principal.



This proportional method is a management estimate, not a universal accounting rule. If payments are allocated to individual invoice lines, the engine should use that allocation instead.



5.5 Credit limits and risk control



The engine should:



\* Check outstanding exposure against the customer's credit limit.



\* Identify repeated late payments.



\* Detect concentration risk.



\* Recommend shorter terms or lower limits when risk increases.



\* Warn before approving a sale that increases material COGS exposure.



\* Allow authorised overrides with a reason and audit trail.



Credit suspension should be configurable and should not be silently imposed by an AI recommendation.



5.6 Overdue interest



Interest must be separate from principal and COGS exposure.



If a business uses overdue interest, the application must support configured contractual terms, rate, calculation method, effective dates, applicable grace periods and approved adjustments.



The application should not prescribe a universal rate. Applicable terms must be reviewed for the relevant jurisdiction and contract.



Interest must never be treated as cash received until payment is actually collected.



\### 6\\. Creditors and credit-purchase management



6\. Creditors and credit-purchase management



The engine must support:



\* Supplier onboarding and credit terms.



\* Credit limits and available credit.



\* Purchase orders and commitments.



\* Goods received and partial deliveries.



\* Supplier invoices.



\* Invoice matching and discrepancy detection.



\* Credit notes, returns and disputes.



\* Payment schedules and instalments.



\* Payment allocation.



\* Supplier statements and reconciliation.



\* Early-payment discounts.



\* Late-payment charges where contractually applicable.



\* Multi-currency supplier balances.



\* Branch-level and consolidated liabilities.



6.1 Supplier account lifecycle



6.2 Payment prioritisation



\* Contractual due date.



\* Overdue status.



\* Essentiality of the supplier.



\* Stockout risk.



\* Cash available.



\* COGS Reverse funding requirements.



\* Supplier relationship and agreed terms.



\* Discounts lost by delaying payment.



\* Late fees and contractual consequences.



\* Availability of alternative suppliers.



The system should recommend priorities, but should not assume that the earliest due invoice is always the most commercially important.



\### 6.3 Payment controls



6.3 Payment controls



The engine must track the following separately:



\* Proposed.



\* Awaiting approval.



\* Approved.



\* Scheduled.



\* Executed.



\* Partially paid.



\* Failed.



\* Cancelled.



\* Reconciled.



Only completed and verified payments should reduce the actual creditor balance and actual cash balance.



7\. Period-based financial planning spreadsheet



This is a core requirement.



The application should provide an interactive planning grid that resembles a spreadsheet, with rows representing financial obligations and expected receipts and columns representing planning periods.



The grid must be editable, filterable, exportable and connected to actual financial records.



7.1 Period configuration



The user should be able to choose:



\* Daily periods.



\* Weekly periods.



\* Monthly periods.



\* A custom date range.



Recommended default: weekly planning for the next 13 weeks, with a 30-day daily view for immediate cash management and a 12-month monthly view for longer-term planning.



The selected period layout should be shared across receipts, payments and reserve planning so that users can compare amounts for the same dates.



\### 7.2 Spreadsheet structure



7.2 Spreadsheet structure



\* Opening cash.



\* Expected debtor receipts.



\* Cash sales and other receipts.



\* Total forecast inflows.



\* Supplier payments.



\* Operating expenses.



\* Payroll and statutory obligations.



\* Taxes and other commitments.



\* Owner withdrawals.



\* COGS Reverse funding allocations.



\* Total forecast outflows.



\* Net cash movement.



\* Closing projected cash.



\* Required COGS Reverse reserve.



\* Funded COGS Reverse reserve.



\* Reserve funding gap.



\* Minimum operating cash requirement.



\* Cash available after protected requirements.



7.3 Example of the period-column planning grid



The following is an illustrative layout, not actual vendor data.



\| Planning row                  | Week 1 | Week 2 | Week 3 | Week 4 |

\| ----------------------------- | ------ | ------ | ------ | ------ |

\| Opening actual/projected cash | $5,000 | $4,000 | $3,200 | $2,800 |

\| Expected debtor receipts      | $3,000 | $2,000 | $4,000 | $2,500 |

\| Cash sales forecast           | $2,000 | $2,500 | $2,000 | $2,000 |

\| Other confirmed receipts      | $0     | $0     | $500   | $0     |

\| Total inflows                 | $5,000 | $4,500 | $6,500 | $4,500 |

\| Supplier payments             | $3,000 | $3,500 | $4,000 | $2,500 |

\| Operating expenses            | $1,000 | $800   | $1,200 | $900   |

\| Payroll/statutory             | $500   | $500   | $500   | $500   |

\| Owner withdrawals             | $0     | $0     | $200   | $0     |

\| Total outflows                | $4,500 | $4,800 | $5,900 | $3,900 |

\| Net movement                  | +$500  | −$300  | +$600  | +$600  |

\| Closing projected cash        | $5,500 | $4,200 | $3,800 | $3,400 |



The figures above are illustrative. Production closing cash must be derived consistently from opening cash, actual cash movements and forecast movements, with no double counting.



\### Critical implementation rule



Opening cash for a period must equal the preceding period's closing projected cash, unless the user begins a new scenario or explicitly records an opening-balance adjustment.



For example:



Closing_t=Opening_t+Inflows_t-Outflows_tOpening\_{t+1}=Closing_t



Actual and forecast values must remain distinguishable throughout the grid.



7.4 Debtor receipt planning sheet



Each customer invoice should appear as a separate planning line or expandable invoice group.



\| Debtor / invoice        | Balance | Expected date | Week 1 | Week 2 | Week 3 | Week 4 |

\| ----------------------- | ------- | ------------- | ------ | ------ | ------ | ------ |

\| Customer A / INV-101    | $1,000  | Week 1        | $1,000 | $0     | $0     | $0     |

\| Customer B / INV-204    | $2,500  | Week 2        | $0     | $1,500 | $1,000 | $0     |

\| Customer C / INV-305    | $1,800  | Week 4        | $0     | $0     | $0     | $1,800 |

\| Total expected receipts |         |               | $1,000 | $1,500 | $1,000 | $1,800 |



The planner must prevent the scheduled receipt total from exceeding the remaining invoice balance, unless a separately identified adjustment is approved.



Partial receipts should be supported. The remaining balance should recalculate after actual receipts are recorded.



7.5 Creditor payment planning sheet



Each supplier invoice should have a similar period-based planning line.



\| Supplier / invoice     | Balance | Due date | Week 1 | Week 2 | Week 3 | Week 4 |

\| ---------------------- | ------- | -------- | ------ | ------ | ------ | ------ |

\| Supplier A / SUP-101   | $2,000  | Week 1   | $2,000 | $0     | $0     | $0     |

\| Supplier B / SUP-204   | $3,500  | Week 2   | $1,000 | $1,000 | $1,500 | $0     |

\| Supplier C / SUP-305   | $1,800  | Week 4   | $0     | $0     | $0     | $1,800 |

\| Total planned payments |         |          | $3,000 | $1,000 | $1,500 | $1,800 |



The system must distinguish the original due date from a proposed payment date. Rescheduling must not rewrite the contractual due date or conceal an overdue obligation.



A proposed instalment arrangement should include the agreed status: proposed, requested, accepted by supplier or rejected.



7.6 Editable versus calculated cells



Editable by authorised users:



\* Proposed receipt dates.



\* Expected receipt amounts within outstanding limits.



\* Collection confidence.



\* Proposed payment dates.



\* Proposed instalment amounts.



\* Forecast cash sales.



\* Forecast operating expenses.



\* Planned owner withdrawals.



\* Scenario assumptions.



\* Minimum operating cash target, subject to permissions.



\* Notes, reasons and responsible staff member.



Calculated and read-only:



\* Actual invoice balances.



\* Actual receipts and payments.



\* Contractual due dates.



\* Debtor and creditor ageing.



\* Total inflows and outflows.



\* Closing projected cash.



\* COGS Reverse requirement and funding gap.



\* Forecast cash shortage.



\* Credit-limit utilisation.



\* Risk indicators and reconciled totals.



An authorised user may override a forecast assumption, but should not directly edit a calculated actual balance. Corrections to actuals must follow the accounting transaction workflow.



\### 7.7 Spreadsheet interactions



The planning grid should support:



\* Horizontal scrolling across periods.



\* Frozen identifying columns.



\* Expand/collapse supplier and customer groups.



\* Filters by branch, supplier, customer, currency and status.



\* Drill-down from totals to underlying invoices.



\* Copying proposed amounts across periods.



\* Validated cell editing.



\* Automatic recalculation after changes.



\* Scenario duplication.



\* Save, discard and restore draft changes.



\* Export to CSV/XLSX where supported.



\* Print-friendly summaries.



\* A visible distinction between actual, forecast, scenario and approved plan values.



The grid is a planning interface, not a replacement for the accounting ledger.



7.7 Spreadsheet interactions



7.8 Spreadsheet validation



\* A payment greater than the outstanding liability.



\* A receipt greater than the outstanding debtor balance.



\* Duplicate invoice references.



\* Invalid dates or currencies.



\* Scheduled receipts beyond the selected forecast horizon.



\* Payments scheduled before the current date without an explicit historical correction.



\* Missing contractual due dates where required.



\* Period totals that do not reconcile with the underlying invoice schedules.



\* Forecast values entered into actual transaction fields.



\### 8\\. Cash-flow forecasting engine



8\. Cash-flow forecasting engine



8.1 Forecast inputs



\* Opening actual cash by account and currency.



\* Verified receipts.



\* Expected debtor collections.



\* Forecast cash sales.



\* Confirmed supplier payments.



\* Proposed creditor payment schedules.



\* Operating expenses.



\* Payroll and statutory obligations.



\* Tax commitments where applicable.



\* Owner withdrawals.



\* Planned purchases and deposits.



\* Loan instalments and other known obligations.



\* COGS Reverse allocations.



\* Other explicitly configured cash movements.



Each item must be assigned to the correct date or period, currency, branch and confidence category.



\### 8.2 Forecast scenarios



8.2 Forecast scenarios



Expected: realistic timing using current schedules and supported assumptions.



Conservative: later customer receipts, lower sales or higher expenses.



Stress test: major debtor default, significant sales decline, supplier terms shortened or unexpected expenditure.



The system must clearly label each scenario and must not mix scenario values into actual accounts.



\### 8.3 Minimum projected cash



8.3 Minimum projected cash



The engine should also calculate the minimum projected balance across the selected horizon.



A business should receive an alert when projected cash falls below its configured minimum, even if the current bank balance is positive.



\### 8.4 Available cash after protection



8.4 Available cash after protection



It should distinguish:



\* Total actual cash.



\* Cash allocated to COGS Reverse.



\* Other restricted or earmarked cash.



\* Unrestricted cash.



\* Expected future cash.



\* Projected cash after planned commitments.



Care is required to avoid subtracting the same reserve twice. The implementation must establish whether the COGS Reverse allocation is a subset of total cash and calculate spendable cash consistently.



8.5 Cash-flow warning example



\> Forecast cash shortage — Week 3Projected closing cash: $1,200 Minimum required operating cash: $2,000 Projected shortage: $800Main causes:Suggested actions:These are recommendations, not executed financial transactions.



\### 9\\. Early-warning and risk engine



9\. Early-warning and risk engine



\* What happened?



\* Why does it matter?



\* What is the estimated financial impact?



\* What action is recommended?



\### 9.1 Required alert categories



9.1 Required alert categories

\| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |

\| COGS Reverse underfunded         | Eligible funded cash is below required reserve.                      | Display gap and recovery plan.                          |

\| Reserve diversion                | Protected funds used for a non-permitted purpose.                    | Notify responsible manager and audit event.             |

\| Debtor overdue                   | Contractual due date passed and balance remains.                     | Start collection workflow.                              |

\| Debtor COGS exposure             | Material COGS remains linked to unpaid sales.                        | Show exposure and cash recovery status.                 |

\| Creditor payment due             | Invoice approaches contractual due date.                             | Add to payment planner and notify staff.                |

\| Cash shortage forecast           | Projected cash falls below required threshold.                       | Recommend mitigation before shortage date.              |

\| Payment concentration            | Large obligations fall due within a short period.                    | Highlight the cluster and allow rescheduling proposals. |

\| Customer concentration           | A customer represents an excessive share of receivables or exposure. | Flag concentration risk.                                |

\| Supplier concentration           | Critical stock depends on a limited supplier group.                  | Flag dependency and encourage alternatives.             |

\| Slow-moving stock                | Stock turnover falls below configured expectations.                  | Review purchasing and replenishment.                    |

\| Credit limit exceeded            | New credit commitment exceeds authorised capacity.                   | Warn or block according to policy.                      |

\| Forecast confidence deteriorates | Major expected receipts become less reliable.                        | Recalculate conservative forecast.                      |

\| Currency mismatch                | Obligations and available funds have material currency mismatch.     | Show exposure by currency.                              |

\| Supplier reconciliation variance | Internal balance differs from supplier statement.                    | Request investigation before payment approval.          |



9.2 Alert lifecycle



Alerts must support:



\* New.



\* Acknowledged.



\* Under review.



\* Action assigned.



\* Resolved.



\* Reopened.



Dismissal must not delete the underlying event. Critical alerts should remain visible until the issue is resolved or an authorised exception is recorded.



\### 9.3 Avoid alert fatigue



9.3 Avoid alert fatigue



The system should not issue a new alert on every screen refresh for the same unresolved condition.



\### 10\\. Financial analytics and KPIs



10\. Financial analytics and KPIs



10.1 Core KPIs



\| KPI                          | Definition                                                                            |

\| ---------------------------- | ------------------------------------------------------------------------------------- |

\| Total outstanding debtors    | Remaining customer principal due.                                                     |

\| Overdue debtor balance       | Outstanding principal past contractual due date.                                      |

\| Total outstanding creditors  | Remaining supplier principal payable.                                                 |

\| Overdue creditor balance     | Outstanding supplier principal past contractual due date.                             |

\| COGS Reverse requirement     | Required stock-replacement reserve under the configured policy.                       |

\| COGS Reverse funded cash     | Actual eligible cash allocated to the reserve.                                        |

\| Reserve funding gap          | Required reserve less eligible funding, floored at zero.                              |

\| Debtor COGS exposure         | Estimated stock cost associated with unpaid credit sales.                             |

\| On-time collection rate      | Proportion of due invoices or amounts collected on time, using a defined methodology. |

\| Average collection period    | Estimated time between credit sale and cash collection.                               |

\| Creditor payment performance | Proportion of due invoices or amounts paid on time.                                   |

\| Cash conversion cycle        | Inventory days + debtor days − creditor days, where reliable data permits.            |

\| Inventory cash lock-up       | Cost value of inventory held, with separate slow-moving and obsolete categories.      |

\| Minimum projected cash       | Lowest projected cash balance across the selected forecast horizon.                   |

\| Forecast cash gap            | Amount by which projected cash falls below the configured minimum.                    |

\| Customer concentration       | Share of receivables or exposure represented by major customers.                      |

\| Supplier concentration       | Share of purchases or critical stock supplied by major suppliers.                     |



The definitions, denominators, period boundaries and treatment of partial payments must be consistent across the application.



10.2 Supplier scorecards



10.3 Customer scorecards



\### 10.3 Customer scorecards



Measure payment reliability, overdue history, credit utilisation, outstanding exposure, disputes and concentration risk.



Any combined risk score must be explainable and treated as a management aid, not as a guaranteed prediction of default.



11\. Multi-branch and multi-currency behaviour



The engine must respect the existing tenant and business architecture.



Where the application uses \`tenantID\`, \`businessID\`, \`branchID\` and \`tillID\`, developers should follow the existing repository's authoritative scoping and access-control conventions rather than inventing parallel identifiers.



Required behaviour:



\* Branch-level liabilities and receipts.



\* Consolidated business reporting.



\* Identification of the branch responsible for each transaction.



\* Explicit inter-branch transfer handling.



\* Currency-specific cash balances.



\* Currency-specific debtor and creditor balances.



\* Recorded exchange rates and conversion dates where reporting currency conversion is required.



\* Clear separation between realised cash and converted reporting values.



\* Protection against double-counting inter-branch transfers.



A projected USD obligation cannot be assumed to be covered by a different currency balance without a configured conversion assumption and consideration of the availability of funds.



\### 12\\. Offline-first and synchronisation requirements



12\. Offline-first and synchronisation requirements



12.1 Offline behaviour



When offline, authorised staff should be able to:



\* View locally available creditor and debtor records.



\* Prepare payment and receipt forecasts.



\* Edit permitted planning assumptions.



\* View the last calculated reserve and forecast status.



\* Record supported offline transactions under existing rules.



\* See the last successful synchronisation time.



Forecasts based on stale information must display a clear freshness indicator.



12.2 Synchronisation



The engine must:



\* Preserve transaction identifiers.



\* Prevent duplicate receipts and payments.



\* Resolve or flag conflicting edits.



\* Preserve audit history.



\* Recalculate affected forecasts after synchronisation.



\* Enforce permissions on the authoritative data layer.



\* Avoid treating unsynchronised proposed payments as executed payments.



An offline warning should state that the forecast may not include recent transactions from other terminals.



\### 13\\. Data and calculation integrity



13\. Data and calculation integrity



Where equivalent structures already exist, reuse them.



The design must logically represent:



\* Debtor invoices and invoice lines.



\* Creditor invoices and invoice lines.



\* Actual receipts and payments.



\* Payment allocations.



\* Credit notes, returns and adjustments.



\* Credit terms and limits.



\* COGS reserve requirements and allocations.



\* Reserve diversions and recoveries.



\* Forecast plans and plan versions.



\* Forecast line items and period allocations.



\* Scenarios and assumptions.



\* Alerts and their lifecycle.



\* Approval events and audit history.



\* Currency and exchange-rate references.



\* Branch and tenant ownership.



\### 13.1 Transaction history



13.1 Transaction history



13.2 Precision and rounding



\### 13.2 Precision and rounding



\* Use appropriate decimal arithmetic for monetary calculations.



\* Respect currency-specific precision.



\* Avoid floating-point rounding errors in financial balances.



\* Apply rounding at defined accounting boundaries.



13.3 Concurrency and idempotency



\### 13.3 Concurrency and idempotency



Two terminals must not be able to allocate the same invoice balance or execute the same payment twice due to stale data or retries.



Use the repository's established transaction and synchronisation controls, and validate available balances at the authoritative point of commitment.



\### 14\\. Security, permissions and approvals



14\. Security, permissions and approvals



14.1 Role-based access

\| ----------------------------- | -------------------------------------------------------------------------------- |

\| Sales staff                   | View permitted customer credit status and submit credit-sale requests.           |

\| Purchasing staff              | Create purchase orders and record supplier deliveries.                           |

\| Accounts clerk                | Manage invoices, reconciliations and draft schedules.                            |

\| Branch manager                | Review branch forecasts and approve within assigned limits.                      |

\| Business manager              | Review consolidated analytics and approve authorised payments.                   |

\| Owner / finance administrator | Configure reserve policies, limits, exceptions and sensitive financial controls. |



Permissions must be configurable and enforced by the underlying application, not merely by hiding interface elements.



14.2 Separation of duties



Where practical:



\* A user must not approve their own high-risk transaction.



\* Payment preparation and approval should be separate.



\* Credit-limit changes require authorised approval.



\* Reserve-policy changes require a privileged role.



\* Overrides must include a reason.



\* Audit events must identify the actor and timestamp.



14.3 Data privacy



Staff should only see debtor, creditor and financial details necessary for their roles.



Consolidated reporting should not grant branch staff access to unrelated branches' restricted records.



15\. Seith integration



Seith should act as an explanation and decision-support layer.



Examples:



\* “Which creditors need payment this week?”



\* “Which expected receipts are least reliable?”



\* “Can we pay suppliers and maintain the COGS Reverse reserve?”



\* “What caused our cash forecast to deteriorate?”



\* “Which debtors account for most of our COGS exposure?”



\* “Prepare a proposed payment plan that protects essential stock replenishment.”



\* “Compare expected and conservative cash-flow scenarios.”



Seith must use verified engine calculations and identify which values are actuals, forecasts or assumptions.



16\. Recommended implementation phases



\### 16\\. Recommended implementation phases



Phase 1 — Reliable financial visibility



Deliver:



\* Debtor and creditor balances.



\* Invoice ageing.



\* COGS Reverse requirement and funding visibility.



\* Reserve diversion logging.



\* Period-based cash-flow spreadsheet.



\* Payment and receipt planning.



\* Basic alerts.



\* Audit trail.



Phase 2 — Cash forecasting and risk



Deliver:



\* Expected and conservative forecasts.



\* Payment concentration alerts.



\* Collection confidence.



\* Debtor COGS exposure.



\* Reserve recovery plans.



\* Cash shortage forecasting.



\* Scenario comparisons.



Phase 3 — Purchasing and supplier intelligence



Deliver:



\* Purchase commitments.



\* Goods-received and invoice matching.



\* Credit-limit enforcement.



\* Supplier scorecards.



\* Stock-replenishment analysis.



\* Supplier statement reconciliation.



\* Early-payment discount evaluation.



Phase 4 — Assisted management and growth



Deliver:



\* Seith explanations and recommendations.



\* Customer and supplier concentration analysis.



\* Credit capacity recommendations.



\* Branch comparisons.



\* More advanced scenario planning.



\* Longer-term working-capital projections.



Release priority: the planning spreadsheet and reserve-funding visibility should not be postponed until AI features are ready. They are foundational management controls.



17\. Acceptance criteria for the development team



The first release is not complete until the following behaviours can be demonstrated.



Release 1 verification checklist



0 of 18



A credit sale creates a debtor balance and the correct COGS reserve requirement without creating a cash receipt.



An overdue debtor remains outstanding until a real receipt or authorised adjustment occurs.



A partial receipt reduces the invoice balance and recalculates the unpaid-sale COGS exposure under the configured allocation method.



A supplier credit purchase creates a liability without reducing cash at purchase time.



A scheduled supplier payment appears in the forecast but does not reduce actual cash before execution.



The period-based spreadsheet reconciles opening cash, inflows, outflows and closing projected cash.



The next period's opening cash equals the preceding period's projected closing cash.



Forecast receipts cannot exceed the remaining invoice balance without an authorised adjustment.



The system warns when COGS Reverse funding is below its required reserve.



Using protected reserve funds for an unauthorised operating expense creates an auditable warning.



A late debtor receipt automatically changes future cash forecasts and risk indicators.



A planned supplier payment that causes a forecast shortage is flagged before approval.



Actual, forecast, scenario and approved-plan values are visibly distinguishable.



Multi-branch reports respect tenant and role permissions and do not double-count transfers.



Offline changes do not create duplicate invoices, receipts or payments after synchronisation.



Financial calculations use appropriate decimal precision and reconcile to underlying records.



Every critical warning explains the cause, impact and recommended next action.



Users cannot silently erase financial audit history or approve actions beyond their permissions.



These are test requirements, not claims that the current application already satisfies them.



18\. Decisions required before implementation



The development team must inspect the current application and document the following before coding.



\| Decision                         | Required outcome                                                                      |

\| -------------------------------- | ------------------------------------------------------------------------------------- |

\| Existing accounting architecture | Identify the authoritative sources for sales, COGS, receipts, payments and balances.  |

\| COGS Reverse model               | Confirm how reserve requirements and actual cash allocations are represented.         |

\| Credit-sale allocation           | Define how partial customer receipts are allocated to invoices and COGS exposure.     |

\| Cash availability                | Define how cash accounts, transfers and restricted allocations are represented.       |

\| Forecast granularity             | Confirm the supported daily, weekly and monthly planning periods.                     |

\| Payment execution                | Identify existing approval and execution workflows.                                   |

\| Multi-currency                   | Confirm currency precision, conversion rules and reporting conventions.               |

\| Offline sync                     | Identify the existing conflict resolution and idempotency mechanisms.                 |

\| Permissions                      | Map proposed roles to existing application permissions.                               |

\| Accounting and legal review      | Validate bad-debt treatment, overdue interest and relevant tax/statutory obligations. |



No database migrations, new dependencies, accounting-policy changes or destructive operations should be introduced until the relevant existing implementation and business rules have been reviewed.



19\. Final product definition



The Working Capital Management Engine is the part of seiGEN Commerce Lite that connects what the business sells, what stock it consumes, what customers owe, what suppliers must be paid and how much cash is actually available.



Its most important deliverable is not another report. It is a forward-looking financial control system that warns the vendor before a cash shortage becomes a stock shortage, supplier dispute or business interruption.



The period-based planning spreadsheet is the operational centre of that system. It allows staff to plan expected debtor receipts and creditor payments across the same timeline, test whether the business can meet its obligations and prepare corrective actions with management approval.



The COGS Reverse discipline protects the stock-replacement cycle. The debtors engine measures collection risk. The creditors engine controls future obligations. The forecasting engine brings them together.



The governing question for seiGEN Commerce Lite should be:



\> Can this business afford its next decision while preserving the money and working capital needed to keep trading and grow?

---

# V2 ARCHITECTURAL EXPANSION — BUSINESS PLAN & GROWTH ENGINE

## 20. Strategic direction

The working-capital engine defined above is retained as a foundational financial-control layer. Version 2 expands it into a broader **Growth Financial Engine** that connects authoritative accounting and Commerce Lite operational transactions to business planning, timelines, execution pipelines, economic intelligence, scenario modelling and decision support.

The objective is not to create another accounting system or a collection of disconnected planning screens. The objective is to create **one financial truth with multiple management views**:

- accounting truth;
- operational truth;
- working-capital truth;
- economic truth;
- planning truth;
- execution truth;
- scenario truth; and
- decision truth.

These views must remain traceable to the underlying transactions, assumptions, plans and external economic inputs from which they were derived.

### 20.1 Core direction

The system must evolve from:

> Record transactions → report what happened.

into:

> Record reality → understand economics → protect working capital → define objectives → build plans → schedule execution → model financial consequences → compare alternatives → execute → measure outcomes → learn and improve.

### 20.2 Accounting remains authoritative

The Growth Financial Engine must not replace or duplicate the authoritative accounting ledger. Existing Commerce Lite transactions remain the source of actual financial events.

Planning objects may forecast, reserve, commit, schedule or model future events, but they must not be presented as actual accounting transactions until the underlying economic event has occurred and has passed through the appropriate accounting workflow.

This preserves the existing rule that the planning interface is a planning system, not a replacement for the accounting ledger.

---

## 21. Unified financial architecture

The target architecture is:

```text
COMMERCE LITE TRANSACTIONS
        |
        v
ACCOUNTING EVENT ENGINE
        |
        v
DOUBLE-ENTRY ACCOUNTING / SUBLEDGERS
        |
        +--------------------+
        |                    |
        v                    v
FINANCIAL STATEMENTS     MANAGEMENT ACCOUNTING
        |                    |
        +---------+----------+
                  |
                  v
          WORKING CAPITAL ENGINE
                  |
        +---------+---------+
        |                   |
        v                   v
 ECONOMIC STATE        CASH FORECAST
        |                   |
        +---------+---------+
                  |
                  v
           GROWTH ENGINE
                  |
                  v
         BUSINESS PLAN ENGINE
                  |
       +----------+-----------+
       |          |           |
       v          v           v
   OBJECTIVES  TIMELINES   PIPELINES
       |          |           |
       +----------+-----------+
                  |
                  v
         FINANCIAL ENVELOPE
                  |
                  v
       SCENARIO / WHAT-IF ENGINE
                  |
                  v
             DECISION LAB
                  |
                  v
               SEITH
```

The same transaction must never be recreated merely because another module needs to analyse it.

---

## 22. Business Plan Engine

The Business Plan Engine is the planning and execution layer of the Growth Financial Engine.

It converts a business objective into a financially controlled execution plan.

### 22.1 Governing plan flow

Every material growth plan should be capable of following this lifecycle:

```text
OBJECTIVE
   ↓
SCOPE
   ↓
WORKSTREAMS
   ↓
TIMELINE
   ↓
PIPELINES
   ↓
BUDGET / FINANCIAL ENVELOPE
   ↓
APPROVAL
   ↓
COMMITMENTS
   ↓
EXECUTION
   ↓
ACCOUNTING EVENTS
   ↓
ACTUAL OUTCOMES
   ↓
VARIANCE
   ↓
LEARNING / NEXT DECISION
```

This flow is central to the new direction of seiGEN Commerce Lite.

### 22.2 Plan definition

A `Plan` represents a controlled future business initiative.

Minimum plan fields:

- `planID`;
- `tenantID`;
- `businessID`;
- name;
- description;
- objective;
- owner;
- sponsor/approver;
- start date;
- target completion date;
- status;
- priority;
- strategic category;
- financial envelope;
- currency;
- branches/business units affected;
- scenario reference where applicable;
- parent plan where applicable;
- created timestamp;
- approved timestamp;
- completed timestamp;
- audit metadata.

### 22.3 Plan status

Recommended plan states:

```text
DRAFT
→ PROPOSED
→ UNDER_REVIEW
→ APPROVED
→ ACTIVE
→ PAUSED
→ COMPLETED
→ CANCELLED
→ ARCHIVED
```

Status transitions must be permission-controlled and auditable.

---

## 23. Objective Model

A plan must begin with a defined objective rather than a list of purchases.

An objective should describe:

- desired business outcome;
- measurable target;
- target date;
- strategic reason;
- financial purpose;
- operating capacity required;
- constraints;
- success criteria;
- acceptable risk;
- dependencies;
- responsible owner.

### 23.1 Objective categories

The system should support at minimum:

- revenue growth;
- gross-profit improvement;
- cash-flow improvement;
- working-capital improvement;
- stock availability;
- branch expansion;
- new branch opening;
- new product/category launch;
- procurement improvement;
- supplier optimisation;
- hiring and capacity expansion;
- equipment acquisition;
- technology investment;
- infrastructure investment;
- debt reduction;
- customer acquisition;
- market expansion;
- operational efficiency;
- risk reduction;
- business continuity.

### 23.2 Objective hierarchy

Objectives may be nested:

```text
Strategic Objective
    ├── Business Objective
    │     ├── Financial Objective
    │     ├── Operational Objective
    │     └── Commercial Objective
    └── Execution Plans
```

Example:

```text
Objective: Open Harare Street branch

Financial objective:
Generate sustainable additional monthly gross profit.

Operational objective:
Create branch capacity with stock, equipment and trained staff.

Commercial objective:
Reach target monthly sales within the launch period.

Execution plans:
- premises
- equipment
- inventory
- hiring
- technology
- marketing
- launch
```

---

## 24. Scope and Workstream Model

A plan must define what is included before financial commitments are made.

### 24.1 Scope

Scope defines:

- locations;
- products/categories;
- departments;
- branches;
- customers/markets;
- staff positions;
- equipment/assets;
- suppliers;
- technology;
- budget boundaries;
- implementation boundaries;
- exclusions.

### 24.2 Workstreams

A plan may contain multiple workstreams.

Examples:

- Procurement;
- Hiring;
- CAPEX;
- OPEX;
- Inventory;
- Technology;
- Premises;
- Marketing;
- Sales;
- Training;
- Compliance;
- Logistics;
- Finance.

Each workstream must be independently measurable while remaining connected to the parent plan.

---

## 25. Timeline Engine

The Timeline Engine converts objectives and scope into dated execution stages.

### 25.1 Timeline components

A timeline may contain:

- phases;
- milestones;
- tasks;
- activities;
- deadlines;
- dependencies;
- owners;
- planned costs;
- planned cash dates;
- expected outcomes;
- completion evidence.

### 25.2 Timeline status

Each timeline item should support:

```text
NOT_STARTED
→ IN_PROGRESS
→ BLOCKED
→ COMPLETED
→ CANCELLED
```

### 25.3 Milestones

Milestones are material checkpoints such as:

- supplier selected;
- lease signed;
- staff hired;
- equipment delivered;
- installation completed;
- stock received;
- system configured;
- training completed;
- branch opened;
- sales target achieved;
- investment payback reached.

A milestone may be linked to financial conditions, operational conditions or both.

---

## 26. Pipeline Engine

The Pipeline Engine represents the movement of a planned requirement from intention through commitment and execution.

The pipeline is deliberately separate from accounting because a pipeline item is not automatically an accounting event.

### 26.1 Universal pipeline state model

```text
IDEA
→ PROPOSED
→ APPROVED
→ COMMITTED
→ ORDERED
→ INCURRED
→ PAID
→ COMPLETED
```

Not every pipeline type must use every state.

### 26.2 State meaning

| State | Meaning | Accounting effect |
|---|---|---|
| IDEA | Requirement identified | None |
| PROPOSED | Requirement defined for consideration | None |
| APPROVED | Authorised to proceed | No actual accounting entry unless an underlying event occurs |
| COMMITTED | Business has accepted a future obligation or reservation | Forecast/commitment effect only unless accounting policy requires otherwise |
| ORDERED | Purchase/work instruction placed | Normally forecast/commitment effect |
| INCURRED | Economic event has occurred | Appropriate accounting event is created |
| PAID | Cash has actually moved | Cash/bank accounting event is created |
| COMPLETED | Objective/work item has been completed | No automatic accounting entry unless a real accounting event occurs |

### 26.3 Pipeline requirements

Every pipeline item should identify:

- pipeline type;
- source plan;
- objective/workstream;
- owner;
- supplier/customer/staff/asset where applicable;
- estimated amount;
- approved amount;
- committed amount;
- actual amount;
- currency;
- expected date;
- actual date;
- status;
- accounting reference when incurred;
- payment reference when paid;
- dependencies;
- documents/evidence;
- approval history.

---

## 27. Procurement Pipeline

The procurement pipeline should support:

```text
NEED IDENTIFIED
→ SPECIFICATION
→ SUPPLIER SEARCH
→ QUOTATION
→ SUPPLIER SELECTED
→ PURCHASE ORDER
→ DEPOSIT
→ FULFILMENT
→ DELIVERY
→ GOODS RECEIVED
→ INVOICE
→ PAYMENT
→ COMPLETED
```

The system must distinguish:

- quotation from purchase order;
- purchase order from liability;
- delivery from invoice;
- invoice from payment;
- planned purchase from actual purchase.

### 27.1 Procurement financial effects

The engine should calculate:

- approved procurement budget;
- committed procurement value;
- expected deposit;
- expected final payment;
- expected inventory increase;
- expected COGS effect;
- supplier credit exposure;
- cash timing;
- forecast cash gap;
- budget variance.

Goods received, supplier invoices and actual payments must flow through the authoritative accounting and purchasing workflows rather than being manually recreated in the plan.

---

## 28. Hiring Pipeline

Hiring must be treated as both a human-resource pipeline and a financial capacity decision.

Recommended flow:

```text
POSITION APPROVED
→ JOB SPECIFICATION
→ RECRUITMENT
→ CANDIDATES
→ INTERVIEW
→ SELECTION
→ OFFER
→ ACCEPTANCE
→ ONBOARDING
→ TRAINING
→ PRODUCTIVE
```

The financial model should support:

- salary;
- statutory employment costs where applicable;
- recruitment cost;
- equipment cost;
- onboarding cost;
- training cost;
- expected productive date;
- expected revenue/capacity contribution;
- cash requirement;
- break-even/payback analysis.

The system should distinguish employee cost already incurred from future planned employment cost.

---

## 29. CAPEX Pipeline

Capital expenditure must connect the business case to the eventual accounting asset.

Recommended flow:

```text
REQUIREMENT
→ BUSINESS CASE
→ BUDGET
→ APPROVAL
→ QUOTATION
→ PURCHASE
→ DELIVERY
→ INSTALLATION
→ COMMISSIONING
→ ASSET REGISTER
→ DEPRECIATION
→ PRODUCTIVE USE
```

The plan should calculate:

- purchase cost;
- installation cost;
- ancillary costs;
- total project cost;
- expected useful life;
- depreciation impact;
- expected capacity created;
- expected revenue/profit contribution;
- payback period;
- cash requirement;
- financing requirement.

The actual fixed asset must be recognised through the authoritative accounting workflow when recognition criteria are met.

---

## 30. OPEX, Inventory, Sales and Expansion Pipelines

The same plan framework must support other material business activities.

### 30.1 OPEX pipeline

Examples:

- rent;
- utilities;
- subscriptions;
- insurance;
- maintenance;
- professional services;
- marketing;
- transport;
- recurring operating contracts.

### 30.2 Inventory pipeline

Examples:

```text
DEMAND SIGNAL
→ REORDER REQUIREMENT
→ PURCHASE PLAN
→ SUPPLIER COMMITMENT
→ RECEIPT
→ STOCK AVAILABLE
→ SALE
→ REPLENISHMENT
```

The inventory pipeline must connect directly to stock levels, purchase commitments, supplier terms, COGS Reverse and cash forecasting.

### 30.3 Sales-growth pipeline

Examples:

```text
MARKET OPPORTUNITY
→ TARGET
→ CUSTOMER ACQUISITION
→ SALES PIPELINE
→ ORDER
→ DELIVERY
→ RECEIPT
→ REPEAT / EXPANSION
```

Sales plans should model both revenue opportunity and the working-capital consequences of credit, inventory and delivery requirements.

### 30.4 Expansion pipeline

Expansion should combine multiple workstreams under one objective:

- premises;
- equipment;
- technology;
- inventory;
- hiring;
- training;
- marketing;
- launch;
- post-launch stabilisation.

---

## 31. Plan Financial Envelope

Every financially material plan must have a controlled financial envelope.

Minimum measures:

- Approved Budget;
- Committed Amount;
- Actual Spend;
- Remaining Budget;
- Forecast Final Cost;
- Funding Requirement;
- Funding Gap;
- Planned Cash Outflow;
- Actual Cash Outflow;
- Expected Return;
- Actual Return where measurable.

### 31.1 Core equations

```text
Remaining Budget = Approved Budget - Committed Amount - Uncommitted Actuals
```

Where the implementation model requires it, the exact treatment of committed and incurred amounts must be defined so that the same expenditure is not counted twice.

```text
Forecast Final Cost = Actual Cost + Remaining Expected Cost
```

```text
Funding Gap = Required Cash Funding - Available Allocated Funding
```

### 31.2 Financial envelope rules

The system must distinguish:

- budget;
- commitment;
- liability;
- actual expense or asset cost;
- cash payment;
- restricted/protected cash;
- forecast cash requirement.

A plan cannot claim that it is funded merely because a budget exists.

---

## 32. Plan-to-Accounting Bridge

The Plan Engine must be connected to the accounting engine without duplicating the ledger.

### 32.1 Before accounting recognition

Plan data may create:

- budget values;
- forecasts;
- commitments;
- planned cash movements;
- scenario values;
- expected operational outcomes.

These remain non-actual until the underlying event occurs.

### 32.2 When an economic event occurs

The originating Commerce Lite transaction or accounting workflow creates the authoritative accounting event.

The plan then links to that event through a reference such as:

```text
planID
→ workstreamID
→ pipelineItemID
→ sourceTransactionID
→ journalEntryID
```

### 32.3 Actual-to-plan reconciliation

The engine must be able to answer:

- What did we plan?
- What did we commit?
- What actually happened?
- What did it cost?
- When did cash move?
- What outcome was achieved?
- Why is actual different from plan?

---

## 33. Plan-to-Cash Forecast Bridge

All approved and financially relevant plans must be available to the cash forecast engine according to their state and confidence.

Example:

```text
Approved hiring plan
        ↓
Expected salary start date
        ↓
Payroll cash forecast
        ↓
Minimum projected cash
        ↓
Funding gap / risk
```

Similarly:

```text
Approved procurement plan
        ↓
Deposit + supplier terms
        ↓
Expected payment dates
        ↓
Cash forecast
        ↓
COGS Reverse protection
        ↓
Decision
```

Planned cash movements must not be counted as actual cash.

---

## 34. Dependencies Engine

Plans must support explicit dependencies.

Example:

```text
LEASE
  ↓
RENOVATION
  ↓
ELECTRICAL / NETWORK
  ↓
EQUIPMENT
  ↓
SYSTEM INSTALLATION
  ↓
INITIAL STOCK
  ↓
STAFF TRAINING
  ↓
LAUNCH
```

A dependent activity should be marked `BLOCKED` when a required predecessor is not complete.

The financial engine should identify the financial consequence of delay.

Example:

> Equipment delivery is delayed by 14 days. The branch launch moves by 14 days, projected sales shift by 14 days, salary cost continues, and the expected cash trajectory changes.

The system should calculate this impact where sufficient data exists rather than merely display a warning.

---

## 35. Plan Execution and Variance Engine

The system must continuously compare plan against reality.

### 35.1 Schedule variance

```text
Planned Date vs Actual/Forecast Date
```

### 35.2 Budget variance

```text
Approved Budget vs Forecast Final Cost vs Actual Cost
```

### 35.3 Cash variance

```text
Planned Cash Movement vs Actual Cash Movement
```

### 35.4 Outcome variance

```text
Expected Outcome vs Actual Outcome
```

### 35.5 Variance causes

The engine should classify causes such as:

- price variance;
- quantity variance;
- timing variance;
- scope change;
- supplier delay;
- customer delay;
- exchange-rate movement;
- inflation/replacement-cost movement;
- productivity variance;
- demand variance;
- operational failure;
- management assumption error.

---

## 36. Growth Capacity Engine

The Growth Financial Engine must calculate how much growth the business can realistically absorb.

Growth capacity should consider:

- available cash;
- protected COGS Reverse funding;
- working capital;
- supplier credit capacity;
- debtor collection capacity;
- inventory capacity;
- staff capacity;
- branch capacity;
- equipment capacity;
- operational constraints;
- expected gross margin;
- economic conditions;
- funding availability.

A business may be profitable but unable to fund growth. The engine must make that distinction explicit.

---

## 37. Growth Trajectory Engine

A growth trajectory is a sequence of planned business states rather than a single target.

Example:

```text
CURRENT STATE
    ↓
STABILISE CASH
    ↓
PROTECT WORKING CAPITAL
    ↓
INCREASE SALES CAPACITY
    ↓
ADD STAFF / STOCK / EQUIPMENT
    ↓
OPEN BRANCH
    ↓
REACH TARGET UTILISATION
    ↓
GENERATE SURPLUS CASH
    ↓
FUND NEXT GROWTH STAGE
```

Each stage should define:

- objective;
- entry conditions;
- required resources;
- required cash;
- expected outcomes;
- exit conditions;
- risks;
- next-stage trigger.

The system should not recommend expansion merely because a target is attractive. It should test whether the business can survive and finance the transition.

---

## 38. Scenario and What-If Expansion

The existing scenario engine is expanded to model complete plans and combinations of plans.

Examples:

- What if we hire two staff now?
- What if we delay hiring by three months?
- What if we buy equipment now versus lease it?
- What if supplier terms change from 30 to 14 days?
- What if sales increase 20% but debtor collections slow?
- What if a new branch opens two months late?
- What if inventory prices rise 15%?
- What if the business funds the expansion from internal cash?

Scenario values must remain separate from actual accounting values.

---

## 39. Competing Plan and Decision Lab

The business may have several legitimate uses for the same limited cash.

The Decision Lab must therefore compare alternative plans rather than evaluate each plan in isolation.

Example:

```text
Available growth cash: $20,000

Plan A — New branch
Plan B — Inventory expansion
Plan C — Delivery vehicle
Plan D — Two additional sales staff
Plan E — Debt reduction
```

The system should compare alternatives using configured objectives and constraints.

### 39.1 Decision criteria

Possible criteria:

- incremental revenue;
- incremental gross profit;
- incremental operating profit;
- cash requirement;
- working-capital requirement;
- payback period;
- return on investment;
- cash-flow risk;
- COGS Reverse impact;
- execution time;
- operational capacity created;
- supplier/customer concentration risk;
- strategic importance;
- downside exposure.

### 39.2 Decision combinations

The Decision Lab should eventually support combinations:

```text
Plan A alone
Plan B alone
Plan C alone
A + B
A + D
B + D
A + B + D
```

subject to available cash, people, capacity and other configured constraints.

The result should be a transparent ranking or comparison, not an unexplained AI recommendation.

---

## 40. Economic State Engine

The Economic State Engine remains separate from accounting truth while being connected to management planning.

It should track, where data is available:

- inflation;
- exchange rates;
- supplier price changes;
- replacement cost;
- transport costs;
- import costs;
- purchasing-power effects;
- interest rates;
- labour-cost changes;
- market-price movement.

Every economic value must be labelled as one of:

- accounting actual;
- operational actual;
- external economic data;
- management assumption;
- forecast;
- scenario value.

### 40.1 Economic effect on plans

An approved plan must be able to be re-evaluated when economic conditions change.

Example:

```text
Supplier price +18%
      ↓
Replacement cost increases
      ↓
Required inventory funding increases
      ↓
COGS Reverse pressure increases
      ↓
Cash requirement increases
      ↓
Expansion plan may become underfunded
```

---

## 41. Management Accounting as the Decision Layer

Management accounting must not create a competing set of financial records.

It should analyse authoritative accounting and operational data by dimensions such as:

- branch;
- till;
- product;
- category;
- supplier;
- customer;
- salesperson;
- plan;
- workstream;
- pipeline;
- channel;
- project;
- objective.

This allows the business to answer:

> Which activity is creating value, consuming cash, consuming capacity and supporting the next stage of growth?

---

## 42. Financial State Machine

The engine should make the difference between financial states explicit.

```text
PLANNED
   ↓
APPROVED
   ↓
COMMITTED
   ↓
INCURRED
   ↓
ACCOUNTED
   ↓
PAID / COLLECTED
   ↓
SETTLED
   ↓
OUTCOME MEASURED
```

The same business event may therefore have different representations in:

- plan;
- commitment;
- accounting;
- cash;
- outcome.

These must never be conflated.

---

## 43. Permissions and Approval Workflow for Plans

Material plans must support configurable approval thresholds.

Examples:

- staff can draft a plan;
- managers can approve within a threshold;
- owners/directors can approve larger commitments;
- finance roles can validate financial effects;
- accounting roles can post/correct accounting events;
- only authorised roles can change protected financial policies.

Every approval must record:

- actor;
- timestamp;
- decision;
- reason where required;
- previous value;
- new value;
- supporting evidence.

---

## 44. Seith Integration — Growth Intelligence

Seith becomes the conversational explanation and decision-support interface across the Growth Financial Engine.

Seith should be able to answer questions such as:

- What are our active growth plans?
- Which plans are currently blocked?
- Which plan needs cash first?
- Which procurement commitments are creating future cash pressure?
- What hiring plans are affordable?
- What will opening another branch do to cash flow?
- Which plan gives the strongest expected return for the available cash?
- What changed since the last plan review?
- Which assumptions are now wrong?
- Which plan is behind schedule?
- Which plan is over budget?
- What is preventing this objective from being achieved?
- What happens if we delay this plan by 30 days?
- What is the safest growth path under the current cash position?

Seith must cite or expose the underlying evidence used for material financial conclusions.

### 44.1 Seith response structure

For material financial questions, Seith should prefer:

```text
ANSWER
→ EVIDENCE
→ CALCULATION / LOGIC
→ ASSUMPTIONS
→ RISK
→ OPTIONS
→ RECOMMENDED NEXT REVIEW / ACTION
```

Seith must not silently execute financial decisions.

---

## 45. Planning Dashboard

The management dashboard should show the business as a living financial system rather than as isolated reports.

Recommended sections:

### Financial state

- cash;
- available cash after protection;
- receivables;
- payables;
- COGS Reverse requirement;
- COGS Reverse funding;
- funding gap;
- working capital.

### Growth state

- active objectives;
- active plans;
- plans starting soon;
- blocked plans;
- overdue milestones;
- committed growth spend;
- expected growth contribution.

### Execution state

- procurement pipeline;
- hiring pipeline;
- CAPEX pipeline;
- inventory pipeline;
- sales pipeline;
- expansion pipeline.

### Decision state

- competing uses of cash;
- scenario comparisons;
- forecast cash shortages;
- high-risk commitments;
- plans requiring management attention.

---

## 46. Source-of-Truth Documentation Expansion

The development source-of-truth structure should now include the planning and growth layer.

Recommended structure:

```text
/docs/financial-engine/

01_ACCOUNTING_PRINCIPLES.md
02_CHART_OF_ACCOUNTS.md
03_ACCOUNTING_EVENTS.md
04_JOURNAL_RULES.md
05_SUBLEDGERS.md
06_INVENTORY_ACCOUNTING.md
07_AR_AP_ACCOUNTING.md
08_FINANCIAL_STATEMENTS.md
09_MANAGEMENT_ACCOUNTING.md
10_COGS_REVERSE.md
11_WORKING_CAPITAL.md
12_ECONOMIC_STATE.md
13_MULTI_CURRENCY.md
14_GROWTH_CAPACITY.md
15_GROWTH_TRAJECTORIES.md
16_SCENARIO_ENGINE.md
17_DECISION_LAB.md
18_SEITH_FINANCIAL_INTELLIGENCE.md
19_JURISDICTION_LAYER.md
20_AUDIT_CONTROLS.md
21_OFFLINE_SYNC_INTEGRITY.md
22_FINANCIAL_SECURITY.md
23_REPORTING_REQUIREMENTS.md
24_ACCOUNTING_ACCEPTANCE_TESTS.md
25_BUSINESS_PLAN_ENGINE.md
26_OBJECTIVE_MODEL.md
27_TIMELINE_AND_MILESTONES.md
28_PIPELINE_ENGINE.md
29_PLAN_FINANCIAL_ENVELOPE.md
30_PLAN_DEPENDENCIES.md
31_PLAN_EXECUTION_AND_VARIANCE.md
32_PLAN_TEMPLATES.md
33_PLAN_ACCOUNTING_INTEGRATION.md
34_PLAN_ACCEPTANCE_TESTS.md
```

These documents become development source-of-truth documents. Code should implement the approved rules rather than inventing financial behaviour inside UI components.

---

## 47. Standard Plan Templates

The application should eventually provide reusable plan templates.

### Procurement template

- objective;
- demand requirement;
- supplier selection;
- quotation comparison;
- purchase commitment;
- delivery;
- goods received;
- invoice;
- payment;
- stock availability.

### Hiring template

- position;
- approval;
- recruitment;
- selection;
- offer;
- onboarding;
- training;
- productive date;
- recurring cost;
- expected capacity/revenue contribution.

### CAPEX template

- business case;
- budget;
- quotation;
- approval;
- purchase;
- delivery;
- installation;
- commissioning;
- asset recognition;
- depreciation;
- payback.

### Branch expansion template

- market objective;
- premises;
- infrastructure;
- equipment;
- technology;
- inventory;
- staff;
- training;
- marketing;
- launch;
- stabilisation;
- target performance.

---

## 48. Expanded Acceptance Tests

The existing 18 financial-control tests remain mandatory. The following V2 tests are added.

### Business plan tests

1. A plan can be created with an objective, owner, dates and financial envelope.
2. A plan can contain multiple workstreams.
3. A workstream can contain pipeline items.
4. A plan can contain milestones and dependencies.
5. A dependent milestone cannot be marked ready when a required predecessor is blocked.
6. Plan status transitions are permission-controlled and audited.
7. Approved budget, committed amount and actual spend remain separately visible.
8. A commitment appears in forecast/commitment views without being treated as actual cash.
9. An incurred transaction links back to the originating plan and pipeline item.
10. An actual payment changes actual cash but does not retroactively alter the original approved plan.
11. Plan-to-actual variance is calculated automatically.
12. Forecast final cost changes when new actuals or remaining estimates change.
13. Delayed milestones can affect forecast dates and cash requirements.
14. Procurement plans affect cash forecasting according to commitment/payment terms.
15. Hiring plans affect forecast payroll according to expected start dates.
16. CAPEX plans can link eventual assets to the originating plan.
17. Inventory plans affect stock and working-capital forecasts without creating false stock movements.
18. Competing plans can be compared against the same cash constraint.
19. Scenario plans never modify actual accounting records.
20. Economic assumptions can be changed in a scenario without changing historical actuals.
21. Seith can distinguish actuals, approved plans, forecasts, scenarios and assumptions.
22. Seith cannot execute a payment, change accounting records or approve a plan without an authorised workflow.
23. Every material plan decision is auditable.
24. Offline plan changes preserve identifiers and synchronise without duplicate commitments or transactions.
25. A plan can be paused, resumed, cancelled or completed without deleting its history.

---

## 49. Implementation Sequence — Revised

The implementation sequence should now be:

### Phase 0 — Repository and architecture inspection

- inspect current Commerce Lite transaction flows;
- identify authoritative accounting sources;
- identify existing inventory, purchasing, cashbook and branch structures;
- document existing permissions;
- document existing offline/sync behaviour;
- create source-of-truth `.md` files.

### Phase 1 — Accounting integrity

- accounting event engine;
- double-entry rules;
- chart of accounts;
- subledgers;
- inventory accounting;
- AR/AP;
- reconciliation;
- audit controls.

### Phase 2 — Financial visibility

- P&L;
- balance sheet;
- cash flow;
- trial balance;
- branch reporting;
- management accounting.

### Phase 3 — Working capital

- COGS Reverse;
- debtors;
- creditors;
- cash forecast;
- reserve protection;
- payment/receipt planning.

### Phase 4 — Economic intelligence

- economic state;
- replacement cost;
- inflation;
- FX;
- supplier-price movement;
- purchasing-power analysis.

### Phase 5 — Growth capacity

- capacity model;
- working-capital constraints;
- growth trajectory;
- growth-stage readiness.

### Phase 6 — Business Plan Engine

- objectives;
- plans;
- workstreams;
- timelines;
- milestones;
- dependencies;
- pipelines;
- approvals;
- financial envelopes.

### Phase 7 — Plan execution integration

- procurement integration;
- hiring integration;
- CAPEX integration;
- inventory integration;
- OPEX integration;
- sales/expansion integration;
- plan-to-accounting bridge;
- plan-to-cash bridge.

### Phase 8 — Scenario Engine

- what-if plans;
- economic scenarios;
- cash scenarios;
- competing plan combinations;
- downside/stress testing.

### Phase 9 — Decision Lab

- alternative comparison;
- objective scoring;
- constraint checking;
- financial impact;
- risk comparison;
- growth-path ranking.

### Phase 10 — Seith Growth Intelligence

- conversational plan review;
- financial explanations;
- variance explanations;
- scenario explanation;
- decision support;
- management review workflow.

---

## 50. V2 Product Definition

The Growth Financial Engine is not simply an accounting module and not simply a forecasting dashboard.

It is the financial operating system connecting Commerce Lite transactions to the business's future decisions.

Its responsibility is to make the complete chain visible:

```text
TRANSACTION
→ ACCOUNTING
→ ECONOMICS
→ WORKING CAPITAL
→ CASH
→ OBJECTIVE
→ PLAN
→ TIMELINE
→ PIPELINE
→ COMMITMENT
→ EXECUTION
→ ACCOUNTING EVENT
→ OUTCOME
→ VARIANCE
→ SCENARIO
→ DECISION
→ NEXT GROWTH STAGE
```

The system must therefore answer not only:

> What happened?

but also:

> What is happening?

> What is committed?

> What is going to happen?

> What can we afford?

> What will happen if we choose this option?

> What other option could use the same resources?

> Which path best advances the business while preserving its ability to continue trading?

### Final governing principle

> **Accounting records the truth of what happened. Management accounting explains the economics of what happened. The Growth Financial Engine connects that truth to what the business intends to do next, what it can afford, how it will execute, and which decision creates the strongest sustainable growth path.**

The system must always preserve the distinction between actuals, commitments, plans, forecasts, scenarios, assumptions and decisions.
