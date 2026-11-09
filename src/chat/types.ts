// What the phone screen receives from the shopper-agent function. Display data only: the screen makes no decisions.
export type OfferCardData = {
  product_id: string
  name: string
  brand: string | null
  size_cm: number
  colour: string | null
  price_cents: number
  summary: string
  delivery_label: string
}

export type OrderData = {
  product_name: string
  brand: string | null
  size_cm: number
  colour: string | null
  item_price_cents: number
  shipping_label: string
  shipping_cents: number
  total_cents: number
  delivery_label: string
  payment_label: string
  // Present only when the order is paid through PayPal Sandbox (test money).
  pay?: { provider: 'paypal'; environment: 'sandbox' }
}

// Where the PayPal Sandbox payment for this order stands, as the shopper-agent function reports it.
export type PaymentState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'approval_needed'; approve_url: string }
  | { status: 'captured'; capture_id: string | null; paypal_order_id: string | null }
  | { status: 'failed'; message: string }
  | { status: 'cancelled'; message: string }

export type PaymentReply =
  | { type: 'payment'; session_id: string; status: 'approval_needed' | 'captured' | 'failed' | 'cancelled'; approve_url?: string; paypal_order_id?: string; capture_id?: string; amount_cents?: number; message?: string }
  | { type: 'error'; message: string }

// Tap-to-send prompts Muse offers (e.g. the two demo orders after an off-topic message).
export type Suggestion = { label: string; text: string }

export type AgentReply = { session_id?: string; steps?: string[]; draft?: unknown; ask_payment?: boolean; suggestions?: Suggestion[] } & (
  | { type: 'message'; text: string }
  | { type: 'proposals'; text: string; follow_up: string; offers: (OfferCardData & Record<string, unknown>)[] }
  | { type: 'ordered'; text: string; order: OrderData }
  | { type: 'error'; message: string }
)

// Everything shown in the conversation, in order.
export type ChatItem =
  | { id: number; kind: 'me'; text: string }
  | { id: number; kind: 'muse'; text: string }
  | { id: number; kind: 'status'; text: string }
  | { id: number; kind: 'offers'; offers: (OfferCardData & Record<string, unknown>)[] }
  | { id: number; kind: 'order'; order: OrderData }
  | { id: number; kind: 'problem'; text: string }
  | { id: number; kind: 'suggest'; suggestions: Suggestion[] }
