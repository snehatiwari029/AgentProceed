import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import AppRoutes from '../app/AppRoutes'
import HeroScene from '../site/HeroScene'

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>)

describe('Hackathon page', () => {
  it('/hackathon shows the tagline, three demo links, the repo link and the two-minute path', () => {
    at('/hackathon')
    expect(document.querySelector('.hack-tagline')).toHaveTextContent('Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent.')
    expect(screen.getByTestId('demo-chat')).toHaveAttribute('href', '/chat')
    expect(screen.getByTestId('demo-shop')).toHaveAttribute('href', '/shop')
    expect(screen.getByTestId('demo-dashboard')).toHaveAttribute('href', '/dashboard')
    expect(screen.getByTestId('demo-shop')).toHaveTextContent('Northwind Outfitters')
    expect(screen.getByTestId('demo-dashboard')).toHaveTextContent('pre-filled for Northwind Outfitters')
    expect(screen.getByRole('link', { name: /Source code on GitHub/ })).toHaveAttribute('href', 'https://github.com/snehatiwari029/AgentProceed')
    const steps = within(screen.getByRole('list')).getAllByRole('heading').map((h) => h.textContent)
    expect(steps).toEqual(['Chat', 'Store', 'Dashboard: agent activity map', 'Dashboard attention', 'Mismatch'])
  })

  it('the fourth feature entry is the Agent Activity tracker: headline, body, live-map screenshot and a link to /dashboard', () => {
    at('/')
    const card = screen.getByTestId('feature-bot')
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('See every agent in your store.')
    expect(card).toHaveTextContent('Each bot icon is a real session record, with a verdict badge for its receipt.')
    expect(within(card).getByRole('img')).toHaveAttribute('src', '/features/agent-activity-map.jpg')
    expect(within(card).getByRole('img').getAttribute('alt')).toMatch(/simulated agent traffic/)
    expect(within(card).getByRole('link', { name: /See it in the dashboard/ })).toHaveAttribute('href', '/dashboard')
    const tools = within(screen.getByRole('list', { name: 'Tools' })).getAllByRole('link').map((a) => a.textContent)
    expect(tools).toEqual(['Agent Receipt', 'Listing Optimizer + Read as Agent', 'Evidence Packet', 'Agent Activity tracker'])
  })

  it('the main navigation links to /hackathon from the home page', () => {
    at('/')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Hackathon' })).toHaveAttribute('href', '/hackathon')
  })
})

describe('Hero scene', () => {
  it('3 agents, 3 shops, 9 faint roads, 3 thick links (agent i to shop i) and no text in the artwork', () => {
    const { container } = render(<HeroScene label="scene" />)
    const svg = container.querySelector('svg')!
    expect(svg.querySelectorAll('.scene-link')).toHaveLength(3)
    expect(svg.querySelectorAll('.scene-dot')).toHaveLength(3)
    expect(svg.querySelectorAll('.scene-base path[stroke-width="1.5"]')).toHaveLength(9)
    expect(svg.querySelector('text, linearGradient, radialGradient, image, foreignObject')).toBeNull()
    for (const [i, y] of [100, 240, 380].entries()) {
      const d = svg.querySelector(`.scene-link-${i + 1}`)!.getAttribute('d')!
      expect(d.startsWith(`M142 ${y}`) && d.endsWith(`498 ${y}`)).toBe(true)
    }
  })

  it('CSS: 10s loop, 0.5s stagger, and reduced motion shows the drawn state with no animation', () => {
    const css = readFileSync('src/site/site.css', 'utf8')
    expect(css).toMatch(/\.scene-link \{[^}]*animation: ap-draw 10s/)
    expect(css).toMatch(/\.scene-link-2, \.site \.scene-dot-2 \{ animation-delay: 0\.5s; \}/)
    expect(css).toMatch(/\.scene-link-3, \.site \.scene-dot-3 \{ animation-delay: 1s; \}/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.site \.scene-link \{ animation: none; stroke-dashoffset: 0; opacity: 1; \}/)
  })
})

describe('Hackathon page: Evals Results', () => {
  it('comes after the three demos and shows the eval numbers with their baselines, exactly as in the report', () => {
    at('/hackathon')
    const heading = screen.getByRole('heading', { name: 'Evals Results' })
    const demos = screen.getByTestId('demo-dashboard')
    expect(demos.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const rows = within(screen.getByTestId('evals-table')).getAllByRole('row').slice(1).map((r) => Array.from(r.children).slice(0, 3).map((c) => c.textContent))
    expect(rows).toEqual([
      ['Miss rate', '0.0%', '100.0%'],
      ['Chargebacks prevented', '100.0%', '0.0%'],
      ['False-hold rate', '0.0%', '0.0%'],
      ['Accuracy', '80.0%', '33.3%'],
      ['Receipt integrity', '93.3%', 'no receipt'],
    ])
    const report = readFileSync('evals/verdict_eval_results.md', 'utf8')
    for (const v of ['**0.0%** (0/10)', '**100.0%** (10/10)', '**0.0%** (0/5)', '**80.0%** (12/15)', '**93.3%** (14/15)', '33.3% (5/15)']) expect(report).toContain(v)
    expect(screen.getByRole('link', { name: /Full eval report on GitHub/ })).toHaveAttribute('href', 'https://github.com/snehatiwari029/AgentProceed/blob/main/evals/verdict_eval_results.md')
  })
})
