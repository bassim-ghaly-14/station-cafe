# Station Cafe — Releasing a Windows build

How a Station Cafe Windows release is produced, and — importantly — the two
**different** kinds of signing involved. They are not interchangeable, and
conflating them is the most common release mistake.

## 1. The two signing mechanisms

|                     | **Tauri updater signing**                                         | **Windows Authenticode signing**                                             |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| What it signs       | The update bundle + its `.sig` file                               | The `.exe`/`.msi` installer and binaries                                     |
| Algorithm           | minisign (Ed25519)                                                | Authenticode (RSA/ECDSA, X.509 chain)                                        |
| Trust anchor        | `plugins.updater.pubkey` compiled into the app                    | A certificate in the Windows trust store                                     |
| Who consumes it     | The **installed Station app**, at update time                     | **Windows / SmartScreen / antivirus**, at install time                       |
| Configured via      | `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) repo secrets          | `bundle.windows.certificateThumbprint` / `signCommand`, or a CI signing step |
| Status in this repo | Secrets wired in CI; **plugin not yet configured** (updater task) | **NOT configured** — no certificate exists (see §5)                          |

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
- Updater signing secrets are **already wired** into the release job. They
  begin producing signed artifacts once the updater plugin is configured — see
  §1 and the updater task in the hardening plan. Until that configuration
  lands, the release job is building an installer only.

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

## 6. Release procedure

```bash
# 1. set the SAME version in package.json, Cargo.toml and tauri.conf.json
pnpm version:check              # must pass before you tag

# 2. commit + tag (tag MUST be v<version>)
git commit -am "release: v0.1.0"
git tag v0.1.0 && git push origin main --tags
```

CI then builds, signs the updater artifacts and publishes the release.

## 7. Security rules for this pipeline

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
