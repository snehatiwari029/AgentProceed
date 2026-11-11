import { formatMoney } from '../shared/format'
import type { OfferCardData, OrderData, PaymentState } from './types'

export function Bubble({ side, children }: { side: 'me' | 'muse'; children: string }) {
  const me = side === 'me'
  return (
    <div className={`flex ${me ? 'justify-end' : 'justify-start'}`}>
      <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-snug ${me ? 'rounded-br-md bg-indigo-600 text-white' : 'rounded-bl-md bg-neutral-100 text-neutral-900'}`}>
        {children}
      </p>
    </div>
  )
}

export function StatusLine({ children }: { children: string }) {
  return <p className="px-1 text-xs italic text-neutral-500">{children}</p>
}

export function OfferCard({ offer, onPick, disabled, picked = false }: { offer: OfferCardData; onPick: () => void; disabled: boolean; picked?: boolean }) {
  return (
    <section aria-label={offer.name} className="rounded-2xl border border-neutral-200 bg-white p-3.5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{offer.brand}</p>
      <h2 className="text-sm font-bold text-neutral-900">{offer.name}</h2>
      <p className="mt-0.5 text-xs text-neutral-600">{offer.size_cm} cm{offer.colour ? ` · ${offer.colour}` : ''}</p>
      <p className="mt-2 text-lg font-extrabold text-neutral-900">{formatMoney(offer.price_cents)}</p>
      <p className="text-sm text-neutral-800">{offer.summary}</p>
      <p className="text-sm text-neutral-600">Arrives {offer.delivery_label}</p>
      <button type="button" disabled={disabled} onClick={onPick} className="mt-3 w-full rounded-xl bg-indigo-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {picked ? 'Picked' : 'Pick this one'}
      </button>
    </section>
  )
}

export function OrderCard({ order, number = null, payment = { status: 'idle' }, onPay }: {
  order: OrderData
  number?: string | 'pending' | 'late' | null
  payment?: PaymentState
  onPay?: () => void
}) {
  const rows: [string, string][] = [
    ['Item', formatMoney(order.item_price_cents)],
    [order.shipping_label, order.shipping_cents === 0 ? 'Free' : formatMoney(order.shipping_cents)],
  ]
  // A PayPal order is waiting on the shopper until PayPal captures the payment: it reads "Ready to pay" until then.
  const awaitingPay = !!order.pay && payment.status !== 'captured'
  return (
    <section aria-label="Order confirmation" className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3.5">
      <h2 className="text-sm font-bold text-emerald-900">{awaitingPay ? 'Ready to pay' : 'Order received'}</h2>
      {number && !awaitingPay && (
        <p className="mt-1 text-sm text-neutral-900" data-testid="order-number" role="status">
          {number === 'pending' ? <span className="text-neutral-600">Getting your order number…</span>
            : number === 'late' ? <span className="text-neutral-600">Your order number is still being assigned. The store has your order.</span>
              : <>Order number <b className="font-mono">{number}</b> <span className="text-xs text-neutral-500">· keep it to follow up</span></>}
        </p>
      )}
      <p className="mt-1 text-sm font-semibold text-neutral-900">{order.brand ? `${order.brand} ` : ''}{order.product_name}</p>
      <p className="text-xs text-neutral-600">{order.size_cm} cm{order.colour ? ` · ${order.colour}` : ''}</p>
      <dl className="mt-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-0.5"><dt className="text-neutral-600">{k}</dt><dd className="text-neutral-900">{v}</dd></div>
        ))}
        <div className="flex justify-between border-t border-emerald-200 py-1 font-bold"><dt>Total</dt><dd>{formatMoney(order.total_cents)}</dd></div>
      </dl>
      <p className="text-sm text-neutral-700">Arrives {order.delivery_label}</p>
      {order.pay ? <PayPalStatus payment={payment} onPay={onPay} /> : <p className="text-xs text-neutral-500">Paid with {order.payment_label}. Simulated, no real payment.</p>}
      <p className="text-xs text-neutral-500">Northwind confirms your order before it ships.</p>
    </section>
  )
}

// The PayPal Sandbox step on the order card. Test money only; the store charges the total shown above.
export function PayPalStatus({ payment, onPay }: { payment: PaymentState; onPay?: () => void }) {
  if (payment.status === 'captured') {
    return (
      <p className="mt-1 text-sm text-emerald-900" data-testid="paypal-status" role="status">
        Paid with PayPal Sandbox (test money).
        {payment.capture_id && <span className="block text-xs text-neutral-600">PayPal transaction <b className="font-mono">{payment.capture_id}</b></span>}
      </p>
    )
  }
  const note = payment.status === 'failed' || payment.status === 'cancelled' ? payment.message : null
  return (
    <div className="mt-2 space-y-1" data-testid="paypal-status">
      {note && <p role="alert" className="text-xs text-amber-900">{note}</p>}
      <button
        type="button"
        onClick={onPay}
        disabled={!onPay || payment.status === 'working'}
        className="w-full rounded-xl bg-[#ffc439] py-2 text-sm font-bold text-[#003087] disabled:opacity-60"
      >
        {payment.status === 'working' ? 'Opening PayPal…' : note ? 'Try PayPal again' : 'Pay with PayPal'}
      </button>
      <p className="text-[11px] text-neutral-500">PayPal Sandbox, test money only. Sign in with a PayPal Sandbox test buyer.</p>
    </div>
  )
}
