/**
 * The Station QR image itself — presentation only, no data fetching.
 *
 * Why it is extracted
 * -------------------
 * The SVG arrives fully rendered from Rust (`network::qr::render_svg`), and the
 * URL beside it is built in Rust too. Neither the encoding nor the payload
 * assembly may exist twice, so this component deliberately does NOT know how
 * the SVG was produced or who asked for it: it takes the document and renders
 * it. The Dev Settings card and the standalone QR Code page therefore show the
 * SAME code from the SAME source, and there is no second implementation to
 * drift.
 *
 * Why the surface stays white in both themes
 * ------------------------------------------
 * A QR is a machine-readable pattern, not a themed illustration. It is dark
 * modules on a light quiet zone by specification, so the scanning surface is
 * pinned to a light neutral (`bg-white`) in BOTH themes rather than inverted in
 * dark mode: inverting, tinting or theming the code is the fastest way to make
 * a phone camera fail to read it. Only the page and the card around it follow
 * the theme, so the card still integrates with the dark surface hierarchy
 * while the code itself stays exactly as scannable as it is in light mode.
 *
 * The `bg-white` here is the one deliberate literal in this feature, and it is
 * deliberate for the reason above rather than as a missed token.
 */
import { cn } from '@/lib/utils'

export function StationQrCode({
  svg,
  alt,
  className,
  testId,
}: Readonly<{
  /** The SVG document exactly as the backend produced it. */
  readonly svg: string
  /** Accessible name. The image carries meaning, so it is never decorative. */
  readonly alt: string
  /** Size and placement. Square and responsive, never a fixed desktop size. */
  readonly className?: string
  readonly testId?: string
}>) {
  return (
    // LTR: a QR is a fixed grid, and its orientation must not follow the page
    // direction. `dir="ltr"` keeps it identical under the Arabic RTL layout.
    <div dir="ltr" className={cn('flex justify-center', className)}>
      {/*
        The quiet zone. A QR needs clear space around it equal to roughly one
        module width or a scanner can miss the outer finder patterns, so the
        padding is part of the image's correctness and is not decoration.
        Rendered from the inline `data:` document the backend returned — no
        external fetch, no scaling filter, no CSS transform, so what is drawn
        is exactly what Rust encoded.
      */}
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
        alt={alt}
        data-testid={testId}
        className="aspect-square w-full max-w-64 rounded-md bg-white p-4"
      />
    </div>
  )
}
