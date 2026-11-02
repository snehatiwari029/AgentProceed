import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.fn()
vi.mock('../shared/supabase', () => ({ supabase: { from: (t: string) => ({ insert: (row: unknown) => insert(t, row) }) } }))

import LandingPage from '../site/LandingPage'
import ProductsPage from '../site/ProductsPage'
import { content } from '../site/content'

const home = () => render(<MemoryRouter><LandingPage /></MemoryRouter>)
const products = () => render(<MemoryRouter><ProductsPage /></MemoryRouter>)

beforeEach(() => { insert.mockReset(); insert.mockResolvedValue({ error: null }) })

describe('Home page', () => {
  it('hero: headline, subheadline, Login for demo, See how it works, and the receipt image kept', () => {
    home()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Trust layer for\s*agentic\s*shopping/)
    expect(screen.getByText(/As your customers are changing from humans to agents/)).toBeInTheDocument()
    for (const a of screen.getAllByRole('link', { name: /Login for demo/ })) expect(a).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: /See how it works/ })).toHaveAttribute('href', '#how-it-works')
    const receipt = screen.getByRole('img', { name: /Sample receipt/ })
    expect(receipt).toHaveTextContent('Mismatch facts · not a liability decision')
  })

  it('hero shows the two Merchant badge tags over the receipt', () => {
    const { container } = home()
    const stage = container.querySelector('.card-stage') as HTMLElement
    const tags = stage.querySelectorAll('.tag')
    expect(tags).toHaveLength(2)
    expect(stage).toHaveTextContent('Merchant 1 not using Agent Proceed')
    expect(stage).toHaveTextContent('Order Fulfilled, Chargeback Received')
    expect(stage).toHaveTextContent('Merchant 2 using Agent Proceed')
    expect(stage).toHaveTextContent('Order Held and Confirmed, Chargeback Prevented')
  })

  it('nav: wordmark, How it works, Products (to /products), FAQ, Pilot and the Login button', () => {
    home()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '#how-it-works')
    expect(within(nav).getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products')
    expect(within(nav).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '#faq')
    expect(within(nav).getByRole('link', { name: 'Pilot' })).toHaveAttribute('href', '#pilot')
    expect(within(nav).getByRole('link', { name: /Login for demo/ })).toHaveAttribute('href', '/dashboard')
    for (const id of ['how-it-works', 'faq', 'pilot']) expect(document.getElementById(id)).not.toBeNull()
  })

  it('problem section uses the new heading and body', () => {
    home()
    expect(screen.getByRole('heading', { name: 'You see the order, not the authorization.' })).toBeInTheDocument()
    expect(screen.getByText(/it's he-said-she-said, and you lose\./)).toBeInTheDocument()
  })

  it('What we do for you: three cards in order, the third is "Improve it" (no "Fix it")', () => {
    home()
    const titles = ['Catch it before you ship', 'Prove it if it disputes anyway', 'Improve it']
    const found = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    const idx = titles.map((t) => found.indexOf(t))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(screen.queryByText(/Fix & optimize/i)).not.toBeInTheDocument()
    expect(screen.getByText(/The agent audits your listings/)).toBeInTheDocument()
  })

  it('How it works: three steps once, no tables, and the signal note', () => {
    home()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Grant\.\s*Action\.\s*Verdict\./ })).toBeInTheDocument()
    for (const line of ['What the customer told the agent', 'What the agent actually ordered', 'Ship, Review required or Hold decision']) {
      expect(screen.getAllByText(line)).toHaveLength(1)
    }
    expect(screen.queryByText('Customer authorizes, as fields, hash-sealed')).not.toBeInTheDocument()
    expect(screen.getByText(/returns a signal, it does not block checkout itself/)).toBeInTheDocument()
  })

  it('Products block on the home page lists exactly 3 tools, each linking to the Products page', () => {
    home()
    const section = document.getElementById('products') as HTMLElement
    const tools = within(section).getAllByRole('heading', { level: 3 })
    expect(tools.map((t) => t.textContent)).toEqual(['Agent Receipt', 'Evidence Packet', 'Listing Optimizer + Read as Agent'])
    expect(within(section).getByRole('link', { name: 'Agent Receipt' })).toHaveAttribute('href', '/products#order-check')
  })

  it('FAQ: all 7 questions are visible with answers collapsed; opening one shows its answer', async () => {
    const user = userEvent.setup()
    home()
    const qs = content.faq.items.map((i) => i.q)
    expect(qs).toHaveLength(7)
    for (const q of qs) expect(screen.getByRole('button', { name: q })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Those errors become the merchant's chargebacks/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Can agents make errors?' }))
    expect(screen.getByText(/Those errors become the merchant's chargebacks and returns/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'What are the products / features offered?' }))
    expect(screen.getAllByRole('link', { name: /Details → Products page/ })).toHaveLength(3)
    expect(screen.queryByText(/What do I actually do when an order is flagged/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Pilot offer/)).not.toBeInTheDocument()
  })

  it('footer links are LinkedIn, Dashboard and Store, and there is no GitHub link', () => {
    home()
    const foot = screen.getByRole('navigation', { name: 'Footer' })
    expect(within(foot).getAllByRole('link').map((a) => a.textContent)).toEqual(['LinkedIn', 'Dashboard', 'Store'])
    expect(within(foot).getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', 'https://www.linkedin.com/in/snehatiwari02')
    expect(within(foot).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard')
    expect(within(foot).getByRole('link', { name: 'Store' })).toHaveAttribute('href', '/shop')
    expect(screen.queryByText(/github/i)).not.toBeInTheDocument()
    expect(screen.getByText('Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent.')).toBeInTheDocument()
  })

  it('the pilot form has the specified fields and saves one row to pilot_requests', async () => {
    const user = userEvent.setup()
    home()
    expect(screen.getByRole('combobox', { name: 'I want to' })).toHaveTextContent('Join a pilotStay in the loop')
    await user.type(screen.getByLabelText('Name'), 'Test Person')
    await user.type(screen.getByLabelText('Work email'), 'test@example.com')
    await user.type(screen.getByLabelText('Company / Store name'), 'Example Store')
    await user.click(screen.getByRole('button', { name: /Submit/ }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(content.pilot.success))
    expect(insert).toHaveBeenCalledWith('pilot_requests', {
      name: 'Test Person', work_email: 'test@example.com', company: 'Example Store', store_url: null, interest: 'Join a pilot', message: null,
    })
  })

  it('shows an error, not a thank-you, when saving fails; ignores the hidden trap field', async () => {
    const user = userEvent.setup()
    insert.mockResolvedValue({ error: { message: 'nope' } })
    home()
    await user.type(screen.getByLabelText('Name'), 'A')
    await user.type(screen.getByLabelText('Work email'), 'a@b.co')
    await user.type(screen.getByLabelText('Company / Store name'), 'C')
    await user.click(screen.getByRole('button', { name: /Submit/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(content.pilot.error)
    insert.mockClear()
    await user.type(screen.getByLabelText(/Leave this empty/), 'spam')
    await user.click(screen.getByRole('button', { name: /Submit/ }))
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('Products page', () => {
  it('has exactly three products with two paragraphs each', () => {
    const { container } = products()
    const sections = container.querySelectorAll('section.prod')
    expect(sections).toHaveLength(3)
    expect([...sections].map((s) => s.querySelector('h2')?.textContent)).toEqual(['Agent Receipt', 'Evidence Packet', 'Listing Optimizer + Read as Agent'])
    for (const s of sections) expect(s.querySelectorAll('p.para')).toHaveLength(2)
    expect(screen.getByText(/This is the checkpoint merchants are missing today/)).toBeInTheDocument()
    expect(screen.getByText(/never auto-edits a product page, price, or terms/)).toBeInTheDocument()
  })

  it('header links back to the home sections and the footer has no GitHub', () => {
    products()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '/#faq')
    expect(within(nav).getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products')
    expect(screen.queryByText(/github/i)).not.toBeInTheDocument()
  })
})

describe('Copy rules', () => {
  it('no blockchain wording, no real-payment claims, no "nobody records intent"', () => {
    const all = JSON.stringify(content)
    expect(all).not.toMatch(/blockchain|ledger|crypto|(?<!no )real payment|nobody records/i)
  })
})
