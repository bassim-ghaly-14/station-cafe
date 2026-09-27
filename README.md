# Station Cafe & Wash Cars — ستيشن كافيه

Production-grade, **100% offline-first** POS & management system for a cafe + car wash.

**Stack:** Tauri 2 (Rust) · React 19 · TypeScript · SQLite (rusqlite) · Tailwind CSS v4 · shadcn/ui · i18next (Arabic/RTL-first)

## Quick start (macOS development)

```bash
pnpm install
pnpm dev          # frontend only
pnpm dev:app      # full Tauri app (requires Rust: rustup stable)
pnpm check        # typecheck + lint + format-check + tests
pnpm build:app    # local release build
```

## Windows production builds

Push a tag `v*` to GitHub → Actions builds the signed Windows `.exe` + updater manifests and publishes a Release. No Windows machine required. (See `.github/workflows/windows-build.yml`; updater signing secrets required in Phase 2.)

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, data flow, DB/printing/network/update strategy
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — Phase 1 & Phase 2 detailed plan
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — resolved architecture decisions + open business decisions

## Principles

Offline-first · data integrity first · historical invoices immutable · SQL only in Rust repositories · Arabic RTL UI from day one · centralized printing, reporting, errors, and date/time handling.
