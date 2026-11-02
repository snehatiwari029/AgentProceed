// The hero artwork: three AI agents (left) each connected to one merchant shop (right). One SVG, CSS animation only
// (site.css, "hero scene"). Flat shapes in white and teal, no gradients, no text inside the artwork.
// Base layer: faint roads and a lattice, always visible. Animated layer: three thick white lines that draw from agent
// to shop, staggered 0.5s, hold with a gentle pulse, and loop every 10s; a small dot travels each line once drawn.
// prefers-reduced-motion shows the final drawn state with no animation.

const TEAL = '#2fcbbf'
const WHITE = '#ffffff'
const ROWS = [100, 240, 380]
const AGENT_X = 96
const SHOP_X = 544
const R = 46

// Agent i to shop i. Starts and ends on the circles' rims.
const link = (y: number) => `M${AGENT_X + R} ${y} C ${AGENT_X + 170} ${y - 70}, ${SHOP_X - 170} ${y + 70}, ${SHOP_X - R} ${y}`
// Faint roads: every agent to every shop.
const road = (a: number, b: number) => `M${AGENT_X + R} ${a} C ${AGENT_X + 160} ${a}, ${SHOP_X - 160} ${b}, ${SHOP_X - R} ${b}`

// The dashboard map's bot glyph (AgentActivity BotIcon), drawn on a 24-unit grid and scaled up.
function Agent({ y }: { y: number }) {
  return (
    <g>
      <circle cx={AGENT_X} cy={y} r={R} fill={WHITE} fillOpacity={0.08} stroke={WHITE} strokeWidth={3} />
      <g transform={`translate(${AGENT_X - 24} ${y - 24}) scale(2)`} fill="none" stroke={WHITE} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v3" />
        <circle cx="12" cy="2.5" r="0.6" fill={WHITE} />
        <rect x="4.5" y="6" width="15" height="12" rx="3" />
        <circle cx="9.5" cy="12" r="1.3" fill={TEAL} stroke="none" />
        <circle cx="14.5" cy="12" r="1.3" fill={TEAL} stroke="none" />
        <path d="M9.5 15.5h5M2.5 11v3M21.5 11v3" />
      </g>
    </g>
  )
}

// A simple storefront: sign, striped awning, shop body, door.
function Shop({ y }: { y: number }) {
  return (
    <g>
      <circle cx={SHOP_X} cy={y} r={R} fill={WHITE} fillOpacity={0.08} stroke={WHITE} strokeWidth={3} />
      <g transform={`translate(${SHOP_X - 24} ${y - 24}) scale(2)`}>
        <rect x="8" y="2.5" width="8" height="2.5" rx="0.6" fill={WHITE} />
        {[0, 1, 2, 3].map((i) => <rect key={i} x={4 + i * 4} y="6" width="4" height="4" fill={i % 2 ? TEAL : WHITE} />)}
        <rect x="5" y="10" width="14" height="10" fill="none" stroke={WHITE} strokeWidth="1.5" />
        <rect x="10.25" y="13.5" width="3.5" height="6.5" fill={TEAL} />
      </g>
    </g>
  )
}

export default function HeroScene({ label }: { label: string }) {
  return (
    <svg className="hero-scene" viewBox="0 0 640 480" role="img" aria-label={label} data-testid="hero-scene">
      <g className="scene-base" fill="none" stroke={WHITE} strokeLinecap="round">
        {[160, 220, 280, 340, 400, 460].map((x) => <path key={`v${x}`} d={`M${x} 40V440`} strokeWidth={1} opacity={0.08} />)}
        {[60, 140, 220, 300, 380, 440].map((y) => <path key={`h${y}`} d={`M150 ${y}H490`} strokeWidth={1} opacity={0.08} />)}
        {ROWS.flatMap((a) => ROWS.map((b) => <path key={`r${a}-${b}`} d={road(a, b)} strokeWidth={1.5} opacity={0.18} />))}
      </g>
      <g className="scene-links" fill="none" stroke={WHITE} strokeWidth={7} strokeLinecap="round">
        {ROWS.map((y, i) => <path key={y} className={`scene-link scene-link-${i + 1}`} d={link(y)} pathLength={1} />)}
      </g>
      <g className="scene-dots">
        {ROWS.map((y, i) => (
          <circle key={y} className={`scene-dot scene-dot-${i + 1}`} r={7} fill={TEAL} stroke={WHITE} strokeWidth={2} style={{ offsetPath: `path('${link(y)}')` }} />
        ))}
      </g>
      {ROWS.map((y) => <Agent key={`a${y}`} y={y} />)}
      {ROWS.map((y) => <Shop key={`s${y}`} y={y} />)}
    </svg>
  )
}
