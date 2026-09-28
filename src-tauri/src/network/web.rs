//! The browser surface: the Station web app, served from the SAME listener as
//! the API.
//!
//! Why these bytes live in the binary rather than on disk:
//!
//! The phone must work on a café LAN with no internet, and the app must work
//! from a single installed executable. So the shell, the stylesheet, the
//! scripts and the shared Arabic locale are compiled in with `include_bytes!`
//! and served from memory. There is no `resources/` directory to install, no
//! file path that can be wrong on another machine, and no possibility of the
//! UI being served stale relative to the binary.
//!
//! What this module is NOT:
//!
//! - Not a second server. Same port, same thread, same process as `/api/v1`.
//! - Not a build step. The browser receives the files verbatim; nothing is
//!   minified, bundled or transpiled at runtime.
//! - Not a source of business data. Every fact the UI shows comes from the
//!   existing API over the existing `Mutex<Connection>`.
//!
//! Routing is decided in [`super::server`] by a single prefix test, so an
//! unknown `/api/v1/*` path can never be answered with HTML here, and this
//! module is never consulted for an API path.

use super::api::API_PREFIX;

/// The document served for `/` and for `/index.html`.
pub const INDEX_HTML: &str = include_str!("../../../web/index.html");

/// One embedded file, with the content type it must be served as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asset {
    /// The exact request path this asset answers. Matched verbatim: there is no
    /// wildcard and no path traversal, because a client-supplied string is
    /// never used to build a filesystem path or a slice index.
    pub path: &'static str,
    pub content_type: &'static str,
    pub body: &'static [u8],
}

/// Every asset the local web app consists of.
///
/// The allowlist is closed by construction. A request for anything not listed
/// here is a 404, which is what keeps `/assets/../../something` — and any
/// attempt to reach a file outside this set — from resolving.
pub const ASSETS: &[Asset] = &[
    Asset {
        path: "/assets/app.css",
        content_type: "text/css; charset=utf-8",
        body: include_bytes!("../../../web/assets/app.css"),
    },
    Asset {
        path: "/assets/api.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../../../web/assets/api.js"),
    },
    Asset {
        path: "/assets/strings.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../../../web/assets/strings.js"),
    },
    Asset {
        path: "/assets/ui.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../../../web/assets/ui.js"),
    },
    Asset {
        path: "/assets/app.js",
        content_type: "text/javascript; charset=utf-8",
        body: include_bytes!("../../../web/assets/app.js"),
    },
    // The SAME Arabic locale the desktop application ships, embedded from its
    // real location so the two can never drift. Served as data, not executed.
    Asset {
        path: "/assets/ar.json",
        content_type: "application/json; charset=utf-8",
        body: include_bytes!("../../../src/locales/ar/translations.json"),
    },
];

/// The Content-Security-Policy sent with every HTML and script response.
///
/// `'self'` and nothing else: no CDN, no inline script, no remote font, no
/// framing, and no form posting anywhere. The app is written to satisfy this
/// policy exactly — that is why the shell has no inline `<script>` and the
/// stylesheet has no `@import`.
///
/// `connect-src 'self'` is what confines the browser to this one origin: even
/// if Station's own HTML were altered, the page could not phone home.
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// What a non-API path resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The application shell.
    Index,
    /// A known asset.
    Asset(&'static Asset),
    /// Nothing here. Deliberately NOT the shell: a mistyped URL must not be
    /// answered with a working page, and an API path must never be answered
    /// with HTML.
    NotFound,
}

/// Resolve a request path against the web surface.
///
/// The path must already be free of its query string. Matching is exact and
/// case-sensitive, and only `/` and `/index.html` reach the shell.
pub fn route(path: &str) -> Route {
    if path == "/" || path == "/index.html" {
        return Route::Index;
    }
    match ASSETS.iter().find(|asset| asset.path == path) {
        Some(asset) => Route::Asset(asset),
        None => Route::NotFound,
    }
}

/// The shell as bytes, with its content type.
pub fn index() -> (&'static str, &'static [u8]) {
    ("text/html; charset=utf-8", INDEX_HTML.as_bytes())
}

/// Whether this path belongs to the API rather than to the web app.
///
/// The single decision point that keeps the two surfaces from ever answering
/// for each other. A path that merely *starts with the same characters* — say
/// `/api/v10/health` — is NOT an API path, because the separator is required.
pub fn is_api_path(path: &str) -> bool {
    path == API_PREFIX || path.starts_with(&format!("{API_PREFIX}/"))
}
