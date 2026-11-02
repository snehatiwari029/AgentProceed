import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NINE } from './fixtures'
import { fakeClient, mock } from './mockSupabase'

vi.mock('../shared/supabase', () => ({ supabase: fakeClient }))

import AppRoutes from '../app/AppRoutes'

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )

beforeEach(() => {
  sessionStorage.clear()
  mock.hang = false
  mock.next = { data: NINE, error: null }
  // The home cards also read the order tables; they are empty here (products stay the fallback for everything else).
  mock.tables = Object.fromEntries(['receipts', 'grants', 'disputes', 'dispute_events', 'sessions'].map((t) => [t, { data: [], error: null }]))
})

describe('Dashboard and routing', () => {
  it('/dashboard asks for the demo sign-in first, then shows the dashboard: logo + page title header and four nav items', async () => {
    const user = userEvent.setup()
    at('/dashboard')
    expect(screen.getByRole('heading', { name: 'Merchant sign-in' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(await screen.findByText(/products in the store/)).toHaveTextContent('products in the store')
    const nav = screen.getByRole('navigation', { name: 'Dashboard' })
    expect(nav).toHaveTextContent('Dashboard')
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'Agent Receipt', 'Agent Dispute', 'Agent Optimize'])
    expect(within(nav).getByRole('link', { name: 'Agent Receipt' })).toHaveAttribute('href', '/dashboard/orders')
    expect(within(nav).getByRole('link', { name: 'Agent Dispute' })).toHaveAttribute('href', '/dashboard/disputes')
    expect(within(nav).getByRole('link', { name: 'Agent Optimize' })).toHaveAttribute('href', '/dashboard/optimization')
    expect(within(nav).queryByRole('link', { name: 'Agent activity' })).not.toBeInTheDocument()
    const header = screen.getByTestId('dash-header')
    expect(within(header).getByText('Agent', { exact: true })).toBeInTheDocument()
    expect(within(header).getByTestId('page-title')).toHaveTextContent('Dashboard')
    await user.click(within(nav).getByRole('link', { name: 'Agent Dispute' }))
    expect(within(header).getByTestId('page-title')).toHaveTextContent('Agent Dispute')
    expect(nav).not.toHaveTextContent(/tamper/i)
  })

  it('"View Store" is an internal link to /shop and opens the shop in the same app', async () => {
    const user = userEvent.setup()
    at('/dashboard')
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))
    const link = screen.getByRole('link', { name: 'View Store' })
    expect(link).toHaveAttribute('href', '/shop')
    expect(link).not.toHaveAttribute('target')
    await user.click(link)
    expect(await screen.findByRole('heading', { name: 'Snowboard and Ski Gear' })).toBeInTheDocument()
    expect(await screen.findAllByTestId('product-card')).toHaveLength(9)
  })

  it('the shop has no link back to the dashboard', async () => {
    at('/shop')
    await screen.findAllByTestId('product-card')
    for (const a of screen.getAllByRole('link')) expect(a.getAttribute('href')).toMatch(/^#/)
  })

  it('unknown paths fall back to the public page', () => {
    at('/nowhere')
    expect(screen.getByRole('heading', { level: 1, name: /Everything merchants need to sell confidently when the shopper is an AI agent/ })).toBeInTheDocument()
  })

  it('the old /dashboard/tamper URL renders no Tamper page: it falls back to the Dashboard home', async () => {
    const user = userEvent.setup()
    at('/dashboard/tamper')
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('main')).not.toHaveTextContent(/tamper/i)
    expect(screen.queryByRole('button', { name: 'Verify chain' })).not.toBeInTheDocument()
  })

  it('/dashboard/optimize opens the Listing Optimizer page', async () => {
    const user = userEvent.setup()
    at('/dashboard/optimize')
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))
    expect(await screen.findByRole('heading', { name: 'Listing Optimizer' })).toBeInTheDocument()
  })

  it('a direct login shows a Start tour button and no tour offer', async () => {
    const user = userEvent.setup()
    at('/dashboard')
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))
    expect(screen.getByRole('button', { name: 'Start tour' })).toBeInTheDocument()
    expect(screen.queryByText('Order placed — now see what the merchant sees')).not.toBeInTheDocument()
  })

  it('after the phone flow the tour is offered once; five stops with a bold title and one line, Back, Next, Skip and Done', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('agentreceipt-demo-merchant', 'yes')
    sessionStorage.setItem('agentreceipt-tour-offer', '/dashboard/optimize')
    at('/dashboard')
    expect(screen.getByRole('heading', { name: 'Order placed — now see what the merchant sees' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /take 2-minute guided tour/i }))
    expect(sessionStorage.getItem('agentreceipt-tour-offer')).toBeNull()
    expect(await screen.findByText('Stop 1 of 5')).toBeInTheDocument()
    const text = () => screen.getByTestId('tour-text')
    expect(text().querySelector('strong')).toHaveTextContent('Agent activity:')
    expect(text()).toHaveTextContent('Agent activity: Watch in which stage are their agents and agent receipt verdict of each agent trying to checkout.')
    for (const name of ['Back', 'Next', 'Skip']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    const titles = ['Agent activity:', 'Agent Receipt:', 'Agent Dispute:', 'Agent Optimize:', 'Read as Agent:']
    for (let n = 2; n <= 5; n++) {
      await user.click(screen.getByRole('button', { name: 'Next' }))
      expect(screen.getByText(`Stop ${n} of 5`)).toBeInTheDocument()
      expect(text().querySelector('strong')).toHaveTextContent(titles[n - 1])
    }
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Stop 4 of 5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog', { name: 'Guided tour' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Listing Optimizer' })).toBeInTheDocument()
  })

  it('Skip ends the tour from any stop', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('agentreceipt-demo-merchant', 'yes')
    at('/dashboard')
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    expect(await screen.findByText('Stop 1 of 5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.queryByRole('dialog', { name: 'Guided tour' })).not.toBeInTheDocument()
  })
})
