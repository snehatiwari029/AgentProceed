import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { content as c } from './content'
import { Arrow } from './icons'
import { SiteFooter, SiteHeader } from './Chrome'
import './site.css'

// /products: exactly three products, two paragraphs each. Words: content.ts → products.
export default function ProductsPage() {
  const p = c.products
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView()
    else window.scrollTo(0, 0)
  }, [])
  return (
    <div className="site">
      <SiteHeader onHome={false} />
      <main>
        <section className="page-head">
          <div className="wrap">
            <p className="eyebrow">{p.eyebrow}</p>
            <h1>{p.headline}</h1>
            <p className="lede">{p.intro}</p>
          </div>
        </section>
        {p.items.map((it) => (
          <section className="prod" id={it.id} key={it.id} aria-labelledby={`${it.id}-h`}>
            <div className="wrap prod-grid">
              <div>
                <p className="eyebrow">{it.short}</p>
                <h2 id={`${it.id}-h`}>{it.title}</h2>
              </div>
              <div>{it.paras.map((t) => <p className="para" key={t}>{t}</p>)}</div>
            </div>
          </section>
        ))}
        <section className="prod-cta">
          <div className="wrap">
            <div>
              <h2>{p.ctaTitle}</h2>
              <Link className="btn" to="/#pilot">{p.ctaLabel} <Arrow /></Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
