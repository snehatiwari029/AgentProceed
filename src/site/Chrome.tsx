import { Link } from 'react-router-dom'
import { content as c } from './content'
import { Arrow } from './icons'
import { AgentProceedLogo } from '../shared/brand/Logo'
import './site.css'

// Header and footer shared by the home page and the Products page.
// On the home page the section links jump within the page; elsewhere they go to "/#section".
export function SiteHeader({ onHome }: { onHome: boolean }) {
  return (
    <header className="header">
      <div className="header-in">
        <Link className="logo" to="/" aria-label={`${c.brand} home`}><AgentProceedLogo variant="light" size={34} /></Link>
        <nav className="nav" aria-label="Main">
          {c.nav.links.map((l) =>
            l.to ? <Link key={l.label} className="nav-link" to={l.to}>{l.label}</Link>
              : <a key={l.label} className="nav-link" href={`${onHome ? '' : '/'}#${l.hash}`}>{l.label}</a>)}
          <Link className="btn btn-sm" to={c.nav.loginTo}>{c.nav.loginLabel} <Arrow /></Link>
        </nav>
      </div>
    </header>
  )
}

export function SiteFooter() {
  const f = c.footer
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-row">
          <p>{f.line}</p>
          <nav className="footer-links" aria-label="Footer">
            {f.links.map((l) => l.external
              ? <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
              : <Link key={l.label} to={l.href}>{l.label}</Link>)}
          </nav>
        </div>
        <p>{f.note}</p>
      </div>
    </footer>
  )
}
