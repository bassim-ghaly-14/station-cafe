//! The browser surface: the REAL Station React application, served from the
//! SAME listener as the API.
//!
//! Why this module exists at all, and what it deliberately is NOT:
//!
//! - It is NOT a second frontend. The bytes served here are the SAME compiled
//!   Station bundle that Tauri embeds for the desktop window, read out of the
//!   application's own asset resolver. There is no second UI, no second login,
//!   no second set of translations and no second stylesheet: `src/` is the only
//!   frontend in this repository.
//! - It is NOT a second server. Same port, same thread, same process as
//!   `/api/v1`.
//! - It is NOT a source of business data. Every fact the UI shows comes from
//!   the existing commands over the existing `Mutex<Connection>`, reached
//!   through [`super::bridge`].
//!
//! Serving from the embedded assets is what keeps the installed executable
//! self-contained. `tauri::generate_context!()` already compiles the whole
//! `dist/` bundle into the binary for the desktop window; this module reads that
//! very same set, so a cafe PC with no Node, no npm and no `dist/` folder on
//! disk still serves a working application to a phone on the LAN, and the
//! browser can never receive a build different from the one the till runs.
//!
//! Routing is decided in [`super::server`] by a single prefix test, so an
//! unknown `/api/v1/*` path can never be answered with HTML here, and this
//! module is never consulted for an API path.

use super::api::API_PREFIX;

/// The Content-Security-Policy sent with every HTML and asset response.
///
/// `'self'` and nothing else: no CDN and no remote font. It is the Station CSP
/// from `tauri.conf.json`, repeated here because Tauri only applies its own to
/// the webview — a phone browser on the same LAN is held to exactly the same
/// standard as the till.
///
/// The one hash is Station's own inline theme bootstrap in `index.html`, the
/// same value Tauri already trusts. `connect-src 'self'` is what confines the
/// page to this one origin: the browser talks to this listener and to nothing
/// else, so the application works with no internet at all.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'sha256-Br7jN6/Y2pfS0UgDnjkTEzmkyZfNx6R90XmJEhxjjzw='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// What a non-API path resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route<'a> {
    /// The application shell.
    Index,
    /// A known asset: the key to hand to the asset resolver. Borrowed from the
    /// request path, which outlives the response it is used to build.
    Asset(&'a str),
    /// A client-side route (`/pos`, `/reports`, …). The application owns its
    /// own routing, so this is answered with the SAME shell: the browser then
    /// resolves the route itself. This is the SPA fallback that makes a refresh
    /// or a shared deep link work instead of 404ing.
    Spa,
    /// Nothing here.
    NotFound,
}

/// The application shell, as the asset key Tauri stores it.
pub const INDEX: &str = "/index.html";

/// The frontend files that genuinely live at the ROOT of the embedded bundle.
///
/// Vite copies everything in `public/` to the root of `dist/` verbatim: it does
/// not fingerprint those files and does not move them into `/assets/`. So the
/// application references them by a root-relative URL — `/station-cafe.png` in
/// `Logo.tsx` and in the favicon, `/station-print.png` in the receipt preview,
/// `/site.webmanifest` in the install manifest.
///
/// Tauri's own protocol serves all of these to the desktop webview. This
/// listener does not: [`asset_key`] accepts only `/assets/`, and a root file
/// with an extension falls through to `NotFound`. The result is that the whole
/// application works on a phone and every root asset is a 404 — which is why
/// the station logo was missing from the browser while it was present on the
/// till.
///
/// This list is deliberately EXPLICIT rather than a prefix or a directory walk.
/// Three named files are the entire requirement; the alternative — serving
/// whatever happens to sit at the root of `dist/` — would republish every
/// bundled file by path, which is precisely the surface the rest of this module
/// refuses to open. Adding a file to `public/` does NOT make it reachable here;
/// it has to be added to this list on purpose, with its name stated.
///
/// The bytes still come from the one existing lookup ([`super::server`]'s
/// `embedded_asset`), so there is no second asset-loading system here, and a
/// name listed but absent from the bundle still answers an honest 404.
pub const ROOT_ASSETS: [&str; 3] = [
    "/station-cafe.png",
    "/station-print.png",
    "/site.webmanifest",
];

/// Resolve a request path against [`ROOT_ASSETS`].
///
/// Exact, case-sensitive equality against the listed names. A path can only
/// match by being character-for-character one of them, so this admits no
/// traversal, no subdirectory, no alternate spelling and no wildcard: anything
/// not written out in full above returns `None` and is handled as it was
/// before, which means a clean 404.
pub fn root_asset_key(path: &str) -> Option<&str> {
    ROOT_ASSETS.contains(&path).then_some(path)
}

/// Resolve a request path against the Station frontend.
///
/// The path must already be free of its query string. Matching is exact and
/// case-sensitive.
///
/// This is the SYNTAX-ONLY form: it decides which NAMESPACE a path belongs to
/// and never whether a file is present. `/assets/anything.js` is reported as
/// [`Route::Asset`] here even when the bundle has no such file, so the decision
/// "does this asset exist?" is left to the resolver in [`route_with`], which is
/// what the server actually uses.
///
/// Use [`route_with`] wherever the embedded bundle is reachable; prefer this
/// form only where no resolver is available and the caller resolves existence
/// itself.
pub fn route(path: &str) -> Route<'_> {
    route_with(path, |_| true)
}

/// Resolve a request path, asking the resolver whether a candidate asset
/// genuinely exists.
///
/// `exists` is the ONE definition of "this asset is real", supplied by the
/// caller so this module never grows a second, divergent path-resolution
/// system. The listener passes the embedded bundle
/// ([`super::server`]'s `embedded_asset` lookup), so the classification and the
/// bytes that are later served can never disagree about existence.
///
/// A `/assets/` path is an [`Route::Asset`] only when the resolver confirms the
/// file is there. A well-formed but ABSENT asset is [`Route::NotFound`]: it must
/// never become the SPA shell, because answering a missing script or stylesheet
/// with an HTML document surfaces in the browser as a baffling parse error
/// rather than an honest 404.
///
/// The safety rules are unchanged and still structural: `asset_key` refuses an
/// unsafe path before `exists` is ever consulted, so no traversal attempt is
/// ever looked up, and a refused `/assets/` path stays `NotFound`.
pub fn route_with<'a, F: Fn(&str) -> bool>(path: &'a str, exists: F) -> Route<'a> {
    if path == "/" || path == INDEX {
        return Route::Index;
    }
    if let Some(key) = asset_key(path) {
        // A safe key is not yet an asset: it must also be present.
        return if exists(key) {
            Route::Asset(key)
        } else {
            Route::NotFound
        };
    }
    // The named root assets, and only those. This is checked BEFORE the
    // file-like-path rule below, which would otherwise claim every one of them
    // (they all carry an extension) and 404 them. It sits AFTER the `/assets/`
    // test so that namespace keeps its own strict handling untouched.
    //
    // These are also existence-checked: a name listed here but absent from the
    // bundle answers an honest 404 rather than an invented asset.
    if let Some(key) = root_asset_key(path) {
        return if exists(key) {
            Route::Asset(key)
        } else {
            Route::NotFound
        };
    }
    // Anything under `/assets/` that is not a safe key is a bad request, never
    // the shell: answering a missing stylesheet or script with HTML would
    // produce a confusing parse error in the browser instead of a clean 404.
    if path.starts_with("/assets/") {
        return Route::NotFound;
    }
    // A file-like path outside `/assets/` (anything with an extension) is a
    // missing file, not a route. Favouring a 404 keeps a mistyped `.js`/`.css`
    // reference from being answered with a whole HTML document.
    if path.rsplit('/').next().is_some_and(|last| last.contains('.')) {
        return Route::NotFound;
    }
    Route::Spa
}

/// Normalise a request path into an asset key.
///
/// Returns `None` for anything that is not a plain, forward-only path beneath
/// `/assets/`. This is what makes traversal structurally impossible rather than
/// merely filtered: a segment of `..` or `.`, a backslash, a NUL byte or a
/// double slash is refused before the string is ever handed to the resolver.
pub fn asset_key(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/assets/")?;
    if rest.is_empty() {
        return None;
    }
    let safe = !rest.contains("..")
        && !rest.contains('\\')
        && !rest.contains('\0')
        && !rest.contains("//")
        && rest
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if !safe {
        return None;
    }
    Some(path)
}

/// Whether this path belongs to the API rather than to the frontend.
///
/// The single decision point that keeps the two surfaces from ever answering
/// for each other. A path that merely *starts with the same characters* — say
/// `/api/v10/health` — is NOT an API path, because the separator is required.
pub fn is_api_path(path: &str) -> bool {
    path == API_PREFIX || path.starts_with(&format!("{API_PREFIX}/"))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_serves_the_shell() {
        assert_eq!(route("/"), Route::Index);
        assert_eq!(route("/index.html"), Route::Index);
    }

    #[test]
    fn a_client_route_falls_back_to_the_shell() {
        // The SPA fallback that makes a refresh or a shared deep link work.
        for route_path in ["/pos", "/reports", "/employees", "/pos/invoices"] {
            assert_eq!(route(route_path), Route::Spa, "{route_path}");
        }
    }

    #[test]
    fn a_missing_file_is_a_404_not_the_shell() {
        // Answering a missing script with a whole HTML document would surface
        // as a baffling parse error in the browser.
        assert_eq!(route("/nope.js"), Route::NotFound);
        // A well-formed `/assets/` path is only an asset when the bundle really
        // carries it; absent, it is an honest 404 and never the shell.
        assert_eq!(
            route_with("/assets/missing-abc.js", |_| false),
            Route::NotFound
        );
    }

    #[test]
    fn assets_are_recognised() {
        // Existence is the resolver's job, so this states the rule against an
        // explicit bundle rather than a hardcoded build fingerprint. A real
        // bundled script is an asset...
        let bundled = ["/assets/index-abc123.js", "/assets/index-Ab12Cd34.css"];
        for path in bundled {
            assert_eq!(
                route_with(path, |key| bundled.contains(&key)),
                Route::Asset(path),
                "{path}"
            );
        }
        // ...and the very same well-formed path is a 404 when the bundle does
        // not carry it. This is the whole point of the existence check: the
        // syntax alone must never promote a missing file to an asset.
        for path in bundled {
            assert_eq!(route_with(path, |_| false), Route::NotFound, "{path}");
        }
    }

    #[test]
    fn a_missing_asset_is_never_the_shell_however_it_is_asked() {
        // The same absent path must be `NotFound` and never the shell, so a
        // missing script can never be answered with an HTML document.
        for path in ["/assets/missing-abc.js", "/assets/missing-abc123.js"] {
            assert_eq!(route_with(path, |_| false), Route::NotFound, "{path}");
            assert!(
                !matches!(route_with(path, |_| false), Route::Spa | Route::Index),
                "{path} must never fall back to the shell"
            );
        }
        // Absent root assets behave identically, rather than being invented.
        for path in ROOT_ASSETS {
            assert_eq!(route_with(path, |_| false), Route::NotFound, "{path}");
        }
    }

    #[test]
    fn the_named_root_assets_are_served() {
        // The application references these three by a root-relative URL, because
        // Vite copies `public/` to the root of the bundle without fingerprinting
        // it. They must reach the SAME embedded lookup as `/assets/`, not a
        // second one — hence `Route::Asset` with the request path as the key.
        for path in ROOT_ASSETS {
            assert_eq!(route_with(path, |key| ROOT_ASSETS.contains(&key)), Route::Asset(path), "{path}");
            assert_eq!(root_asset_key(path), Some(path), "{path}");
        }
    }

    #[test]
    fn the_root_asset_list_is_exactly_what_the_application_asks_for() {
        // The list is a closed set, asserted rather than trusted: a fourth entry
        // is a deliberate decision that has to be made here on purpose.
        assert_eq!(
            ROOT_ASSETS,
            [
                "/station-cafe.png",
                "/station-print.png",
                "/site.webmanifest"
            ]
        );
    }

    #[test]
    fn an_arbitrary_root_file_is_still_a_404() {
        // The point of the allow-list. A root file that is real in the bundle but
        // not listed must NOT become reachable just because it exists, and must
        // not be answered with the shell either.
        for path in [
            "/foo.png",
            "/secret.txt",
            "/index.html.bak",
            "/.env",
            "/package.json",
            "/vite.config.ts",
        ] {
            assert!(root_asset_key(path).is_none(), "{path} must not resolve");
            assert_eq!(route(path), Route::NotFound, "{path}");
        }
    }

    #[test]
    fn a_root_asset_name_is_matched_exactly() {
        // No prefix, subdirectory, case-folding or extension tricks: a match
        // requires the full name, character for character.
        for path in [
            "/station-cafe.PNG",
            "/Station-Cafe.png",
            "/station-cafe.png.bak",
            "/assets/../station-cafe.png",
            "/station-cafe.png/extra",
            "/sub/station-cafe.png",
            "//station-cafe.png",
            "/",
        ] {
            assert!(root_asset_key(path).is_none(), "{path} must not resolve");
        }
    }

    #[test]
    fn a_root_asset_cannot_smuggle_a_traversal() {
        // None of these equals a listed name, so the closed set refuses them
        // before they can reach the resolver. The invariant asserted here is the
        // one that matters: a crafted path NEVER becomes an `Asset` key, so no
        // lookup is ever performed on its behalf. Where it lands afterwards is
        // the pre-existing behaviour of a non-matching path (the extension rule
        // or the SPA fallback), which this change deliberately does not alter.
        for attempt in [
            "/station-cafe.png/../../../etc/passwd",
            "/site.webmanifest/../secret",
            "/assets/../station-print.png",
            "/station-print.png/..",
        ] {
            assert!(root_asset_key(attempt).is_none(), "{attempt}");
            assert!(
                !matches!(route(attempt), Route::Asset(_)),
                "{attempt} must never resolve to an asset"
            );
        }
        // `/assets/` keeps its own strict rule regardless of the root list.
        assert_eq!(route("/assets/../station-print.png"), Route::NotFound);
    }

    #[test]
    fn the_shell_and_api_routing_are_unchanged_by_the_root_assets() {
        // Adding three asset names must not have moved the boundary between the
        // three surfaces.
        assert_eq!(route("/"), Route::Index);
        assert_eq!(route("/index.html"), Route::Index);
        assert_eq!(route("/pos"), Route::Spa);
        assert_eq!(route("/reports"), Route::Spa);
        assert!(is_api_path("/api/v1/health"));
        assert!(!is_api_path("/station-cafe.png"));
        assert!(!is_api_path("/assets/app.js"));
    }

    #[test]
    fn traversal_cannot_resolve_to_an_asset() {
        // Structural refusal, not a filter: none of these ever become a key.
        for attempt in [
            "/assets/../../etc/passwd",
            "/assets/..%2f..%2fetc/passwd",
            "/assets/a/../../b",
            "/assets/./x",
            "/assets//x",
            "/assets/",
        ] {
            assert_eq!(asset_key(attempt), None, "{attempt} must not resolve");
            assert_eq!(route(attempt), Route::NotFound, "{attempt}");
        }
    }

    #[test]
    fn a_backslash_is_not_an_asset_key() {
        assert_eq!(asset_key("/assets/..\\..\\secret"), None);
    }

    #[test]
    fn api_paths_are_never_the_frontend() {
        assert!(is_api_path("/api/v1/health"));
        assert!(is_api_path("/api/v1/cmd/list_products"));
        assert!(is_api_path("/api/v1"));
        assert!(!is_api_path("/api/v10/health"));
        assert!(!is_api_path("/pos"));
    }
}
