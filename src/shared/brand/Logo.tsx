// Agent Proceed logo: one inline SVG mark plus the "Agent Proceed" wordmark. Flat shapes only, no gradients or shadows.
// Mark (redrawn from the logo sheet): a rounded-square agent head outline, two teal dot eyes, and one antenna line from
// the top-right of the head ending in a solid arrowhead pointing up and right. public/favicon.svg is the same drawing.

// Navy and teal read from the logo sheet. Teal is also the shared palette's cyan-teal accent.
export const BRAND_NAVY = '#14254a'
export const BRAND_TEAL = '#2fcbbf'
export const BRAND_WHITE = '#ffffff'

// light = navy mark on light backgrounds; dark = white mark on dark (dashboard header);
// purple = white mark on the site's indigo-purple (site hero and header). Eyes stay teal in every variant.
export type LogoVariant = 'light' | 'dark' | 'purple'

export function AgentProceedMark({ variant = 'light', size = 32, title }: { variant?: LogoVariant; size?: number; title?: string }) {
  const ink = variant === 'light' ? BRAND_NAVY : BRAND_WHITE
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="3.25" y="14.25" width="28.5" height="23" rx="7" stroke={ink} strokeWidth="4.5" />
      <circle cx="12.5" cy="25.75" r="2.75" fill={BRAND_TEAL} />
      <circle cx="22.5" cy="25.75" r="2.75" fill={BRAND_TEAL} />
      <path d="M23 13 31.5 4.5" stroke={ink} strokeWidth="3.5" />
      <path d="M38 1 29.2 3.4 35.6 9.8Z" fill={ink} />
    </svg>
  )
}

// Full logo: mark + wordmark. "Agent" in navy (white on dark / purple), "Proceed" in teal. Exactly "Agent Proceed".
export function AgentProceedLogo({ variant = 'light', size = 32, className }: { variant?: LogoVariant; size?: number; className?: string }) {
  const agent = variant === 'light' ? BRAND_NAVY : BRAND_WHITE
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.3) }}>
      <AgentProceedMark variant={variant} size={size} />
      <span style={{ fontFamily: '"DM Sans", ui-sans-serif, system-ui, sans-serif', fontWeight: 600, fontSize: Math.round(size * 0.72), letterSpacing: '-0.015em', lineHeight: 1, whiteSpace: 'nowrap' }}>
        <span style={{ color: agent }}>Agent</span> <span style={{ color: BRAND_TEAL }}>Proceed</span>
      </span>
    </span>
  )
}
