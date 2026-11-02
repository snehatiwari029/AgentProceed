import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { content as c } from './content'
import { Arrow } from './icons'
import { SiteFooter, SiteHeader } from './Chrome'
import './site.css'

// /hackathon: a demo launchpad for judges. Words: content.ts → hackathon. It only links to the existing demos.
export default function HackathonPage() {
  const h = c.hackathon
  useEffect(() => { window.scrollTo?.(0, 0) }, [])
  return (
    <div className="site">
      <SiteHeader onHome={false} />
      <main>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{h.eyebrow}</p>
            <h1>{h.headline}</h1>
            <p className="hack-tagline">{h.tagline}</p>
          </div>
        </section>

        <section className="hack-demos" aria-label="Demos">
          <div className="wrap">
            <div className="demo-grid">
              {h.demos.map((d) => (
                <Link key={d.to} className="demo-card" to={d.to} data-testid={`demo-${d.to.slice(1)}`}>
                  <span className="demo-path">{d.to}</span>
                  <h2>{d.title}</h2>
                  <p>{d.note}</p>
                  <span className="btn btn-sm demo-go">Open <Arrow /></span>
                </Link>
              ))}
            </div>
            <p className="hack-repo">
              <a className="link-btn" href={h.repoUrl} target="_blank" rel="noreferrer">{h.repoLabel} <Arrow /></a>
            </p>
          </div>
        </section>

        <section className="hack-try" aria-labelledby="try-h">
          <div className="wrap">
            <h2 id="try-h">{h.tryTitle}</h2>
            <ol className="try-list">
              {h.trySteps.map((s, i) => (
                <li key={s.title}>
                  <span className="disc" aria-hidden="true">{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
            <p className="hack-note">{h.note}</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
