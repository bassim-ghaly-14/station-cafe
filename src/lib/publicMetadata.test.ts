/**
 * PUBLIC BRANDING — the Telegram / Mini App logo contract.
 *
 * The failure this file exists to prevent
 * --------------------------------------
 * Telegram's Bot Start and Mini App previews, and every other link-preview
 * crawler, fetch the application document and then fetch the image that
 * document names. That second fetch is made by TELEGRAM, against a PUBLIC
 * origin, using whatever URL the document contains.
 *
 * Station used to publish no image at all: `index.html` carried only a
 * `/favicon.svg` link (to a file that did not exist), so the preview rendered
 * with no logo. The naive fix — pointing `og:image` at `/station-cafe.png` —
 * is silently wrong for the same reason: a root-relative path resolves against
 * TELEGRAM's host, not the cafe's, and the preview stays blank while every
 * local check passes. The reference has to be absolute.
 *
 * The other half is just as important. The in-app logo is deliberately NOT
 * switched to the CDN: the installed desktop application and the phone browser
 * served over the cafe LAN must both work with NO internet, which a CDN URL
 * cannot promise. So the two are split, and both halves are asserted below —
 * a test that only checked the metadata would happily let someone "fix" the
 * logo component and break offline operation.
 *
 * Files are read as raw text through Vite rather than with `node:fs`, matching
 * `releaseIntegrity.test.ts`, so the bundle's type boundary is preserved.
 */
import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import manifestRaw from '../../public/site.webmanifest?raw'
import logoRaw from '../components/branding/Logo?raw'

/** The canonical, publicly reachable Station mark. */
const CANONICAL_LOGO_URL =
  'https://res.cloudinary.com/paihc5qx/image/upload/v1790005045/station-cafe_u4oj0a.png'

/**
 * The `content`/`href` of every metadata tag matching `selector`.
 *
 * Two details this has to get right, both of which are real traps:
 *
 *  1. `index.html` is Prettier-formatted, so an attribute list can wrap across
 *     several lines. Matching tag-by-line would silently find nothing.
 *  2. `og:image` is a PREFIX of `og:image:type`, `og:image:width` and
 *     `og:image:height`. A naive substring match therefore collects the MIME
 *     type `image/png` and the numbers `512` as if they were image URLs, and
 *     then correctly complains that they are not absolute.
 */
function imageReferences(html: string, selector: RegExp): string[] {
  // Normalise the wrapped attribute lists back onto one line per tag.
  const flat = html.replace(/\s*\n\s*/g, ' ')

  const refs: string[] = []
  for (const match of flat.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const tag = match[0]
    if (!selector.test(tag)) continue
    const value = tag.match(/(?:content|href)="([^"]+)"/i)?.[1]
    if (value) refs.push(value)
  }
  return refs
}

/** The `content` of the first tag carrying `attribute="needle"`. */
function metaContent(html: string, attribute: string, needle: string): string | undefined {
  const flat = html.replace(/\s*\n\s*/g, ' ')
  for (const match of flat.matchAll(/<(?:meta|link)\b[^>]*>/gi)) {
    const tag = match[0]
    if (tag.includes(`${attribute}="${needle}"`)) {
      return tag.match(/(?:content|href)="([^"]+)"/i)?.[1]
    }
  }
  return undefined
}

/*
 * The two categories, which must never be confused with one another. Getting
 * this backwards is how a "fix" for the Telegram logo silently breaks offline
 * operation, or how an offline-first fix silently leaves Telegram blank.
 *
 * CRAWLER_METADATA is fetched by Telegram (and every other preview service)
 * from a public origin, so it MUST be absolute or the preview shows no logo.
 *
 * RUNTIME_ICON is fetched by the BROWSER while the application runs, from the
 * cafe's own origin, and is bound by the Content-Security-Policy. It MUST be
 * local, or the application stops working with no internet — and the CSP, which
 * loads no remote origin at all, would block the request regardless.
 */
const CRAWLER_METADATA =
  /\b(?:property|name)="(?:og:image|og:image:secure_url|twitter:image)"(?:[ "/])/i
const RUNTIME_ICON = /\brel="(?:icon|apple-touch-icon)"/i

describe('public / Telegram branding metadata', () => {
  it('publishes the canonical Cloudinary logo in the document head', () => {
    // The single most important assertion: the URL Telegram will fetch.
    expect(metaContent(indexHtml, 'property', 'og:image')).toBe(CANONICAL_LOGO_URL)
  })

  it('names no relative or protocol-relative image in crawler metadata', () => {
    /*
     * The exact defect that produced a blank Telegram preview. A value that is
     * not an absolute https URL cannot be resolved by a crawler that fetched
     * the document from somewhere else, so every CRAWLER-read image reference
     * must be absolute.
     */
    const refs = imageReferences(indexHtml, CRAWLER_METADATA)
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref, `"${ref}" is not an absolute URL`).toMatch(/^https:\/\//)
      expect(ref, `"${ref}" must be the canonical logo`).toBe(CANONICAL_LOGO_URL)
    }
  })

  it('uses the same canonical logo for every crawler that reads metadata', () => {
    // Open Graph (Telegram, Slack, WhatsApp), the secure variant and X/Twitter
    // each read their own tag. If one is left on a local path, the logo simply
    // does not appear on that platform and nothing else reports it.
    const refs = imageReferences(indexHtml, CRAWLER_METADATA)
    expect(new Set(refs)).toEqual(new Set([CANONICAL_LOGO_URL]))
    // og:image, og:image:secure_url and twitter:image are all really present.
    expect(refs.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the browser-fetched icons on the local asset', () => {
    /*
     * The other half of the split, and the one that is easiest to break while
     * "fixing" the logo. The favicon and apple-touch-icon are fetched BY THE
     * BROWSER at runtime from the cafe's own origin, and are bound by the CSP
     * — which loads no remote origin at all. Pointing them at the CDN would
     * break the tab icon offline and be blocked anyway.
     */
    const icons = imageReferences(indexHtml, RUNTIME_ICON)
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon, `"${icon}" must stay local`).toBe('/station-cafe.png')
    }
  })

  it('points no icon at a file that does not exist', () => {
    // The document used to reference `/favicon.svg`, which is not in `public/`,
    // so every single load of the application made a guaranteed 404 for it.
    // The rendered result is a blank tab icon and a console error, neither of
    // which any build step reports.
    for (const icon of imageReferences(indexHtml, RUNTIME_ICON)) {
      expect(icon).not.toBe('/favicon.svg')
      // Every root-relative asset reference must be a real file in `public/`.
      expect(icon.startsWith('/') && icon.endsWith('.png')).toBe(true)
    }
  })

  it('declares a manifest whose icons are the canonical logo', () => {
    // An installed / standalone web app is one of the ways Station reaches a
    // phone, and its icon has the same absolute-URL requirement.
    expect(indexHtml).toContain('rel="manifest"')

    const manifest = JSON.parse(manifestRaw) as {
      icons?: { src?: string; sizes?: string }[]
    }
    expect(manifest.icons?.length).toBeGreaterThan(0)
    for (const icon of manifest.icons ?? []) {
      expect(icon.src).toBe(CANONICAL_LOGO_URL)
      expect(icon.src).toMatch(/^https:\/\//)
    }
  })

  it('identifies the application in the metadata Telegram renders', () => {
    // A preview with no title is a preview that reads as a bare link.
    expect(metaContent(indexHtml, 'property', 'og:title')).toBe('Station Cafe')
    expect(metaContent(indexHtml, 'property', 'og:description')).toBeTruthy()
    expect(metaContent(indexHtml, 'name', 'theme-color')).toBeTruthy()
  })

  it('does not make the running application depend on a remote origin', () => {
    /*
     * The load-bearing offline guarantee. The metadata above is inert — nothing
     * in `src/` fetches it — so no remote origin is loaded at runtime and the
     * Content-Security-Policy in `tauri.conf.json` can keep loading no remote
     * origin at all. If a future change points the Logo COMPONENT at the CDN,
     * this fails, and that is the point: offline operation is the requirement
     * the CDN must not be allowed to erode.
     */
    expect(logoRaw).toContain('src="/station-cafe.png"')
    expect(logoRaw).not.toContain('res.cloudinary.com')
  })
})
