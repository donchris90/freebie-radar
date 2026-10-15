import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, Appeal, AuditRow, hasToken, Me, ReportRow, setRefreshToken, setToken, signOut, Stats } from './api';

type Tab = 'overview' | 'reports' | 'appeals' | 'users' | 'countries' | 'audit' | 'billing' | 'messages' | 'sources' | 'jobs';

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true); setError(null);
    fn().then(setData).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

function Status({ loading, error, retry }: { loading: boolean; error: string | null; retry: () => void }) {
  if (loading) return <p className="muted" role="status">Loading…</p>;
  if (error) return <p className="err" role="alert">{error} <button onClick={retry}>Retry</button></p>;
  return null;
}

function Breakdown({ title, data, raw }: { title: string; data: Record<string, number>; raw?: boolean }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <section className="card">
      <h2>{title}</h2>
      {entries.length === 0 ? <p className="muted">No data yet.</p> : entries.map(([k, n]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{raw ? k : k.replace(/_/g, ' ').toLowerCase()}</span><strong>{n}</strong></div>
          <div className="bar" aria-hidden="true"><span style={{ width: `${(n / max) * 100}%` }} /></div>
        </div>
      ))}
    </section>
  );
}

function Overview() {
  const s = useLoad(() => api<Stats>('/admin/stats'), []);
  return (
    <>
      <Status {...s} retry={s.reload} />
      {s.data ? (
        <>
          <section className="stats" aria-label="Key numbers">
            <div><span className="stat-label">Users</span><span className="stat-num">{s.data.users}</span></div>
            <div><span className="stat-label">Open reports</span><span className={`stat-num ${s.data.openReports > 0 ? 'attn' : ''}`}>{s.data.openReports}</span></div>
            <div><span className="stat-label">Duplicate listings</span><span className="stat-num">{s.data.duplicateListings}</span></div>
          </section>
          <div className="grid">
            <Breakdown title="Listings by status" data={s.data.listingsByStatus} />
            <Breakdown title="Listings by source" data={s.data.listingsBySource} />
            <Breakdown title="Listings by country" data={s.data.listingsByCountry} raw />
            <Breakdown title="Alert deliveries by status" data={s.data.deliveriesByStatus} />
          </div>
          <p className="muted">Counts come straight from the database. Provider failure rates, retention, revenue and promotion metrics will appear here once those systems exist.</p>
        </>
      ) : null}
    </>
  );
}

function Reports() {
  const [status, setStatus] = useState<'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED'>('OPEN');
  const [offset, setOffset] = useState(0);
  const limit = 10;
  const q = useLoad(() => api<{ items: ReportRow[]; total: number }>(`/admin/reports?status=${status}&offset=${offset}&limit=${limit}`), [status, offset]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (row: ReportRow, action: 'REMOVE_LISTING' | 'MARK_UNDER_REVIEW' | 'RESTORE_LISTING' | 'DISMISS_REPORT') => {
    const r = (reason[row.report.id] ?? '').trim();
    if (r.length < 3) { setMsg('Enter a reason of at least 3 characters. It is recorded in the audit log.'); return; }
    setBusy(row.report.id); setMsg(null);
    try { await api(`/admin/reports/${row.report.id}/resolve`, { body: { action, reason: r } }); q.reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row segmented" role="group" aria-label="Report status">{(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => { setStatus(s); setOffset(0); }}>{s.replace('_', ' ').toLowerCase()}</button>)}</div>
      </div>
      <Status {...q} retry={q.reload} />
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {q.data && q.data.items.length === 0 ? <p className="muted">Nothing here.</p> : null}
      {q.data?.items.length ? (
        <table>
          <thead><tr><th>Listing</th><th>Report</th><th>Risk</th><th>Decision</th></tr></thead>
          <tbody>
            {q.data.items.map((row) => (
              <tr key={row.report.id}>
                <td>{row.listing ? <><strong>{row.listing.title}</strong><div className="muted">{row.listing.status.toLowerCase().replace(/_/g, ' ')}</div></> : <span className="muted">Listing missing</span>}</td>
                <td><span className="pill">{row.report.reason.toLowerCase().replace(/_/g, ' ')}</span>{row.report.details ? <div className="muted">{row.report.details}</div> : null}<div className="muted">{new Date(row.report.createdAt).toLocaleString()}</div></td>
                <td>{row.listing ? <><span className={`pill ${row.listing.riskLevel === 'NO_MAJOR_SIGNALS' ? '' : 'warn'}`}>{row.listing.riskLevel.toLowerCase().replace(/_/g, ' ')}</span>{row.listing.riskSignals.map((x) => <div key={x} className="muted">{x}</div>)}</> : null}</td>
                <td>
                  {status === 'OPEN' ? (
                    <div style={{ display: 'grid', gap: 8, minWidth: 220 }}>
                      <input aria-label="Reason for decision" placeholder="Reason (required, audited)" value={reason[row.report.id] ?? ''} onChange={(e) => setReason({ ...reason, [row.report.id]: e.target.value })} />
                      <div className="row">
                        <button className="danger" disabled={busy === row.report.id} onClick={() => act(row, 'REMOVE_LISTING')}>Remove</button>
                        <button disabled={busy === row.report.id} onClick={() => act(row, 'MARK_UNDER_REVIEW')}>Hold</button>
                        <button disabled={busy === row.report.id} onClick={() => act(row, 'DISMISS_REPORT')}>Dismiss</button>
                      </div>
                    </div>
                  ) : <span className="muted">Resolved</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {q.data ? <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <span className="muted">{q.data.total} total</span>
        <span className="row"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button><button disabled={offset + limit >= q.data.total} onClick={() => setOffset(offset + limit)}>Next</button></span>
      </div> : null}
    </section>
  );
}

function Appeals() {
  const q = useLoad(() => api<Appeal[]>('/admin/appeals'), []);
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const resolve = async (a: Appeal, decision: 'UPHELD' | 'REJECTED') => {
    const n = (note[a.id] ?? '').trim();
    if (n.length < 3) { setMsg('Add a note of at least 3 characters.'); return; }
    try { await api(`/admin/appeals/${a.id}/resolve`, { body: { decision, note: n } }); setMsg(null); q.reload(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section className="card">
      <Status {...q} retry={q.reload} />
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {q.data && q.data.length === 0 ? <p className="muted">No pending appeals.</p> : null}
      {q.data?.map((a) => (
        <div key={a.id} className="item">
          <p style={{ margin: 0 }}>{a.message}</p>
          <p className="muted">{new Date(a.createdAt).toLocaleString()}</p>
          <div className="row"><input aria-label="Decision note" placeholder="Note (required)" value={note[a.id] ?? ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} style={{ maxWidth: 320 }} />
            <button className="primary" onClick={() => resolve(a, 'UPHELD')}>Uphold appeal (restore)</button><button onClick={() => resolve(a, 'REJECTED')}>Reject</button></div>
        </div>
      ))}
    </section>
  );
}

interface UserRow { id: string; email: string; displayName: string; role: string; status: 'ACTIVE' | 'SUSPENDED' | 'DELETED'; emailVerified: boolean; countryCode: string; createdAt: string }

function Users() {
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<UserRow | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const find = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null); setUser(null);
    try { setUser(await api<UserRow>(`/admin/users?email=${encodeURIComponent(email.trim())}`)); } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  };
  const set = async (status: 'ACTIVE' | 'SUSPENDED') => {
    if (!user) return;
    if (reason.trim().length < 3) { setMsg('Enter a reason of at least 3 characters. It is recorded in the audit log.'); return; }
    setBusy(true); setMsg(null);
    try { setUser(await api<UserRow>(`/admin/users/${user.id}/status`, { body: { status, reason: reason.trim() } })); setReason(''); } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card">
      <form className="row inline" onSubmit={find}>
        <input aria-label="Account email" type="email" placeholder="Find an account by exact email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ maxWidth: 360 }} />
        <button className="primary" disabled={busy}>Find account</button>
      </form>
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {user ? (
        <div className="item">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><strong>{user.displayName}</strong><div className="muted">{user.email} · {user.role.toLowerCase()} · {user.countryCode} · joined {new Date(user.createdAt).toLocaleDateString()}</div></div>
            <span className="row"><span className={`pill ${user.status === 'ACTIVE' ? 'on' : 'warn'}`}>{user.status.toLowerCase()}</span><span className="pill">{user.emailVerified ? 'email verified' : 'email not verified'}</span></span>
          </div>
          {user.status !== 'DELETED' && user.role !== 'ADMIN' ? (
            <div className="row" style={{ marginTop: 14 }}>
              <input aria-label="Reason for decision" placeholder="Reason (required, audited)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 320 }} />
              {user.status === 'ACTIVE'
                ? <button className="danger" disabled={busy} onClick={() => set('SUSPENDED')}>Suspend</button>
                : <button className="primary" disabled={busy} onClick={() => set('ACTIVE')}>Restore access</button>}
            </div>
          ) : <p className="muted">{user.role === 'ADMIN' ? 'Admin accounts cannot be suspended here.' : 'This account was deleted by its owner.'}</p>}
          <p className="muted">Suspending signs the person out everywhere and holds their public listings for review. Restoring access does not republish them; use the moderation queue for that.</p>
        </div>
      ) : null}
    </section>
  );
}

interface CountryRow { code: string; name: string; currency: string; distanceUnit: string; timeZone: string; enabled: boolean }

function Countries() {
  const q = useLoad(() => api<{ items: CountryRow[] }>('/admin/countries'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = async (c: CountryRow) => {
    setBusy(c.code); setMsg(null);
    try { await api(`/admin/countries/${c.code}`, { method: 'PATCH', body: { enabled: !c.enabled } }); q.reload(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  };
  const rows = q.data?.items ?? [];
  const on = rows.filter((c) => c.enabled);
  return (
    <section className="card">
      <p className="muted">Only enabled countries accept new accounts and listings. Turning one off does not remove existing users or listings. {on.length ? `Enabled now: ${on.map((c) => c.code).join(', ')}.` : ''}</p>
      <Status {...q} retry={q.reload} />
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {rows.length ? (
        <table>
          <thead><tr><th>Country</th><th>Currency</th><th>Distance</th><th>Default time zone</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.code}>
                <td>{c.name} <span className="muted">({c.code})</span></td>
                <td>{c.currency}</td>
                <td>{c.distanceUnit}</td>
                <td>{c.timeZone}</td>
                <td><span className={`pill ${c.enabled ? 'on' : ''}`}>{c.enabled ? 'Enabled' : 'Off'}</span></td>
                <td><button disabled={busy === c.code} onClick={() => toggle(c)}>{c.enabled ? 'Turn off' : 'Turn on'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Audit() {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const q = useLoad(() => api<{ items: AuditRow[]; total: number }>(`/admin/audit?offset=${offset}&limit=25`), [offset]);
  const rows = (q.data?.items ?? []).filter((r) => !filter || r.action.toLowerCase().includes(filter.toLowerCase()) || (r.entityId ?? '').includes(filter));
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'flex-end' }}><input aria-label="Filter this page by action or id" placeholder="Filter this page…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240 }} /></div>
      <Status {...q} retry={q.reload} />
      {q.data ? <table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.action}</td><td className="muted">{r.entityType} {r.entityId?.slice(0, 8)}</td><td className="muted">{Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}</td></tr>)}
      </tbody></table> : null}
      {q.data && rows.length === 0 ? <p className="muted">No entries.</p> : null}
      {q.data ? <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}><span className="muted">{q.data.total} total</span><span className="row"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button><button disabled={offset + 25 >= q.data.total} onClick={() => setOffset(offset + 25)}>Older</button></span></div> : null}
    </section>
  );
}

interface JobRow { name: string; everyMs: number; nextRunAt: string | null; lastSuccess: { at: string; result: unknown } | null; lastFailure: { at: string; reason: string; attempts: number } | null; stale: boolean }

const every = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

function Jobs() {
  const q = useLoad(() => api<{ enabled: boolean; jobs: JobRow[] }>('/admin/jobs/status'), []);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string) => { setBusy(true); try { setOut(JSON.stringify(await api(path, { method: 'POST' }))); q.reload(); } catch (e) { setOut((e as Error).message); } finally { setBusy(false); } };
  return (
    <section className="card">
      <Status {...q} retry={q.reload} />
      {q.data && !q.data.enabled ? <p className="err" role="alert">Scheduled jobs are off because no Redis is configured. Listings will not expire and deferred alerts will not send on their own. Set REDIS_URL and restart the API.</p> : null}
      {q.data?.enabled ? (
        <table>
          <thead><tr><th>Job</th><th>Runs every</th><th>Last success</th><th>Next run</th><th>Last failure</th><th></th></tr></thead>
          <tbody>
            {q.data.jobs.map((j) => (
              <tr key={j.name}>
                <td><strong>{j.name}</strong> {j.stale ? <span className="pill warn">not keeping up</span> : <span className="pill on">on schedule</span>}</td>
                <td>{every(j.everyMs)}</td>
                <td>{j.lastSuccess ? <>{new Date(j.lastSuccess.at).toLocaleString()}<div className="muted">{j.lastSuccess.result ? JSON.stringify(j.lastSuccess.result) : ''}</div></> : <span className="muted">Not yet</span>}</td>
                <td>{j.nextRunAt ? new Date(j.nextRunAt).toLocaleTimeString() : <span className="muted">-</span>}</td>
                <td>{j.lastFailure ? <><span className="err">{j.lastFailure.reason}</span><div className="muted">{new Date(j.lastFailure.at).toLocaleString()} after {j.lastFailure.attempts} tries</div></> : <span className="muted">None recorded</span>}</td>
                <td><button disabled={busy} onClick={() => run(`/admin/jobs/queue/${j.name}`)}>Run now</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="muted">Failed runs retry automatically; a run that fails every try is written to the audit log as JOB_FAILED.</p>
      <div className="row"><button disabled={busy} onClick={() => run('/admin/jobs/expire')}>Run listing expiry directly</button><button disabled={busy} onClick={() => run('/admin/jobs/dispatch-alerts')}>Dispatch pending alerts directly</button></div>
      {out ? <pre role="status">{out}</pre> : null}
    </section>
  );
}

interface PayRow { id: string; userId: string; reference: string; status: string; amountMinor: number; currency: string; refundedMinor: number; createdAt: string; failureReason: string | null }
interface EventRow { id: string; type: string; eventKey: string; status: string; error: string | null; attempts: number; receivedAt: string }

function Billing() {
  const pays = useLoad(() => api<{ items: PayRow[]; total: number }>('/admin/billing/payments?limit=25'), []);
  const evs = useLoad(() => api<{ items: EventRow[] }>('/admin/billing/events?limit=25'), []);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const money = (minor: number, cur: string) => `${(minor / 100).toFixed(2)} ${cur}`;
  const act = async (path: string, body: unknown) => { setMsg(null); try { await api(path, { body }); pays.reload(); evs.reload(); } catch (e) { setMsg((e as Error).message); } };
  const failed = evs.data?.items.filter((e) => e.status === 'FAILED') ?? [];
  return (
    <>
      <section className="card">
        <h2>Payments</h2>
        <p className="muted">Refunds go to the payment provider first; the amount here is in the payment currency. A full refund ends Premium at once.</p>
        <Status {...pays} retry={pays.reload} />
        {msg ? <p className="err" role="alert">{msg}</p> : null}
        {pays.data ? <table><thead><tr><th>When</th><th>Reference</th><th>Amount</th><th>Status</th><th>Refund</th></tr></thead><tbody>
          {pays.data.items.map((p) => (
            <tr key={p.id}>
              <td>{new Date(p.createdAt).toLocaleString()}</td><td><code>{p.reference}</code></td>
              <td>{money(p.amountMinor, p.currency)}{p.refundedMinor ? <div className="muted">refunded {money(p.refundedMinor, p.currency)}</div> : null}</td>
              <td><span className={`pill ${p.status === 'SUCCEEDED' ? 'on' : p.status === 'FAILED' || p.status === 'REFUND_PENDING' ? 'warn' : ''}`}>{p.status.toLowerCase().replace(/_/g, ' ')}</span>{p.failureReason ? <div className="muted">{p.failureReason}</div> : null}</td>
              <td>
                {p.status === 'SUCCEEDED' || p.status === 'PARTIALLY_REFUNDED' ? <div className="row"><input aria-label="Reason" placeholder="Reason (audited)" style={{ maxWidth: 200 }} value={reason[p.reference] ?? ''} onChange={(e) => setReason({ ...reason, [p.reference]: e.target.value })} /><button className="danger" onClick={() => { if (window.confirm('Refund the remaining amount in full?')) void act('/admin/billing/refund', { reference: p.reference, reason: reason[p.reference] ?? '' }); }}>Refund all</button></div> : null}
                {p.status === 'REFUND_PENDING' ? <button onClick={() => act(`/admin/billing/refunds/${p.reference}/settle`, { note: 'Confirmed complete on the provider dashboard' })}>Mark completed</button> : null}
              </td>
            </tr>
          ))}
        </tbody></table> : null}
      </section>
      <section className="card">
        <h2>Webhook events</h2>
        {failed.length ? <p className="err" role="alert">{failed.length} event(s) failed to process. The provider will retry; if they keep failing, investigate.</p> : <p className="muted">No failed events in the latest 25.</p>}
        <Status {...evs} retry={evs.reload} />
        {evs.data ? <table><thead><tr><th>Received</th><th>Event</th><th>Status</th><th>Tries</th></tr></thead><tbody>
          {evs.data.items.map((e) => <tr key={e.id}><td>{new Date(e.receivedAt).toLocaleString()}</td><td><code>{e.eventKey}</code></td><td><span className={`pill ${e.status === 'FAILED' ? 'warn' : e.status === 'PROCESSED' ? 'on' : ''}`}>{e.status.toLowerCase()}</span>{e.error ? <div className="err">{e.error}</div> : null}</td><td>{e.attempts}</td></tr>)}
        </tbody></table> : null}
      </section>
    </>
  );
}

interface MsgReportRow {
  report: { id: string; reason: string; details: string | null; status: string; createdAt: string };
  reporter: { displayName: string } | null; sender: { id: string; displayName: string; status: string } | null;
  listing: { title: string } | null;
  message: { body: string; flagged: boolean; at: string } | null;
  context: { id: string; fromReportedUser: boolean; body: string; at: string }[];
}

function MessageReports() {
  const [status, setStatus] = useState<'OPEN' | 'ACTIONED' | 'DISMISSED'>('OPEN');
  const q = useLoad(() => api<{ items: MsgReportRow[]; total: number }>(`/admin/message-reports?status=${status}&limit=20`), [status]);
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (id: string, action: 'ACTION' | 'DISMISS') => {
    const n = (note[id] ?? '').trim();
    if (n.length < 3) { setMsg('Enter a note of at least 3 characters. It is recorded in the audit log.'); return; }
    setMsg(null);
    try { await api(`/admin/message-reports/${id}/resolve`, { body: { action, note: n } }); q.reload(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section className="card">
      <div className="row segmented" role="group" aria-label="Report status">{(['OPEN', 'ACTIONED', 'DISMISSED'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s.toLowerCase()}</button>)}</div>
      <p className="muted">Staff only see a message someone reported, with the few messages before it. Use Users to suspend an account.</p>
      <Status {...q} retry={q.reload} />
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {q.data && q.data.items.length === 0 ? <p className="muted">Nothing here.</p> : null}
      {q.data?.items.map((r) => (
        <div className="item" key={r.report.id}>
          <div className="row inline"><span className="pill warn">{r.report.reason.toLowerCase().replace(/_/g, ' ')}</span> <span className="muted">{new Date(r.report.createdAt).toLocaleString()} · reported by {r.reporter?.displayName ?? 'unknown'} · about “{r.listing?.title ?? 'removed listing'}”</span></div>
          {r.report.details ? <p>{r.report.details}</p> : null}
          <p><strong>{r.sender?.displayName ?? 'Unknown'}</strong> {r.sender && r.sender.status !== 'ACTIVE' ? <span className="pill">{r.sender.status.toLowerCase()}</span> : null} wrote: “{r.message?.body}” {r.message?.flagged ? <span className="pill warn">auto-flagged</span> : null}</p>
          {r.context.length > 1 ? <details><summary className="muted">Earlier messages</summary>{r.context.map((c) => <div key={c.id} className="muted">{c.fromReportedUser ? 'Reported user' : 'Other person'}: {c.body}</div>)}</details> : null}
          {status === 'OPEN' ? (
            <div className="row" style={{ marginTop: 8 }}>
              <input aria-label="Note" placeholder="Note (required, audited)" style={{ maxWidth: 320 }} value={note[r.report.id] ?? ''} onChange={(e) => setNote({ ...note, [r.report.id]: e.target.value })} />
              <button className="primary" onClick={() => act(r.report.id, 'ACTION')}>Mark actioned</button>
              <button onClick={() => act(r.report.id, 'DISMISS')}>Dismiss</button>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

interface SourceRow {
  key: string; name: string; enabled: boolean; configured: boolean; setup: string | null; countries: string[];
  attribution: string | null; permissionNote: string | null; expireAfterHours: number; retireAfterHours: number;
  lastOkAt: string | null; lastRun: { status: string; fetched: number; created: number; updated: number; rejected: number; errorMessage: string | null; startedAt: string } | null;
}

function Sources() {
  const q = useLoad(() => api<SourceRow[]>('/admin/sources'), []);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setOut(null); try { const r = await fn(); setOut(JSON.stringify(r)); q.reload(); } catch (e) { setOut((e as Error).message); } finally { setBusy(false); } };
  return (
    <section className="card">
      <Status {...q} retry={q.reload} />
      {q.data && q.data.length === 0 ? <p className="muted">No partner feeds are configured. Set PARTNER_FEEDS and the PARTNER_FEED_&lt;KEY&gt;_* variables on the API (see docs/LISTING_SOURCES.md). Until then only listings posted by people appear.</p> : null}
      {q.data?.map((s) => (
        <div className="item" key={s.key}>
          <div className="row inline"><strong>{s.name}</strong> <span className="muted">{s.key}</span>
            {s.enabled ? <span className="pill on">on</span> : <span className="pill">off</span>}
            {!s.configured ? <span className="pill warn">not configured</span> : null}
          </div>
          {s.setup ? <p className="err">{s.setup}</p> : null}
          <p className="muted">Countries: {s.countries.length ? s.countries.join(', ') : 'all enabled'} · listings expire after {s.expireAfterHours}h unconfirmed, retired {s.retireAfterHours}h later · credit shown: {s.attribution ?? 'none'}</p>
          <p className="muted">Permission on file: {s.permissionNote ?? <span className="err">none recorded, cannot be switched on</span>}</p>
          <p className="muted">{s.lastRun ? <>Last run {new Date(s.lastRun.startedAt).toLocaleString()}: <strong>{s.lastRun.status}</strong> · fetched {s.lastRun.fetched}, new {s.lastRun.created}, refreshed {s.lastRun.updated}, rejected {s.lastRun.rejected}{s.lastRun.errorMessage ? <> · <span className="err">{s.lastRun.errorMessage}</span></> : null}</> : 'Never run.'}{s.lastOkAt ? <> Last fully successful run: {new Date(s.lastOkAt).toLocaleString()}.</> : null}</p>
          <div className="row">
            <button disabled={busy || (!s.enabled && !s.permissionNote)} onClick={() => act(() => api(`/admin/sources/${s.key}/enabled`, { method: 'POST', body: { enabled: !s.enabled } }))}>{s.enabled ? 'Switch off' : 'Switch on'}</button>
            <button disabled={busy || !s.enabled} onClick={() => act(() => api(`/admin/sources/${s.key}/sync`, { method: 'POST' }))}>Sync now</button>
          </div>
        </div>
      ))}
      {out ? <pre role="status">{out}</pre> : null}
    </section>
  );
}

function Mark() {
  return <span className="mark" aria-hidden="true"><i /><b /></span>;
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', { body: { email, password } });
      if (r.user.role !== 'ADMIN' && r.user.role !== 'MODERATOR') throw new ApiError(403, 'This account does not have moderator or admin access.');
      setToken(r.accessToken); setRefreshToken(r.refreshToken); onDone(r.user);
    } catch (err) { setToken(null); setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <div className="rings"><i /><i /><i /><i /><b /></div>
        <p className="login-tag">Moderation and operations for Freebie Radar.</p>
      </div>
      <form onSubmit={submit}>
        <div className="brand"><Mark /> <span>Freebie Radar</span></div>
        <h1>Sign in</h1>
        <p className="muted">Moderator and admin accounts only.</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error ? <p className="err" role="alert">{error}</p> : null}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(hasToken());
  const [tab, setTab] = useState<Tab>('reports');

  useEffect(() => {
    if (!hasToken()) return;
    api<Me>('/me').then((u) => { setMe(u); setTab(u.role === 'ADMIN' ? 'overview' : 'reports'); }).catch(() => setToken(null)).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="boot"><p className="muted" role="status">Loading…</p></div>;
  if (!me) return <Login onDone={(u) => { setMe(u); setTab(u.role === 'ADMIN' ? 'overview' : 'reports'); }} />;

  const isAdmin = me.role === 'ADMIN';
  const tabs: [Tab, string, boolean][] = [['overview', 'Overview', isAdmin], ['reports', 'Reports', true], ['appeals', 'Appeals', true], ['messages', 'Messages', true], ['users', 'Users', isAdmin], ['countries', 'Countries', isAdmin], ['audit', 'Audit log', isAdmin], ['billing', 'Billing', isAdmin], ['sources', 'Sources', isAdmin], ['jobs', 'Jobs', isAdmin]];
  const visible = tabs.filter(([, , show]) => show);
  const current = visible.find(([k]) => k === tab)?.[1] ?? '';
  return (
    <div className="shell">
      <aside>
        <div className="brand"><Mark /> <span>Freebie Radar</span></div>
        <nav aria-label="Sections">{visible.map(([k, label]) => <button key={k} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>)}</nav>
        <div className="who">
          <span className="who-name">{me.displayName}</span>
          <span className="who-role">{me.role.toLowerCase()}</span>
          <button onClick={() => { void signOut(); setMe(null); }}>Sign out</button>
        </div>
      </aside>
      <main>
        <h1 className="page-title">{current}</h1>
        {tab === 'overview' && isAdmin ? <Overview /> : null}
        {tab === 'reports' ? <Reports /> : null}
        {tab === 'appeals' ? <Appeals /> : null}
        {tab === 'messages' ? <MessageReports /> : null}
        {tab === 'users' && isAdmin ? <Users /> : null}
        {tab === 'countries' && isAdmin ? <Countries /> : null}
        {tab === 'audit' && isAdmin ? <Audit /> : null}
        {tab === 'billing' && isAdmin ? <Billing /> : null}
        {tab === 'sources' && isAdmin ? <Sources /> : null}
        {tab === 'jobs' && isAdmin ? <Jobs /> : null}
      </main>
    </div>
  );
}
