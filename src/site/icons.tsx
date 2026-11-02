// Small inline icons for the public page. Colour comes from the surrounding text colour.
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export const Arrow = ({ down = false }: { down?: boolean }) => (
  <svg {...base} width={20} height={20} strokeWidth={2} style={down ? { transform: 'rotate(90deg)' } : undefined}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)
export const Fingerprint = ({ size = 28 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M12 11v3c0 2.5-.6 4.5-1.8 6.2" />
    <path d="M8.2 14c0-2.2.5-3.2 1.2-4a3.6 3.6 0 0 1 5.2 0c.7.8 1.2 1.8 1.2 4 0 1.8-.3 3.6-1 5.2" />
    <path d="M5 12.5a7 7 0 0 1 14 0c0 2 .1 3.4-.4 5" />
    <path d="M5.6 9a7.5 7.5 0 0 1 12.8 0" />
    <path d="M5 15.5c0 1.6-.3 2.8-.9 4" />
  </svg>
)
export const Package = ({ size = 26 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M12 3 4 7v9l8 4 3-1.5" />
    <path d="M4 7l8 4 8-4M12 11v9" />
    <path d="M20 8v4" />
    <path d="m16 18 2 2 4-4" />
  </svg>
)
export const Shield = ({ size = 26 }: { size?: number }) => (
  <svg {...base} width={size} height={size}>
    <path d="M12 3 5 6v5.5c0 4.2 2.8 7.4 7 9.5 4.2-2.1 7-5.3 7-9.5V6l-7-3Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
)
export const iconFor = (name: string) => (name === 'fingerprint' ? <Fingerprint /> : name === 'package' ? <Package /> : <Shield />)
// Icon disc per tool: Agent Receipt = shield, Evidence Packet = fingerprint, Listing Optimizer + Read as Agent = package.
export const toolIcon = (i: number) => (i === 0 ? <Shield /> : i === 1 ? <Fingerprint /> : <Package />)
