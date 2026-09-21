# Station Cafe — Implementation Plan

> Initial Foundation is complete (see the repo README / final report). The work below is NOT yet implemented.

## Phase 1 — Core Business System (usable production POS)

Ordered tasks. Each task: goal → modules → risks → acceptance criteria.

### 1.1 Auth, roles & staff accounts

- **Goal:** login, 3 roles (ADMIN/MANAGER/STAFF), Argon2 password hashing, session, role enforcement in every sensitive command.
- **Modules:** `migrations v2 (users)`, `services/auth.rs`, `commands/auth.rs`, `features/auth/` (frontend), audit entries for auth events.
- **Risks:** role checks forgotten on a command → mitigated by a shared command wrapper that requires a role.
- **Acceptance:** staff cannot invoke any manager/admin command even via direct IPC; audit log records logins.

### 1.2 Products, services & departments

- **Goal:** CRUD for cafe products & wash services with department (CAFE/WASH), visibility, archive-not-delete; price history preserved via invoice snapshots.
- **Modules:** `migrations v3 (departments, products, services, price history)`, manager pages, reusable DataTable + form dialogs.
- **Acceptance:** archiving never deletes; hidden items excluded from POS; manager can re-show.

### 1.3 Customers & cars

- **Goal:** customers (name/phone), cars (owner, plate, type), quick search by phone/name/plate, reuse of existing car at wash time.
- **Modules:** `migrations v4`, `services/customers.rs`, POS integration points.
- **Acceptance:** duplicate-plate protection; car data snapshotted into wash invoices/tickets.

### 1.4 Tables & POS workflow

- **Goal:** table grid with states EMPTY/OPEN/READY_TO_PAY/CLOSED (icon + text + color — not color alone); add cafe products + wash services to the same order; at-a-glance totals & timing.
- **Modules:** `migrations v5 (tables, orders, order_lines with snapshots)`, `features/pos/`, virtualized grid if needed.
- **Risks:** concurrent edits to one table → single-writer rule per table enforced server-side.
- **Acceptance:** open-table action < 1s on production hardware; invalid transitions rejected.

### 1.5 Shifts

- **Goal:** open shift (staff confirm, opening cash), active-shift conflict rules, close shift with expected vs actual cash & difference; tables locked without an active shift.
- **Modules:** `migrations v6 (shifts)`, `services/shifts.rs`, shift closing report template.
- **Acceptance:** conflicting shifts blocked by business rule; closing totals computed from orders; shift closing report prints.

### 1.6 Payments, credit & service charge

- **Goal:** CASH/CARD/CREDIT; credit = authorized debtor with outstanding balance + settlement history (PAID/PARTIALLY_PAID/UNPAID); service charge as a configurable rule (fixed OR percent — pending business decision) applied at exactly one documented point.
- **Modules:** `migrations v7 (payments, credit_accounts, credit_payments, service_charge config)`, `services/payments.rs` with explicit transaction boundaries.
- **Risks:** accounting inconsistency if applied per-line vs per-order → single shared service function.
- **Acceptance:** a credit invoice never counts as paid income; partial payments tracked; service charge snapshot stored per invoice.

### 1.7 Invoices & wash tickets

- **Goal:** invoice generation at table closing (cafe/wash/hybrid types); wash job ticket with waiting number & distinct visual identity; full immutability via snapshots (price, discount, service charge, customer/car data).
- **Modules:** `migrations v8 (invoices, invoice_lines)`, `services/invoices.rs`.
- **Acceptance:** changing a product price later never changes an old invoice.

### 1.8 Xprinter integration

- **Goal:** `printing/` module: ESC/POS writer, template renderers (cafe invoice, wash invoice, hybrid invoice, wash ticket, shift closing, day closing), queue, retry, duplicate protection, test print, 80mm layout, logo abstraction.
- **Risks:** Windows spooling quirks → `PrinterBackend` trait with a Windows RAW-spool backend; OS print dialog is not acceptable for production.
- **Acceptance:** all six document types print on Xprinter; printer-off yields a typed error + retry UI.

### 1.9 Day closing & audit

- **Goal:** close business day aggregating all its shifts (invoices, cafe/wash split, cash/card/credit, service charges, discounts); audit log for all sensitive actions.
- **Modules:** `services/day_close.rs`, `services/audit.rs`, day closing report template.
- **Acceptance:** closing with an open shift is blocked; day totals reconcile with shift totals exactly.

### 1.10 Core reports + backup foundation

- **Goal:** shared reporting query layer (one source of truth for UI + future exports); core reports (sales by department, payment breakdown, staff performance, low stock); inventory foundation (configurable tracking, movements with reasons, low-stock alerts); automatic rotated timestamped backups with validation + restore.
- **Acceptance:** report numbers match day closing exactly; restore tested on a copy.

## Phase 2 — Management & Advanced Operations

1. **Advanced reports & analytics** — charts (cafe vs wash donut, sales vs expenses), staff/customer/product analytics, defined-KPI cards, date ranges/multi-date pickers; same reporting layer as Phase 1.
2. **Expenses & advanced inventory** — manual + recurring expenses (category, recurrence, audit), stock thresholds/adjustment UX.
3. **Yearly archiving** — archive job moving closed data (by business-day year) into a separate read-only archive DB; historical reports span active + archive; integrity checks; documented restore strategy.
4. **Export system (PDF / PNG / Excel)** — one report dataset → UI, PDF, PNG, Excel (no duplicated calculation).
5. **Email reports (optional online)** — manual + scheduled; app fully functional offline without it.
6. **Local network manager access + mDNS + QR** — local HTTP API serving the manager UI on Wi-Fi; `station.local`; QR display; IP fallback; device access permissions.
7. **Automatic updates (production)** — signed updater end-to-end, Arabic update dialog with versions, safe install timing (blocked during open shift/day), failure/rollback recovery, GitHub secrets setup.
8. **Advanced backup/restore UX, cleanup, maintenance** — backup status dashboard; retention-based cleanup of generated files (never touches backups or business data); admin seed/demo reset tooling; performance hardening.
