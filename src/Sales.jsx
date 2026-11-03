import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { n0, dateLabel, usd, graderColor, SALE_TYPE } from './format.js'
import { Section, Hero, downloadCsv } from './ui.jsx'
import { GRADERS, GRADE_LABELS, SUBMIT_TYPES } from '../worker/sales_common.js'

const trusted = s => s.source !== 'collector' || s.verified === 1

export function SourceBadge({ s }) {
  const [text, cls] = s.source === 'ebay' ? ['eBay', 'ebay']
    : s.source === 'taclaco' ? ['Taclaco', 'taclaco']
    : s.verified ? ['Collector verified', 'collector'] : ['Collector unverified', 'unverified']
  return <span className={'sbadge ' + cls} title={cls === 'unverified' ? 'Sent in by a collector and not yet verified by Taclaco. Left out of median prices.' : undefined}>{text}</span>
}

function SaleLink({ s }) {
  if (!s.url) return <span className="dash">·</span>
  return <a className="plainlink" href={s.url} target="_blank" rel="nofollow ugc noopener noreferrer" onClick={e => e.stopPropagation()}>{s.source === 'collector' ? 'Proof' : 'eBay'}</a>
}

const Ship = ({ s }) => (s.shipping_cents > 0 ? <span className="ship">+{usd(s.shipping_cents)} ship</span> : null)

const Price = ({ s }) => (
  <>
    <span className="strong tabnum">{usd(s.price_cents)}</span>
    {s.best_offer ? <span className="mini-tag" title="Accepted best offer"> Best offer</span> : null}
    <Ship s={s} />
  </>
)

const gradeText = s => `${s.grader} ${s.grade_label}`

// ---------- Sales tab ----------
export function SalesPage({ sets, stream, onOpen, onSubmit }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [setId, setSetId] = useState('')
  const [grader, setGrader] = useState('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { api.sales().then(setData).catch(e => setErr(e.message)) }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    return data.sales.filter(s => {
      if (stream && !trusted(s)) return false
      if (setId && !sets.some(x => String(x.id) === setId && x.name === s.set_name)) return false
      if (grader && s.grader !== grader) return false
      if (source === 'collector_verified' ? !(s.source === 'collector' && s.verified) : source === 'collector_unverified' ? !(s.source === 'collector' && !s.verified) : source && s.source !== source) return false
      if (needle && !`${s.name} ${s.number} ${s.variant} ${s.set_name} ${s.grader} ${s.grade_label}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [data, stream, sets, setId, grader, source, q])

  if (err) return <p className="error">Could not load sales: {err}</p>
  if (!data) return <p className="note">Loading...</p>
  const sum = data.summary
  const top = sum.top[0]
  const tracked = stream ? sum.trusted_count : sum.count
  const recent = stream ? sum.trusted_count_90 : sum.count_90
  const empty = sum.count === 0

  const cardCell = s => (
    <button className="linkish" onClick={() => onOpen(s.card_id)}>
      <span className="strong">{s.name}</span>
      <span className="muted"> #{s.number} {s.variant} · {s.set_name}</span>
    </button>
  )
  const topList = (
    <Section title="Top sales" hint="Highest prices in the last 12 months. Unverified collector sales are not ranked.">
      <ul className="rare-list">
        {sum.top.length ? sum.top.map(s => (
          <li key={s.id}>
            {stream ? <span><span className="strong">{s.name}</span><span className="muted"> {s.variant}</span></span> : cardCell(s)}
            <span className="rare-right"><span className="sale-price tabnum">{usd(s.price_cents)}</span> · {gradeText(s)} · {dateLabel(s.sale_date)}{stream && <> <SourceBadge s={s} /></>}</span>
          </li>
        )) : <li className="muted">No sales in the last 12 months.</li>}
      </ul>
    </Section>
  )

  const download = () => downloadCsv(`life-tcg-sales-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Date', 'Set', 'Number', 'Card', 'Variant', 'Grader', 'Grade', 'Price USD', 'Shipping USD', 'Best offer', 'Source', 'Verified', 'Link'],
    ...rows.map(s => [s.sale_date, s.set_name, s.number, s.name, s.variant, s.grader, s.grade_label, (s.price_cents / 100).toFixed(2),
      s.shipping_cents == null ? '' : (s.shipping_cents / 100).toFixed(2), s.best_offer ? 'yes' : '', s.source, s.verified ? 'yes' : 'no', s.url || '']),
  ])

  return (
    <>
      <div className="hero sales-hero">
        <Hero label="Sales tracked" value={n0(tracked)} sub="graded LIFE TCG sales" />
        <Hero label="Last 90 days" value={n0(recent)} sub="sales" />
        <Hero label="Highest sale" value={top ? usd(top.price_cents) : 'n/a'} sub={top ? `${top.name} ${gradeText(top)}` : 'in the last 12 months'} />
      </div>

      {!stream && (
        <section className="card sales-intro">
          <div>
            <p>eBay sold prices for graded LIFE TCG cards, updated weekly, plus private sales sent in by collectors. Collector sales are checked by Taclaco before they appear; unverified ones are labeled and left out of median prices.</p>
            <p>Prices are what the card sold for, before shipping and tax.</p>
            {sum.updated_at && <p className="updated">eBay sales updated {dateLabel(sum.updated_at.slice(0, 10))}</p>}
          </div>
          <button className="more inline" onClick={() => onSubmit(null)}>Submit a sale</button>
        </section>
      )}

      {empty ? (
        <Section title="Recent sales"><p className="empty-state">No sales yet. The first eBay pull runs on Monday.{!stream && ' Sold one yourself? Use Submit a sale.'}</p></Section>
      ) : stream ? (
        <>
          <Section title="Latest sales">
            <ul className="rare-list big">
              {rows.slice(0, 10).map(s => (
                <li key={s.id}>
                  <span><span className="strong">{s.name}</span><span className="muted"> {s.variant} · {gradeText(s)}</span></span>
                  <span className="rare-right"><span className="sale-price tabnum">{usd(s.price_cents)}</span> · {dateLabel(s.sale_date)} <SourceBadge s={s} /></span>
                </li>
              ))}
            </ul>
          </Section>
          {topList}
        </>
      ) : (
        <>
          <Section title="Recent sales" hint="Newest first. Click a card for its pop and price history.">
            <div className="filters">
              <input type="search" placeholder="Search cards" value={q} onChange={e => setQ(e.target.value)} aria-label="Search sales" />
              <select value={setId} onChange={e => setSetId(e.target.value)} aria-label="Filter by set">
                <option value="">All sets</option>
                {sets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select value={grader} onChange={e => setGrader(e.target.value)} aria-label="Filter by grader">
                <option value="">All graders</option>
                {GRADERS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={source} onChange={e => setSource(e.target.value)} aria-label="Filter by source">
                <option value="">All sources</option>
                <option value="ebay">eBay</option>
                <option value="taclaco">Taclaco</option>
                <option value="collector_verified">Collector verified</option>
                <option value="collector_unverified">Collector unverified</option>
              </select>
              <span className="count">{n0(rows.length)} sales</span>
              <button className="more inline" onClick={download} disabled={!rows.length}>Download CSV</button>
            </div>
            <div className="table-wrap sales-table">
              <table className="data">
                <thead><tr><th>Date</th><th>Card</th><th>Grade</th><th className="num">Price</th><th>Source</th><th>Link</th></tr></thead>
                <tbody>
                  {rows.slice(0, 500).map(s => (
                    <tr key={s.id}>
                      <td>{dateLabel(s.sale_date)}</td>
                      <td className="card-cell sale-card">{cardCell(s)}</td>
                      <td><i className="dot-i" style={{ background: graderColor(s.grader) }} />{gradeText(s)}</td>
                      <td className="num" title={[SALE_TYPE[s.sale_type], s.shipping_cents != null ? `${usd(s.shipping_cents)} shipping` : null].filter(Boolean).join(', ')}><Price s={s} /></td>
                      <td><SourceBadge s={s} /></td>
                      <td><SaleLink s={s} /></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={6} className="empty">No sales match.</td></tr>}
                </tbody>
              </table>
            </div>
            <ul className="sale-stack">
              {rows.slice(0, 500).map(s => (
                <li key={s.id}>
                  {cardCell(s)}
                  <div className="sale-line">
                    <span><i className="dot-i" style={{ background: graderColor(s.grader) }} />{gradeText(s)}</span>
                    <span><Price s={s} /></span>
                    <span className="muted">{dateLabel(s.sale_date)}</span>
                    <SourceBadge s={s} />
                    <SaleLink s={s} />
                  </div>
                </li>
              ))}
              {rows.length === 0 && <li className="empty-state">No sales match.</li>}
            </ul>
            {rows.length > 500 && <p className="note">Showing the newest 500. Download the CSV for all {n0(rows.length)}.</p>}
          </Section>
          {topList}
        </>
      )}
    </>
  )
}

// ---------- card panel block ----------
export function CardSales({ sales, onSubmit }) {
  return (
    <>
      <h3 className="panel-sub">Sales</h3>
      {sales.medians.length > 0 ? (
        <table className="mini">
          <thead><tr><th>Grade</th><th className="num">Price</th><th className="num">Sales</th></tr></thead>
          <tbody>
            {sales.medians.map(m => (
              <tr key={m.grader + m.grade_label}><td><i className="dot-i" style={{ background: graderColor(m.grader) }} />{m.grader} {m.grade_label}</td><td className="num">{m.n >= 3
                ? <><span className="strong">{usd(m.median_cents)}</span><span className="row-label">median of {m.n}, 12 mo</span></>
                : <><span className="strong">{usd(m.last_cents ?? m.median_cents)}</span><span className="row-label">last sale{m.last_date ? ' ' + dateLabel(m.last_date) : ''}</span></>}</td><td className="num">{m.n}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="note">No verified sales in the last 12 months.</p>}
      {sales.latest.length > 0 && (
        <ul className="rare-list panel-sales">
          {sales.latest.map(s => (
            <li key={s.id}>
              <span>{gradeText(s)} <span className="muted">{dateLabel(s.sale_date)}</span><br /><SourceBadge s={s} /> <SaleLink s={s} /></span>
              <span className="rare-right"><Price s={s} /></span>
            </li>
          ))}
        </ul>
      )}
      <button className="more" onClick={onSubmit}>Submit a sale for this card</button>
    </>
  )
}

// ---------- submit form ----------
// Must match TURNSTILE_ACTION in worker/sales.js (siteverify returns it and the Worker checks it).
const TURNSTILE_ACTION = 'submit_sale'
let turnstileLoad
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  turnstileLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => resolve(window.turnstile)
    s.onerror = () => { turnstileLoad = null; reject(new Error('Could not load the human check.')) }
    document.head.appendChild(s)
  })
  return turnstileLoad
}

export function SubmitSale({ allCards, initialCardId, onClose }) {
  const [card, setCard] = useState(() => allCards.find(c => c.id === initialCardId) || null)
  const [search, setSearch] = useState('')
  const [grader, setGrader] = useState('PSA')
  const [grade, setGrade] = useState('')
  const [price, setPrice] = useState('')
  const [date, setDate] = useState('')
  const [type, setType] = useState('ebay')
  const [cert, setCert] = useState('')
  const [proof, setProof] = useState('')
  const [note, setNote] = useState('')
  const [token, setToken] = useState('')
  const [siteKey, setSiteKey] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const boxRef = useRef(null)
  const widget = useRef(null)

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { api.salesConfig().then(c => setSiteKey(c.turnstile_site_key || '')).catch(() => setSiteKey('')) }, [])
  useEffect(() => {
    if (!siteKey || !boxRef.current || done) return
    let gone = false
    loadTurnstile().then(t => {
      if (gone || !boxRef.current) return
      widget.current = t.render(boxRef.current, { sitekey: siteKey, action: TURNSTILE_ACTION, callback: setToken, 'expired-callback': () => setToken(''), 'error-callback': () => setToken('') })
    }).catch(e => setErr(e.message))
    return () => { gone = true; if (widget.current != null && window.turnstile) try { window.turnstile.remove(widget.current) } catch { /* already gone */ } widget.current = null }
  }, [siteKey, done])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return []
    return allCards.filter(c => `${c.name} ${c.number} ${c.variant} ${c.set_name}`.toLowerCase().includes(needle)).slice(0, 8)
  }, [allCards, search])

  const pickGrader = g => { setGrader(g); setGrade('') }
  const submit = async e => {
    e.preventDefault()
    setErr(null)
    if (!card) return setErr('Pick a card from the list.')
    if (!grade) return setErr('Pick a grade.')
    if (!token) return setErr('Please complete the human check.')
    setBusy(true)
    try {
      await api.submitSale({ card_id: card.id, grader, grade_label: grade, price, sale_date: date, sale_type: type, cert, proof_url: proof, note, turnstile_token: token })
      setDone(true)
    } catch (e2) {
      setErr(e2.message)
      setToken('')
      if (widget.current != null && window.turnstile) try { window.turnstile.reset(widget.current) } catch { /* ignore */ }
    } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Submit a sale" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h2 className="panel-title">Submit a sale</h2>
        {done ? (
          <>
            <p className="signup-thanks">Thanks. It will appear after review.</p>
            <button className="more" onClick={onClose}>Close</button>
          </>
        ) : (
          <form className="sale-form" onSubmit={submit}>
            <p className="hint">Sold or bought a graded LIFE TCG card? Tell us the price. Taclaco checks every submission before it is shown. No name or email is asked for.</p>
            <label>Card
              {card ? (
                <div className="picked"><span><span className="strong">{card.name}</span> <span className="muted">#{card.number} {card.variant} · {card.set_name}</span></span><button type="button" className="linkish" onClick={() => setCard(null)}>Change</button></div>
              ) : (
                <>
                  <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Type a name or number" autoComplete="off" />
                  {matches.length > 0 && (
                    <ul className="picker">
                      {matches.map(c => <li key={c.id}><button type="button" onClick={() => { setCard(c); setSearch('') }}><span className="strong">{c.name}</span> <span className="muted">#{c.number} {c.variant} · {c.set_name}</span></button></li>)}
                    </ul>
                  )}
                </>
              )}
            </label>
            <div className="form-row">
              <label>Grader
                <select value={grader} onChange={e => pickGrader(e.target.value)}>{GRADERS.map(g => <option key={g}>{g}</option>)}</select>
              </label>
              <label>Grade
                <select value={grade} onChange={e => setGrade(e.target.value)} required><option value="">Pick a grade</option>{GRADE_LABELS[grader].map(g => <option key={g}>{g}</option>)}</select>
              </label>
            </div>
            <div className="form-row">
              <label>Price (USD)
                <input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" required />
              </label>
              <label>Sale date
                <input type="date" value={date} onChange={e => setDate(e.target.value)} max={new Date().toISOString().slice(0, 10)} required />
              </label>
            </div>
            <label>Where it sold
              <select value={type} onChange={e => setType(e.target.value)}>{SUBMIT_TYPES.map(t => <option key={t} value={t}>{SALE_TYPE[t]}</option>)}</select>
            </label>
            <label>Cert number (optional, never shown publicly)
              <input inputMode="numeric" value={cert} onChange={e => setCert(e.target.value)} maxLength={12} />
            </label>
            <label>Proof link (optional)
              <input type="url" value={proof} onChange={e => setProof(e.target.value)} placeholder="https://" maxLength={300} />
            </label>
            <label>Note (optional)
              <input value={note} onChange={e => setNote(e.target.value)} maxLength={200} />
            </label>
            {siteKey === '' && <p className="note">Submissions are not open yet.</p>}
            <div ref={boxRef} className="turnstile" />
            {err && <p className="error" role="alert">{err}</p>}
            <button className="more" type="submit" disabled={busy || siteKey === ''}>{busy ? 'Sending...' : 'Submit sale'}</button>
          </form>
        )}
      </div>
    </div>
  )
}
