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
  it('/dashboard asks for the demo sign-in first, then shows the dark dashboard with all five sections', async () => {
    const user = userEvent.setup()
    at('/dashboard')
    expect(screen.getByRole('heading', { name: 'Merchant sign-in' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /sign in as demo merchant/i }))

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(await screen.findByText(/products in the store/)).toHaveTextContent('products in the store')
    const nav = screen.getByRole('navigation', { name: 'Dashboard' })
    expect(nav).toHaveTextContent('Dashboard')
    for (const label of ['Dashboard', 'Agent orders', 'Agent activity', 'Disputes', 'Listing Optimizer']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
    }
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'Agent orders', 'Agent activity', 'Disputes', 'Listing Optimizer'])
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

  it('after the phone flow the tour is offered once, and the tour has Back, Next, Skip and a step count', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem('agentreceipt-demo-merchant', 'yes')
    sessionStorage.setItem('agentreceipt-tour-offer', '/dashboard/optimize')
    at('/dashboard')
    expect(screen.getByRole('heading', { name: 'Order placed — now see what the merchant sees' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /take 2-minute guided tour/i }))
    expect(sessionStorage.getItem('agentreceipt-tour-offer')).toBeNull()
    expect(await screen.findByText('Step 1 of 6')).toBeInTheDocument()
    for (const name of ['Back', 'Next', 'Skip']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 6')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.getByText('Tour complete — explore on your own now.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close tour' }))
    expect(await screen.findByRole('heading', { name: 'Listing Optimizer' })).toBeInTheDocument()
  })
})
