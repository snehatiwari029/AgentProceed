import { useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Login from './Login'
import { AgentProceedLogo } from '../shared/brand/Logo'
import Home from './pages/Home'
import AgentOrders from './pages/AgentOrders'
import Disputes from './pages/Disputes'
import Optimization from './pages/Optimization'
import AgentActivity from './pages/AgentActivity'
import Tour, { TourOffer } from './Tour'
import { clearTourOffer, isSignedIn, peekTourOffer, signIn, signOut } from './session'

// Four items. Agent activity is embedded on the Dashboard home; /dashboard/activity stays reachable by URL only.
const NAV = [
  { to: '/dashboard', label: 'Dashboard', end: true },
  { to: '/dashboard/orders', label: 'Agent Receipt', end: false },
  { to: '/dashboard/disputes', label: 'Agent Dispute', end: false },
  { to: '/dashboard/optimization', label: 'Agent Optimize', end: false },
]

// The current page's title, shown in the header beside the logo.
export function pageTitle(pathname: string): string {
  const seg = pathname.replace(/^\/dashboard\/?/, '').split('/')[0]
  if (seg === 'orders') return 'Agent Receipt'
  if (seg === 'disputes') return 'Agent Dispute'
  if (seg === 'optimization' || seg === 'optimize') return 'Agent Optimize'
  if (seg === 'activity') return 'Agent activity'
  return 'Dashboard'
}

// The merchant dashboard. Dark theme only. It reaches the store through an internal route.
export default function DashboardApp() {
  const [signedIn, setSignedIn] = useState(isSignedIn)
  // Offered once, only after the B2B site's phone flow; a direct login gets the Start tour button instead.
  const [offer, setOffer] = useState(peekTourOffer)
  const [tour, setTour] = useState<{ fromPhone: boolean; landing: string } | null>(null)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  if (!signedIn) {
    return (
      <Login
        onSignIn={() => {
          signIn()
          setSignedIn(true)
        }}
      />
    )
  }

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-gradient-to-b from-dash-page-top to-dash-page-bottom text-dash-body">
      <div aria-hidden="true" className="dash-glow left-[-10rem] top-[-8rem] h-[28rem] w-[28rem] bg-dash-purple/45" />
      <div aria-hidden="true" className="dash-glow bottom-[-10rem] right-[-8rem] h-[26rem] w-[26rem] bg-dash-teal/20" />

      <header className="relative z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-dash-edge px-4 py-3 md:px-6" data-testid="dash-header">
        <Link to="/dashboard" aria-label="Agent Proceed, Dashboard home"><AgentProceedLogo variant="dark" size={28} /></Link>
        <span aria-hidden="true" className="h-6 w-px bg-dash-edge" />
        <p className="text-lg font-semibold text-dash-ink" data-testid="page-title">{pageTitle(pathname)}</p>
        <p className="ml-auto text-xs text-dash-label">Northwind Outfitters</p>
      </header>

      <div className="relative z-10 md:flex">
      <aside className="p-4 md:min-h-[calc(100vh-57px)] md:w-56">
        <div className="dash-glass rounded-2xl p-3">
        <button
          type="button"
          onClick={() => setTour({ fromPhone: false, landing: pathname })}
          disabled={tour !== null}
          className="w-full rounded-full bg-dash-teal px-3 py-2 text-sm font-bold text-dash-page-bottom hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start tour
        </button>
        <nav aria-label="Dashboard" className="mt-3 flex flex-wrap gap-1 md:flex-col">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-xl px-3 py-2 text-sm font-semibold ${
                  isActive ? 'bg-dash-purple text-dash-ink' : 'text-dash-body hover:bg-dash-card-raised'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-3 flex flex-wrap gap-1 border-t border-dash-edge pt-3 md:flex-col">
          <Link to="/shop" className="rounded-xl px-3 py-2 text-sm font-semibold text-dash-teal hover:bg-dash-card-raised">
            View Store
          </Link>
          <button
            type="button"
            onClick={() => {
              signOut()
              setSignedIn(false)
            }}
            className="rounded-xl px-3 py-2 text-left text-sm font-semibold text-dash-body hover:bg-dash-card-raised"
          >
            Sign out
          </button>
        </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-6 md:pl-2">
        <Routes>
          <Route index element={<Home />} />
          <Route path="orders" element={<AgentOrders />} />
          <Route path="activity" element={<AgentActivity />} />
          <Route path="disputes" element={<Disputes />} />
          <Route path="optimization" element={<Optimization />} />
          <Route path="optimize" element={<Optimization />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      </div>

      {offer && (
        <TourOffer
          onTour={() => {
            clearTourOffer()
            setOffer(null)
            setTour({ fromPhone: true, landing: offer })
          }}
          onExplore={() => {
            clearTourOffer()
            setOffer(null)
            navigate(offer)
          }}
        />
      )}
      {tour && <Tour fromPhone={tour.fromPhone} landing={tour.landing} onDone={() => setTour(null)} />}
    </div>
  )
}
