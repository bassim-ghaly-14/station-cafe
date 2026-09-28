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

/// Resolve a request path against the Station frontend.
///
/// The path must already be free of its query string. Matching is exact and
/// case-sensitive.
pub fn route(path: &str) -> Route<'_> {
    if path == "/" || path == INDEX {
        return Route::Index;
    }
    if let Some(key) = asset_key(path) {
        return Route::Asset(key);
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
        assert_eq!(route("/assets/missing-abc.js"), Route::NotFound);
    }

    #[test]
    fn assets_are_recognised() {
        assert_eq!(
            route("/assets/index-abc123.js"),
            Route::Asset("/assets/index-abc123.js")
        );
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
