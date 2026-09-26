# Open Business Decisions

Tracked explicitly — do NOT silently resolve these during implementation.

1. **Service charge model** — fixed amount vs percentage (system supports both, configurable; final default pending).
2. **Final logo & thermal representation** — real logo pending; placeholder in `LogoPlaceholder.tsx` (options: removed / monochrome / text / printer-optimized bitmap).
3. **Authorized credit customers rules** — who is allowed to take credit, approval flow, credit limits.
4. **Any business-specific pricing rules** discovered during implementation.

# Architecture Decisions (resolved)

| Decision        | Choice                                                                         | Reason                                        |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Package manager | pnpm 11                                                                        | installed, fast, strict                       |
| Tauri major     | v2 (stable)                                                                    | updater + process plugins, Windows builds     |
| SQLite driver   | `rusqlite` (bundled)                                                           | single-binary, full SQL control, transactions |
| SQL location    | Rust repositories only                                                         | UI never holds SQL/business logic             |
| Migrations      | embedded numbered SQL + `_migrations`                                          | deterministic, offline, testable              |
| i18n            | i18next, `ar-EG` production locale, RTL-first                                  | future English support with no refactor       |
| Lint/format     | oxlint + Prettier                                                              | minimal toolchain                             |
| Tests           | Vitest + Testing Library (FE), `cargo test` (BE incl. DB via in-memory SQLite) | business-critical logic first                 |
| Windows builds  | GitHub Actions + tauri-action                                                  | no Windows machine needed                     |
| Updates         | tauri-plugin-updater + signed GitHub Releases                                  | safe offline-first update flow                |
| Discount policy | open-ended amount + per-cashier authorization (Argon2id, no global password)   | no ceiling; usage is authorization-controlled |
