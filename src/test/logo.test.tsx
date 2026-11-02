import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AgentProceedLogo, AgentProceedMark, BRAND_NAVY, BRAND_TEAL } from '../shared/brand/Logo'

describe('Agent Proceed logo', () => {
  it('wordmark reads exactly "Agent Proceed", Agent in navy and Proceed in teal on light', () => {
    const { container } = render(<AgentProceedLogo variant="light" />)
    expect(container.textContent).toBe('Agent Proceed')
    const [agent, proceed] = [...container.querySelectorAll('span span span')] as HTMLElement[]
    expect(agent.style.color).toBe('rgb(20, 37, 74)')
    expect(proceed.style.color).toBe('rgb(47, 203, 191)')
  })

  it('dark and purple variants draw the mark and "Agent" in white; eyes stay teal', () => {
    for (const variant of ['dark', 'purple'] as const) {
      const { container, unmount } = render(<AgentProceedLogo variant={variant} />)
      expect(container.querySelector('rect')!.getAttribute('stroke')).toBe('#ffffff')
      expect(container.querySelector('path[fill]')!.getAttribute('fill')).toBe('#ffffff')
      expect([...container.querySelectorAll('circle')].map((c) => c.getAttribute('fill'))).toEqual([BRAND_TEAL, BRAND_TEAL])
      expect((container.querySelector('span span span') as HTMLElement).style.color).toBe('rgb(255, 255, 255)')
      unmount()
    }
  })

  it('the mark is flat: head outline, two eyes, antenna and arrowhead, no gradients or filters', () => {
    const { container } = render(<AgentProceedMark variant="light" />)
    expect(container.querySelectorAll('rect')).toHaveLength(1)
    expect(container.querySelectorAll('circle')).toHaveLength(2)
    expect(container.querySelectorAll('path')).toHaveLength(2)
    expect(container.querySelector('linearGradient, radialGradient, filter')).toBeNull()
    expect(container.querySelector('rect')!.getAttribute('stroke')).toBe(BRAND_NAVY)
  })

  it('index.html links the SVG favicon, which uses only the logo navy, teal and white', () => {
    expect(readFileSync('index.html', 'utf8')).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    const colours = new Set(readFileSync('public/favicon.svg', 'utf8').match(/#[0-9a-f]{6}/gi)!.map((c) => c.toLowerCase()))
    expect([...colours].sort()).toEqual([BRAND_NAVY, BRAND_TEAL, '#ffffff'].sort())
  })
})
