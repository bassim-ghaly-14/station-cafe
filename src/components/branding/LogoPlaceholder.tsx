/**
 * Placeholder logo — the real "Station Cafe" logo is not finalized.
 * Replace the internals of this single component (image / bitmap / text)
 * without touching any usage site. Never hardcode the final logo elsewhere.
 */
export function LogoPlaceholder({ size = 64 }: { size?: number }) {
  return (
    <div
      role="img"
      aria-label="Station Cafe"
      className="flex items-center justify-center rounded-lg bg-brand-100 font-bold text-brand-700 select-none"
      style={{ width: size, height: size, fontSize: size * 0.22 }}
    >
      <span dir="ltr">Station</span>
    </div>
  )
}
