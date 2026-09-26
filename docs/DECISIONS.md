# Open Business Decisions

Tracked explicitly — do NOT silently resolve these during implementation.

1. **Service charge model** — fixed amount vs percentage (system supports both, configurable; final default pending).
2. **Final logo & thermal representation** — real logo pending; placeholder in `LogoPlaceholder.tsx` (options: removed / monochrome / text / printer-optimized bitmap).
3. **Authorized credit customers rules** — who is allowed to take credit, approval flow, credit limits.
4. **Any business-specific pricing rules** discovered during implementation.

## Discount authorization (resolved)

Discount authorization uses **one global shared 4-digit PIN**. The PIN is
configured by MANAGER/ADMIN and may be known and used by multiple staff members.

- It is **not** cashier-owned, **not** tied to the acting cashier, and **not**
  stored per user. There is exactly ONE shared discount credential, hashed with
  Argon2id in `app_settings` (`discount_authorization_hash`).
- **Identity = who is currently logged in. Discount authorization = possession
  of the shared PIN.** The authenticated session identifies the actor for
  auditability; knowledge of the shared PIN authorizes the discount. These two
  concepts are never combined.
- A login password (manager's or admin's) is never accepted as a discount PIN.
- The PIN is a string of exactly four ASCII digits; leading zeros are valid
  (`0097`), and the account-password rules do not apply to it.
- Any positive discount requires the PIN. A zero discount and clearing an
  existing discount do not. There is no maximum discount amount or whitelist —
  only `amount > 0` and `amount <= subtotal`. The quick-pick amounts in the POS
  are shortcuts, not limits.
- Service charge is completely independent: it never requires the discount PIN.
- Authorization failures are uniform, and the PIN (or its hash) never appears in
  logs, audits, invoices or frontend payloads.

# Architecture Decisions (resolved)

| Decision               | Choice                                                                         | Reason                                        |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| Package manager        | pnpm 11                                                                        | installed, fast, strict                       |
| Tauri major            | v2 (stable)                                                                    | updater + process plugins, Windows builds     |
| SQLite driver          | `rusqlite` (bundled)                                                           | single-binary, full SQL control, transactions |
| SQL location           | Rust repositories only                                                         | UI never holds SQL/business logic             |
| Migrations             | embedded numbered SQL + `_migrations`                                          | deterministic, offline, testable              |
| i18n                   | i18next, `ar-EG` production locale, RTL-first                                  | future English support with no refactor       |
| Lint/format            | oxlint + Prettier                                                              | minimal toolchain                             |
| Tests                  | Vitest + Testing Library (FE), `cargo test` (BE incl. DB via in-memory SQLite) | business-critical logic first                 |
| Windows builds         | GitHub Actions + tauri-action                                                  | no Windows machine needed                     |
| Updates                | tauri-plugin-updater + signed GitHub Releases                                  | safe offline-first update flow                |
| Discount policy        | open-ended amount + ONE global shared 4-digit PIN (Argon2id)                   | no ceiling; usage is authorization-controlled |
| Discount PIN ownership | cafe-wide setting in `app_settings`, never per user                            | shared authorization + per-person audit       |
