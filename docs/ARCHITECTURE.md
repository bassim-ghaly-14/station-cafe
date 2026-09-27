# Station Cafe — Architecture

> Production, 100% offline-first POS & management system for a cafe + car wash.
> Stack: Tauri 2 (Rust) + React 19 + TypeScript + SQLite + Tailwind v4 + shadcn/ui + i18next (Arabic/RTL-first).

## 1. Layered architecture

```
UI (React components, RTL, Arabic)
  ↓
Hooks / Controllers (feature hooks; no SQL, no printer details)
  ↓
Tauri IPC commands (src-tauri/src/commands.rs — thin orchestration)
  ↓
Application Services (business rules, transaction boundaries)
  ↓
Repositories (SQL lives ONLY here, in Rust)
  ↓
SQLite (WAL mode, foreign_keys ON, synchronous FULL)
```

**Hard rules**

- The UI never contains SQL or printer/protocol logic.
- Every financial mutation (invoice, payment, credit, stock, shift/day closing) runs inside an explicit SQLite transaction in a service.
- Historical invoices store a full **snapshot** (prices, discounts, service charge, customer/car data); nothing is reconstructed from current records.
- Authorization is enforced at the command/service layer, not by hiding UI.

## 2. Folder structure

```
src/                       # React frontend
  app/                     # shell, routing, providers
  features/                # one folder per business feature (Phase 1+)
  components/ui/           # shadcn/ui primitives (generated, curated)
  components/states/       # Loading / Empty / Error (shared)
  components/branding/     # LogoPlaceholder (swap real logo in ONE file)
  styles/colors.css        # COLOR SOURCE OF TRUTH: semantic tokens (light+dark).
                           # All application colors are defined here and consumed
                           # via Tailwind classes (bg-primary, text-foreground, ...).
                           # Never hardcode colors in components.
  index.css                # imports tokens, base typography utilities
  lib/                     # utils, i18n bootstrap, error taxonomy
  locales/ar/              # Arabic (Egypt) translations — production language
  services/                # typed wrappers over Tauri IPC (frontend side)
  test/                    # vitest setup
src-tauri/                 # Rust backend
  src/
    main.rs / lib.rs       # entry, state, plugin registration
    commands.rs            # IPC commands (thin)
    db.rs                  # connection, pragmas, migrations runner
    seed.rs                # deterministic, flagged seed infrastructure
    error.rs               # unified AppError (serialized safely to UI)
    services/              # Phase 1: business rules + transaction boundaries
    repositories/          # Phase 1: all SQL
    printing/              # Phase 1: Xprinter abstraction (ESC/POS)
  migrations/              # embedded numbered SQL migrations
.github/workflows/         # Windows build via tauri-action (tags → release)
docs/                      # ARCHITECTURE, IMPLEMENTATION_PLAN, DECISIONS
```

## 3. Database strategy

- **SQLite file** in the OS app-data dir; WAL journaling; `synchronous=FULL`; `foreign_keys=ON`.
- **Migrations**: numbered SQL files embedded in the binary, applied inside transactions, tracked in `_migrations`. Never edit an applied migration.
- **Schema foundation (v1)**: `app_settings`, `business_days`, `audit_log`. Business tables (users, products, tables, orders, invoices, credits, shifts…) are added as v2+ migrations in Phase 1.
- **Business day** is an explicit entity (`OPEN → CLOSED`) independent of the calendar date, aggregating 1..N shifts.
- **Archive ≠ backup**: yearly archive moves closed historical data to a separate read-only archive DB (Phase 2) while historical reports remain queryable; backups are timestamped rotated copies for disaster recovery.

## 4. Printing

`PrintingService` (Rust module `printing/`) with document templates:
cafe invoice, wash invoice, hybrid invoice, wash job ticket (distinct visual identity), shift closing report, day closing report.
Direct ESC/POS to Xprinter (80mm thermal, monochrome) — **no PDF-based printing** in production. Logo handled through an abstraction (placeholder now; can be swapped for monochrome bitmap/text later). Queue, retry, duplicate protection, test print.

## 5. Local network

Main PC hosts the app + SQLite. A local HTTP API (Phase 2, same Tauri/Rust process bound to the LAN) serves the manager UI to laptops/phones on Wi-Fi. **The SQLite file is never exposed over the network.** Discovery: mDNS (`station.local`) + QR code in the app, with IP fallback when mDNS fails.

## 6. Updates

`tauri-plugin-updater` + GitHub Releases. Workflow: push tag → GitHub Actions builds Windows .exe + signed updater manifests → publishes release → running app checks for updates → Arabic update dialog (current/available version, update now / later). Never force-updates during active shifts/day.

## 7. Security & roles

Three auth roles: `ADMIN` (developer-only, hidden from normal business UI), `MANAGER` (full business management), `STAFF` (cashier operations only). Passwords hashed (Argon2 in Phase 1). Authorization checked server-side (Rust) on every sensitive command; audit log records sensitive actions with actor, before/after.

An **employee** is not a fourth role. The `employees` table is the HR record; `users.role` is the authority. Every login is a `CASHIER` employee, and a `WASH_WORKER` is a person with **no login at all** (enforced by a database CHECK, not by the UI). The employees table therefore presents the `users.role` of the linked login, and `WASH_WORKER` only when there is none — the employee _type_ is never used as a role label. One surface (`/employees`) owns the roster, the account and the activation state; a stopped employee keeps their record and history and has their login suspended in the same transaction, never deleted.

**Wash revenue is department-level.** Washing is a shared department, so its money is reported for the WASH department as a whole (sales analytics) and is never attributed to an individual worker. A wash worker is managed through name, avatar, phone, status, attendance, salary and advances — never a personal revenue figure or ranking. `invoices.wash_employee_id` remains an operational record of who took the job, and deliberately feeds no money aggregate.
