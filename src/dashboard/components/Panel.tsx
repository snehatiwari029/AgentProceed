import type { ReactNode } from 'react'
import type { Rows } from '../data'

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold text-dash-ink">{title}</h1>
      {children && <p className="mt-2 max-w-2xl text-sm text-dash-body">{children}</p>}
    </header>
  )
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section className="dash-glass rounded-2xl p-5" aria-label={label}>
      {children}
    </section>
  )
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="dash-glass rounded-2xl p-6">
      <p className="font-semibold text-dash-ink">{title}</p>
      <p className="mt-2 max-w-xl text-sm text-dash-body">{children}</p>
    </div>
  )
}

// Shows loading and error states; calls render only when the read succeeded.
export function Live<T>({ state, children }: { state: Rows<T>; children: (rows: T[]) => ReactNode }) {
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-dash-body">
        Loading…
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="dash-glass rounded-2xl border-dash-violation p-5">
        <p className="font-semibold text-dash-ink">Could not load this data.</p>
        <p className="mt-2 break-words text-sm text-dash-violation">{state.message}</p>
      </div>
    )
  }
  return <>{children(state.rows)}</>
}
