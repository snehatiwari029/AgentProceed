import type { DisputeEvent, DisputeEventType } from '../shared/schemas'

// Every entry is a merchant action or record. None is an AgentReceipt recommendation.
export const DISPUTE_STATUS: Record<DisputeEventType, string> = {
  opened: 'Dispute received',
  recommendation: 'Earlier entry (not shown)', // written before the Dispute Agent build; never shown
  conceded: 'Conceded (merchant decision)',
  represented: 'Fought (submitted to acquirer)',
  pack_generated: 'Evidence Packet generated',
  outcome_won: 'Won',
  outcome_lost: 'Lost',
  pack_downloaded: 'Pack downloaded by merchant',
  investigating: 'Investigating (merchant action)',
  outcome_pending: 'Outcome pending',
  outcome_conceded: 'Outcome: Conceded',
  merchant_note: 'Dispute-time merchant note',
}

// Entries from before this build that carried an AgentReceipt recommendation are not shown anywhere.
export const shownEvents = (events: DisputeEvent[]) => events.filter((e) => e.event_type !== 'recommendation')

// A dispute's status is its latest shown event (events are in chain order).
export function disputeStatus(events: DisputeEvent[]): string {
  const shown = shownEvents(events).filter((e) => e.event_type !== 'merchant_note')
  return shown.length === 0 ? DISPUTE_STATUS.opened : DISPUTE_STATUS[shown[shown.length - 1].event_type]
}

const OUTCOME: Partial<Record<DisputeEventType, string>> = {
  outcome_won: 'Outcome: Won', outcome_lost: 'Outcome: Lost', outcome_conceded: 'Outcome: Conceded', outcome_pending: 'Outcome: Pending',
}

// Pack status, from the merchant's own records: Not generated / Ready to view / Downloaded by merchant /
// Submitted by merchant (merchant-reported) / Outcome. Download never marks a pack as submitted.
export function packStatus(events: DisputeEvent[]): string {
  const shown = shownEvents(events)
  const outcome = [...shown].reverse().find((e) => OUTCOME[e.event_type])
  if (outcome) return OUTCOME[outcome.event_type] as string
  if (shown.some((e) => e.event_type === 'represented')) return 'Submitted by merchant (merchant-reported)'
  if (shown.some((e) => e.event_type === 'pack_downloaded')) return 'Downloaded by merchant'
  if (shown.some((e) => e.event_type === 'pack_generated')) return 'Ready to view'
  return 'Not generated'
}

export const PACK_STATUSES = ['Not generated', 'Ready to view', 'Downloaded by merchant', 'Submitted by merchant (merchant-reported)', 'Outcome: Won', 'Outcome: Lost', 'Outcome: Conceded', 'Outcome: Pending']
