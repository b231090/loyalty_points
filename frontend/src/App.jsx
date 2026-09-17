import { useEffect, useState } from 'react'
import './App.css'

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

async function request(path, options = {}, token) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || 'Something went wrong')
  return data
}

const formatPoints = (value) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value || 0)
const formatRupees = (cents) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format((cents || 0) / 100)
const formatDate = (value) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(new Date(value))

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault(); setError(''); setLoading(true)
    try { onLogin(await request('/api/auth/login', { method: 'POST', body: JSON.stringify(form) })) }
    catch (submitError) { setError(submitError.message) }
    finally { setLoading(false) }
  }

  return <main className="login-shell">
    <section className="login-editorial">
      <div className="editorial-topline"><span className="mark">C</span><span>Common Table / Counter</span></div>
      <div className="editorial-copy"><p className="eyebrow">A better kind of regular</p><h1>Small gestures.<br /><em>Longer rituals.</em></h1><p className="editorial-note">A quiet space for the people who keep coming back.</p></div>
      <div className="editorial-footer"><span>Est. 2024</span><span>Good coffee, remembered.</span></div>
    </section>
    <section className="login-panel"><div className="login-card">
      <div className="login-heading"><p className="eyebrow">Staff access</p><h2>Welcome back.</h2><p>Sign in to look after your regulars.</p></div>
      <form onSubmit={handleSubmit}><label>Username<input autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label><label>Password<input type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button-dark" disabled={loading}>{loading ? 'Signing in...' : 'Enter the counter'} <span>↗</span></button></form>
      <p className="login-footnote">For Common Table staff only</p>
    </div></section>
  </main>
}

function TierBadge({ tier }) { return <span className={`tier-badge tier-${(tier || 'bronze').toLowerCase()}`}><span className="tier-dot" />{tier || 'BRONZE'}</span> }

function Activity({ member }) {
  const events = [...(member.purchases || []).map((item) => ({ ...item, kind: 'Purchase', detail: `+${formatPoints(item.pointsAwarded)} points`, date: item.createdAt })), ...(member.redemptions || []).map((item) => ({ ...item, kind: 'Reward redeemed', detail: `−${formatPoints(item.pointsUsed)} points`, date: item.createdAt }))].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 4)
  return <section className="activity-section"><div className="section-heading"><p className="eyebrow">The paper trail</p><h3>Recent activity</h3></div>{events.length ? <div className="activity-list">{events.map((event) => <div className="activity-row" key={`${event.kind}-${event.id}`}><span className={`activity-icon ${event.kind === 'Purchase' ? 'positive' : 'negative'}`}>{event.kind === 'Purchase' ? '+' : '−'}</span><div><strong>{event.kind === 'Purchase' ? `Purchase · ${formatRupees(event.amountCents)}` : event.itemName}</strong><span>{event.detail}</span></div><time>{formatDate(event.date)}</time></div>)}</div> : <p className="empty-state">No activity yet. The next visit starts the story.</p>}</section>
}

function Dashboard({ staff, token, onLogout }) {
  const [phone, setPhone] = useState(''); const [member, setMember] = useState(null); const [purchaseAmount, setPurchaseAmount] = useState(''); const [reward, setReward] = useState({ itemName: '', pointsUsed: '' }); const [message, setMessage] = useState(null); const [loading, setLoading] = useState(false)
  async function loadMember(memberId) { const data = await request(`/api/members/${memberId}`, {}, token); setMember(data.member) }
  async function searchMember(event) { event.preventDefault(); setMessage(null); setLoading(true); try { const data = await request(`/api/members/search?phone=${encodeURIComponent(phone.trim())}`, {}, token); await loadMember(data.member.id) } catch (error) { setMember(null); setMessage({ type: 'error', text: error.message }) } finally { setLoading(false) } }
  async function recordPurchase(event) { event.preventDefault(); setMessage(null); try { await request('/api/purchases', { method: 'POST', body: JSON.stringify({ phone: member.phone, amountCents: Math.round(Number(purchaseAmount) * 100) }) }, token); setPurchaseAmount(''); await loadMember(member.id); setMessage({ type: 'success', text: 'Purchase recorded and points added.' }) } catch (error) { setMessage({ type: 'error', text: error.message }) } }
  async function redeemReward(event) { event.preventDefault(); setMessage(null); try { await request('/api/redemptions', { method: 'POST', body: JSON.stringify({ phone: member.phone, itemName: reward.itemName, pointsUsed: Number(reward.pointsUsed) }) }, token); setReward({ itemName: '', pointsUsed: '' }); await loadMember(member.id); setMessage({ type: 'success', text: 'Reward redeemed successfully.' }) } catch (error) { setMessage({ type: 'error', text: error.message }) } }

  return <main className="app-shell"><header className="topbar"><div className="brand"><span className="mark">C</span><span>Common Table</span></div><div className="topbar-right"><span className="staff-name">{staff.name || staff.username}</span><button className="logout-button" onClick={onLogout}>Sign out</button></div></header><div className="workspace">
    <section className="workspace-intro"><div><p className="eyebrow">Staff counter · Today</p><h1>Good morning.<br /><em>Let’s reward the regulars.</em></h1><p className="intro-copy">A small thank-you, remembered well.</p></div><div className="date-stamp">{new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div></section>
    <section className="search-section"><div className="section-heading"><p className="eyebrow">Member lookup</p><h2>Find a member</h2></div><form className="search-form" onSubmit={searchMember}><div className="input-with-label"><label htmlFor="phone">Phone number</label><input id="phone" type="tel" placeholder="e.g. 98765 43210" value={phone} onChange={(event) => setPhone(event.target.value)} required /></div><button className="button button-accent" disabled={loading}>{loading ? 'Searching...' : 'Search'} <span>↗</span></button></form></section>
    {message && <div className={`notice ${message.type}`} role="status">{message.text}</div>}
    {member ? <><section className="member-card"><div className="member-main"><p className="eyebrow">Member profile</p><h2>{member.firstName} {member.lastName}</h2><p className="member-phone">{member.phone}{member.email ? ` · ${member.email}` : ''}</p><TierBadge tier={member.tier} /></div><div className="member-stats"><div className="points-stat"><span>Available points</span><strong>{formatPoints(member.points)}</strong><small>points to spend</small></div><div className="stat"><span>Lifetime spend</span><strong>{formatRupees(member.totalSpent)}</strong></div></div></section>
+      <section className="action-grid"><article className="action-card"><div className="card-topline"><p className="eyebrow">01 / Earn</p><span className="card-mark">＋</span></div><h3>Record purchase</h3><p>Keep the ritual going. Add points from today’s visit.</p><form onSubmit={recordPurchase}><label>Amount in ₹<div className="currency-input"><span>₹</span><input type="number" min="0.01" step="0.01" value={purchaseAmount} onChange={(event) => setPurchaseAmount(event.target.value)} placeholder="0.00" required /></div></label><button className="button button-dark">Record purchase <span>↗</span></button></form></article><article className="action-card"><div className="card-topline"><p className="eyebrow">02 / Return</p><span className="card-mark">◇</span></div><h3>Redeem reward</h3><p>Make a good visit feel even better.</p><form onSubmit={redeemReward}><label>Item name<input value={reward.itemName} onChange={(event) => setReward({ ...reward, itemName: event.target.value })} placeholder="e.g. Oat latte" required /></label><label>Points to redeem<input type="number" min="0.01" step="0.01" value={reward.pointsUsed} onChange={(event) => setReward({ ...reward, pointsUsed: event.target.value })} placeholder="0" required /></label><button className="button button-outline">Redeem points <span>↗</span></button></form></article></section><Activity member={member} /></> : <section className="empty-member"><span className="empty-rule" /><p>Search for a member to begin a visit.</p><span className="empty-rule" /></section>}
  </div></main>
}

function App() {
  const [session, setSession] = useState(() => { try { return JSON.parse(localStorage.getItem('counter-session')) } catch { return null } })
  useEffect(() => { if (session) localStorage.setItem('counter-session', JSON.stringify(session)); else localStorage.removeItem('counter-session') }, [session])
  if (!session) return <Login onLogin={setSession} />
  return <Dashboard staff={session.staff} token={session.token} onLogout={() => setSession(null)} />
}

export default App
