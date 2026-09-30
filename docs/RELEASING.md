# Station Cafe — Releasing a Windows build

How a Station Cafe Windows release is produced, and — importantly — the two
**different** kinds of signing involved. They are not interchangeable, and
conflating them is the most common release mistake.

## 1. The two signing mechanisms

|                     | **Tauri updater signing**                                                                                                             | **Windows Authenticode signing**                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| What it signs       | The update bundle + its `.sig` file                                                                                                   | The `.exe`/`.msi` installer and binaries                                     |
| Algorithm           | minisign (Ed25519)                                                                                                                    | Authenticode (RSA/ECDSA, X.509 chain)                                        |
| Trust anchor        | `plugins.updater.pubkey` compiled into the app                                                                                        | A certificate in the Windows trust store                                     |
| Who consumes it     | The **installed Station app**, at update time                                                                                         | **Windows / SmartScreen / antivirus**, at install time                       |
| Configured via      | `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) repo secrets                                                                              | `bundle.windows.certificateThumbprint` / `signCommand`, or a CI signing step |
| Status in this repo | **Configured**: `plugins.updater` (pubkey + fixed endpoint), plugin registered, `createUpdaterArtifacts` on, signing verified locally | **NOT configured** — no certificate exists (see §5)                          |

They solve different problems and **neither substitutes for the other**:

- Updater signing means _"this update really came from us."_ Without it the
  app refuses to install the update.
- Authenticode means _"Windows trusts this installer."_ Without it the user
  sees a **SmartScreen "Windows protected your PC"** warning on first install,
  because the publisher is unknown.

A release can be updater-signed and still trigger SmartScreen. That is the
current state, and it is expected until a code-signing certificate is bought.

## 2. What the pipeline produces

`.github/workflows/windows-build.yml` builds on `windows-latest`:

- **NSIS `.exe` only.** `bundle.targets = ["nsis"]`. The Tauri updater applies
  NSIS only, so an MSI could never be updated to; it would also pull in the
  WiX toolchain for an artifact nobody consumes.
- WebView2 is bundled via `webviewInstallMode: "offlineInstaller"`, so the app
  installs on a machine with **no internet**. This is deliberate: the cafe PC
  is offline.
- Updater signing is enabled via `bundle.createUpdaterArtifacts`, so the
  release job emits the `.exe` **and** its `.sig`. This is verified locally:
  building with the key present produces a signature whose minisign key id
  matches the committed `plugins.updater.pubkey`.

### Required CI secret (one-time setup)

`TAURI_SIGNING_PRIVATE_KEY` must hold the **contents** of the minisign private
key. Set it with:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/station-cafe.key
```

The key on this machine is stored in minisign's **encrypted** format, but its
password is the **empty string**. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must
therefore **not exist**:

```bash
# This key's password is EMPTY. The secret must be ABSENT -- GitHub cannot
# store an empty secret, so `gh secret set ... --body ''` is a no-op and any
# real value you set is simply wrong. Absence is what makes the variable
# resolve to "", which is the one value this key accepts.
gh secret delete TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

> **This exact mistake broke the release pipeline on 2026-09-28.** The key
> secret was byte-for-byte correct and matched the committed `pubkey`, yet the
> build failed with `failed to decode secret key: ... Wrong password for that
key` — because a 4-character `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret had
> been created. An _encrypted_ key with an _empty_ password is not an
> _unencrypted_ key: Tauri always decrypts, and rejects any non-empty password.
> Both a wrong password and a missing one produce the same opaque error.
> If you ever regenerate the key with `-p <password>`, set that secret to that
> same password instead of deleting it.

The `Verify updater signing key` step now **fails the build** on a non-empty
password (`LAYER 6`) rather than only reporting its length, so this cannot
recur silently.

To confirm which key GitHub actually holds — without revealing it — compare
the SHA-256 printed by the workflow's `Verify updater signing key` step with
the local file:

```bash
shasum -a 256 ~/.tauri/station-cafe.key   # must equal the sha256 in the CI log
```

If `TAURI_SIGNING_PRIVATE_KEY` is absent, the release build **fails loudly**
rather than publishing an unsigned update — verified locally. It will not
silently ship an update no client can verify.

> **Losing this key permanently breaks future updates.** Back it up securely,
> outside the repository. The committed `pubkey` cannot be used to sign.

## 3. Publishing: tag publishes, `main` does not

| Trigger               | Outcome                                                           |
| --------------------- | ----------------------------------------------------------------- |
| Push tag `v<version>` | **Real published release** + signed updater artifacts             |
| Push to `main`        | **Draft prerelease only** — verifies the build, publishes nothing |
| `workflow_dispatch`   | Draft (no tag context)                                            |

`main` builds are draft/prerelease on purpose. Otherwise every commit would
overwrite the published `v<version>` release, and the updater would serve a
moving target that no client could pin to.

## 4. Version consistency

The installer filename, the release tag and the updater manifest version all
derive from one number declared in **three** files:

- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version = "..."`
- `src-tauri/tauri.conf.json` → `"version"`

Nothing forces them to agree, and a drift is not cosmetic: the updater compares
the manifest version against the running app's version, so a mismatch can make
a real update invisible to every client.

`scripts/check-version.mjs` gates this, and runs both in `pnpm check` and in
CI. On a tag push it also asserts the tag equals `v<version>`.

```bash
pnpm version:check              # local
node scripts/check-version.mjs --tag v0.1.0   # as CI runs it on a tag
```

It only ever **fails**; it never rewrites a version, because a build must not
be able to silently "fix" a release number.

## 5. What is NOT signed (Authenticode) — the external prerequisite

There is **no code-signing certificate in this repository, and none is
invented here.** A real Authenticode certificate must be purchased from a
trusted CA (or issued via Azure Trusted Signing / AWS Signer) and is an
organisational purchase decision, not a code change.

To enable it later:

1. Obtain the certificate (OV/EV recommended; SmartScreen reputation builds
   over time, so start early).
2. Store it **only** in CI secrets — never in the repo.
3. Add a `signtool sign` step to the workflow, or set
   `bundle.windows.certificateThumbprint` / `signCommand` in
   `src-tauri/tauri.conf.json`.

Until then, **Windows will show a SmartScreen warning on first install.** The
current installer uses `installMode: "currentUser"`, so it installs without
administrator rights; the warning is expected and documented for the operator.

## 6. In-app updates: how a manager actually gets one

Everything above is build infrastructure. This section is the part a manager
touches.

### There is no automatic update

Station **never** checks for an update by itself. Not on launch, not when the
Dev Settings page opens, not on a timer, not in the background. Until someone
presses **«فحص وجود تحديث»**, the app makes no outbound request of any kind.
This is the offline-first promise, and it is enforced by
`src/services/updateApi.ts` (no timer, no `call`) plus a test in
`src/lib/releaseIntegrity.test.ts`.

### The flow, end to end

Dev Settings → **تحديثات التطبيق** (the last card on the page).

1. **فحص وجود تحديث / Check for Updates.** Contacts the fixed GitHub endpoint
   and asks whether a newer signed build exists. No update → a success message
   and the installed version stays. A new version → its number appears and the
   **تحديث لأحدث إصدار / Update** button appears.
2. **Update → confirmation dialog.** Explains that Station will close and reopen,
   and that open work must be finished first. Cancelling downloads nothing.
3. **The safety gate.** Station refuses to proceed while a shift or a business
   day is open. This is checked **twice**: once before the confirmation opens,
   and again from the confirmation, immediately before any byte is downloaded.
   The second check is the one that counts — it re-reads `day_shift_state`,
   which is authoritative and reflects _any_ active shift, not the admin's own
   or a value cached in the UI. If the gate fails, nothing is downloaded and
   nothing is installed.
4. **Availability is re-checked** before the install, so a withdrawn update is
   never installed from a stale handle.
5. **Download with a percentage.** Signature verification happens in Rust against
   the compiled `plugins.updater.pubkey`. An update that does not verify is
   refused by the plugin; Station does not re-implement that check and never
   fetches a `.sig` itself.
6. **Install, then restart.** On Windows the NSIS installer replaces the app and
   the process ends; Station shows the "ready to restart" message and the
   relaunch is issued through `tauri-plugin-process`.

### Constraints worth stating plainly

| Constraint        | Why                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADMIN only**    | The card lives in Dev Settings, which renders nothing for a non-ADMIN.                                                                                   |
| **Desktop only**  | The plugin needs the Tauri shell. A phone or browser on the LAN shows the card with an explicit "desktop only" message and loads no updater code at all. |
| **Manual only**   | Two presses and a confirmation. Nothing happens on a schedule.                                                                                           |
| **Signed only**   | The pubkey is compiled in; the private key exists only in CI secrets.                                                                                    |
| **Offline-first** | The only network access is the two explicit user-initiated actions.                                                                                      |

### Safe install timing

Install when the cafe is **closed for the day** — no open business day, no open
shift, no unsaved POS work. The gate enforces the first two; the third is the
manager's judgement. The confirmation says so in Arabic before anything starts.

### What is preserved across an update

The SQLite database lives in the OS application-data directory and is **not**
inside the install directory. An NSIS update replaces the program files and
leaves the data alone; there is no migration, no reset, and no install-directory
assumption anywhere in the update flow. Cafe data, invoices, staff accounts and
settings survive an update untouched.

### If an update fails

Every failure is localized, resets the card to idle, and leaves Station fully
usable — nothing is half-applied, because nothing is applied until the signed
bundle has been downloaded and handed to the installer.

- **Check fails** (offline, DNS, endpoint unreachable) → error message, retry.
- **Signature or manifest rejected** → the plugin refuses; the installed version
  is untouched.
- **Download fails mid-way** → error message, retry; the old version still runs.
- **Installer fails** → error message; the old version still runs.
- **Restart fails after a successful install** → reported as a _restart_ failure,
  deliberately not an update failure. The new version is already installed;
  opening Station by hand gives the new version.
- **Last resort**: download the `.exe` from the GitHub release page, close
  Station, run it. It installs over the same app and keeps the same database.

### Capability set

`src-tauri/capabilities/default.json` grants exactly
`updater:allow-check` + `updater:allow-download-and-install` for the updater,
plus `process:allow-restart` for the relaunch. `updater:default` is **not**
granted. `src/lib/releaseIntegrity.test.ts` asserts that exact set, so a future
blanket grant fails CI.

### Known manual cleanup

The published `v0.1.0` release may still carry a stale **MSI** asset from before
the NSIS-only decision. The updater is NSIS-only and ignores it, but it should
be **deleted manually from the GitHub Release page** so no one installs an
artifact Station can never update to. This is a release-asset operation, not a
source change.

## 7. Release procedure

```bash
# 1. set the SAME version in package.json, Cargo.toml and tauri.conf.json
pnpm version:check              # must pass before you tag

# 2. commit + tag (tag MUST be v<version>)
git commit -am "release: v0.1.0"
git tag v0.1.0 && git push origin main --tags
```

CI then builds, signs the updater artifacts and publishes the release.

## 8. Security rules for this pipeline

- The updater **private key** exists only as the repository secrets
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. It is
  never committed, never echoed in a log, and never written to an artifact.
- The **public key** is compiled into the app via `plugins.updater.pubkey` and
  is safe to commit — it cannot forge a signature.
- Losing the private key permanently breaks future updates. Back it up
  securely, outside the repository.
- The CSP in `tauri.conf.json` is enforced by `src/lib/releaseIntegrity.test.ts`,
  which also hash-pins the one inline script in `index.html`. Editing that
  script without updating the policy breaks the app **in production only** —
  the test makes that a CI failure instead.
