import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { content as c } from './content'
import { Arrow, Fingerprint, iconFor } from './icons'
import HeroScene from './HeroScene'
import { SiteFooter, SiteHeader } from './Chrome'
import PilotForm from './PilotForm'
import './site.css'

function Tag({ t }: { t: { merchant: string; outcome: string; tone: 'good' | 'bad' } }) {
  return <div className={`tag ${t.tone}`}><small>{t.merchant}</small><b>{t.outcome}</b></div>
}

function Receipt() {
  const k = c.hero.card
  const Row = ({ r }: { r: { label: string; value: string; flag: boolean } }) => (
    <div className={`rrow${r.flag ? ' flag' : ''}`}><span>{r.label}</span><b>{r.value}</b></div>
  )
  return (
    <div className="card-stage">
      <div className="card-ring" aria-hidden="true" />
      {c.hero.tags.filter((t) => t.tone === 'bad').map((t) => <Tag key={t.merchant} t={t} />)}
      <div className="rcard" role="img" aria-label="Sample receipt: customer authorized $180 maximum, agent ordered $212.40 with expedited delivery, flagged Review required">
        <div className="rcard-top">
          <span className="rcard-order">{k.orderLabel} / {k.orderNumber}</span>
          <span className="badge">{k.badge}</span>
        </div>
        <h3>{k.grantTitle}</h3>
        {k.grantRows.map((r) => <Row key={r.label} r={r} />)}
        <h3>{k.actionTitle}</h3>
        {k.actionRows.map((r) => <Row key={r.label} r={r} />)}
        <div className="rcard-foot">
          <span>{k.footnote}</span>
          <span className="rcard-seal"><Fingerprint size={26} /></span>
        </div>
      </div>
      {c.hero.tags.filter((t) => t.tone === 'good').map((t) => <Tag key={t.merchant} t={t} />)}
      <span className="side-note">{k.sideNote}</span>
    </div>
  )
}

function Faq() {
  const [open, setOpen] = useState<number | null>(null) // all answers start collapsed
  return (
    <div className="acc">
      {c.faq.items.map((it, i) => {
        const isOpen = open === i
        return (
          <div className="acc-item" key={it.q}>
            <h3>
              <button className="acc-q" aria-expanded={isOpen} aria-controls={`faq-${i}`} onClick={() => setOpen(isOpen ? null : i)}>
                {it.q}<span className="acc-sign" aria-hidden="true">{isOpen ? '×' : '+'}</span>
              </button>
            </h3>
            {isOpen && (
              <div className="acc-a" id={`faq-${i}`}>
                {it.a.map((l) => (
                  <p key={l.t}>{l.t}{l.to && <Link to={l.to}>[{l.toLabel ?? 'Details'}]</Link>}</p>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// The public page. Words: content.ts. Look: site.css.
export default function LandingPage() {
  const h = c.hero
  // Arriving from another page with "/#faq": scroll once the sections exist.
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [])
  return (
    <div className="site">
      <SiteHeader onHome />

      <main id="top">
        <section className="hero">
          <div className="wrap hero-grid">
            <HeroScene label={h.sceneLabel} />
            <div>
              <p className="eyebrow">{h.eyebrow}</p>
              <h1>{h.headlineBefore}<em>{h.headlineEmphasis}</em>{h.headlineAfter}</h1>
              <p className="hero-body">{h.body}</p>
              <ul className="hero-tools" aria-label="Tools">
                {h.tools.map((t) => <li key={t.name}><Link to={t.to}>{t.name}</Link></li>)}
              </ul>
              <div className="hero-cta">
                <Link className="btn" to={c.nav.loginTo}>{h.primaryCta} <Arrow /></Link>
                <a className="link-btn" href={`#${c.steps.id}`}>{h.secondaryCta} <Arrow down /></a>
              </div>
            </div>
          </div>
        </section>

        <section className="gap" aria-labelledby="problem-h">
          <div className="wrap gap-grid">
            <div>
              <p className="eyebrow">{c.problem.eyebrow}</p>
              <h2 id="problem-h">{c.problem.headline}</h2>
              <p className="gap-body">{c.problem.body}</p>
            </div>
            <Receipt />
          </div>
        </section>

        <section className="partner" aria-labelledby="partner-h">
          <div className="wrap">
            <p className="eyebrow">{c.whatWeDo.eyebrow}</p>
            <h2 id="partner-h">{c.whatWeDo.headline}</h2>
            <div className="cols">
              {c.whatWeDo.cards.map((col) => (
                <div className={`col${col.image ? ' col-visual' : ''}`} key={col.tag} data-testid={`feature-${col.icon}`}>
                  <div className="col-text">
                    <span className="disc" aria-hidden="true">{iconFor(col.icon)}</span>
                    <p className="col-tag">{col.tag}</p>
                    <h3>{col.title}</h3>
                    <p>{col.body}</p>
                    {col.cta && <Link className="btn btn-sm feature-cta" to={col.cta.to}>{col.cta.label} <Arrow /></Link>}
                  </div>
                  {col.image && <img className="feature-shot" src={col.image.src} alt={col.image.alt} loading="lazy" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="steps" id={c.steps.id} aria-labelledby="steps-h">
          <div className="wrap steps-grid">
            <div>
              <p className="eyebrow">{c.steps.eyebrow}</p>
              <h2 id="steps-h">
                {c.steps.headlineLines.map((l) => <span key={l} style={{ display: 'block' }}>{l}</span>)}
                <em>{c.steps.headlineEmphasis}</em>
              </h2>
            </div>
            <div>
              <div className="step-list">
                {c.steps.items.map((s) => (
                  <div className="step" key={s.num}>
                    <span className="step-num">{s.num}</span>
                    <p className="step-line">{s.text}</p>
                    <span className="step-ico">{iconFor(s.icon)}</span>
                  </div>
                ))}
              </div>
              <p className="step-note">{c.steps.note}</p>
            </div>
          </div>
        </section>

        <section className="products" id={c.productsHome.id} aria-labelledby="products-h">
          <div className="wrap">
            <p className="eyebrow">{c.productsHome.eyebrow}</p>
            <h2 id="products-h">{c.productsHome.headline}</h2>
            <div className="pcols">
              {c.products.items.map((p) => (
                <div className="pcol" key={p.id}>
                  <span className="disc" aria-hidden="true">{iconFor(p.icon)}</span>
                  <h3><Link to={`/products#${p.id}`}>{p.title}</Link></h3>
                  <p>{p.short}</p>
                </div>
              ))}
            </div>
            <Link className="more-link" to={c.productsHome.moreTo}>{c.productsHome.moreLabel} <Arrow /></Link>
          </div>
        </section>

        <section className="faq" id={c.faq.id} aria-labelledby="faq-h">
          <div className="wrap faq-grid">
            <div>
              <p className="eyebrow">{c.faq.eyebrow}</p>
              <h2 id="faq-h">{c.faq.headline}</h2>
              <p className="faq-sub">{c.faq.body}</p>
            </div>
            <Faq />
          </div>
        </section>

        <section className="pilot" id={c.pilot.id} aria-labelledby="pilot-h">
          <div className="wrap pilot-grid">
            <div>
              <p className="eyebrow">{c.pilot.eyebrow}</p>
              <h2 id="pilot-h">{c.pilot.headline}</h2>
              <p className="pilot-sub">{c.pilot.body}</p>
              <p className="pilot-foot mono-foot">{c.pilot.footLabel}</p>
            </div>
            <PilotForm />
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
