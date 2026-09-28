// One-off audit of the BUILT dist/index.html: does the deployed artefact hand
// Telegram an absolute public logo while keeping runtime icons local?
import { readFileSync } from 'node:fs'

const CDN = 'https://res.cloudinary.com/paihc5qx/image/upload/v1790005045/station-cafe_u4oj0a.png'

const raw = readFileSync('dist/index.html', 'utf8')

// Strip HTML comments FIRST. The document carries a long comment explaining
// exactly this audit, and it necessarily quotes both the old broken
// `/favicon.svg` reference and the naive "point og:image at a local path"
// mistake. Auditing the raw text therefore "finds" both bugs in the prose that
// describes them. Only real tags are evidence.
const html = raw.replace(/<!--[\s\S]*?-->/g, '')
const flat = html.replace(/\s+/g, ' ')
const tags = flat.match(/<(?:meta|link)\b[^>]*>/g) ?? []

const value = (tag) => tag.match(/(?:content|href)="([^"]+)"/)?.[1]

const crawler = tags.filter((t) =>
  /\b(?:property|name)="(?:og:image|og:image:secure_url|twitter:image)"(?:[ "/])/.test(t),
)
const runtime = tags.filter((t) => /\brel="(?:icon|apple-touch-icon)"/.test(t))

console.log('CRAWLER METADATA (fetched by Telegram from a public origin):')
for (const tag of crawler) {
  const key = tag.match(/(?:property|name)="([^"]+)"/)?.[1]
  const v = value(tag)
  console.log(`  ${key.padEnd(20)} -> ${v === CDN ? 'ABSOLUTE CLOUDINARY OK' : `WRONG: ${v}`}`)
}

console.log('\nRUNTIME ICONS (fetched by the browser; local + CSP-safe):')
for (const tag of runtime) {
  const v = value(tag)
  console.log(`  ${v.padEnd(22)} -> ${v === '/station-cafe.png' ? 'local OK' : 'WRONG'}`)
}

// Match only a COMPLETE tag: `og:image` immediately followed by its closing
// quote and content. Without the trailing `"` this also matches `og:image:type`,
// whose content is the MIME type rather than a URL.
const nonAbsoluteCrawlerImage =
  /(?:og:image|og:image:secure_url|twitter:image)" content="(?!https:\/\/)/

console.log(
  '\nnon-absolute URL in crawler metadata?',
  nonAbsoluteCrawlerImage.test(flat) ? 'YES - BUG' : 'no',
)
console.log('leftover /favicon.svg reference?', html.includes('favicon.svg') ? 'YES - BUG' : 'no')
console.log(
  'runtime icons point at a real file in public/?',
  runtime.every((t) => value(t) === '/station-cafe.png') ? 'yes' : 'NO - BUG',
)
