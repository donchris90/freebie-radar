import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, Appeal, AuditRow, hasToken, Me, ReportRow, setToken, Stats } from './api';

type Tab = 'overview' | 'reports' | 'appeals' | 'countries' | 'audit' | 'jobs';

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

function Breakdown({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <section className="card">
      <h2>{title}</h2>
      {entries.length === 0 ? <p className="muted">No data yet.</p> : entries.map(([k, n]) => (
        <div key={k} style={{ marginBottom: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{k.replace(/_/g, ' ').toLowerCase()}</span><strong>{n}</strong></div>
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
          <div className="grid">
            <section className="card"><h2>Users</h2><div className="big">{s.data.users}</div></section>
            <section className="card"><h2>Open reports</h2><div className="big">{s.data.openReports}</div></section>
            <section className="card"><h2>Duplicate listings</h2><div className="big">{s.data.duplicateListings}</div></section>
          </div>
          <div className="grid">
            <Breakdown title="Listings by status" data={s.data.listingsByStatus} />
            <Breakdown title="Listings by source" data={s.data.listingsBySource} />
            <Breakdown title="Listings by country" data={s.data.listingsByCountry} />
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
        <h2 style={{ margin: 0 }}>Moderation queue</h2>
        <div className="row">{(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => { setStatus(s); setOffset(0); }}>{s.replace('_', ' ').toLowerCase()}</button>)}</div>
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
      <h2>Pending appeals</h2>
      <Status {...q} retry={q.reload} />
      {msg ? <p className="err" role="alert">{msg}</p> : null}
      {q.data && q.data.length === 0 ? <p className="muted">No pending appeals.</p> : null}
      {q.data?.map((a) => (
        <div key={a.id} className="card" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>{a.message}</p>
          <p className="muted">{new Date(a.createdAt).toLocaleString()}</p>
          <div className="row"><input aria-label="Decision note" placeholder="Note (required)" value={note[a.id] ?? ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} style={{ maxWidth: 320 }} />
            <button className="primary" onClick={() => resolve(a, 'UPHELD')}>Uphold appeal (restore)</button><button onClick={() => resolve(a, 'REJECTED')}>Reject</button></div>
        </div>
      ))}
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
      <h2>Countries</h2>
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
                <td>{c.enabled ? 'Enabled' : 'Off'}</td>
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
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Audit log</h2><input aria-label="Filter this page by action or id" placeholder="Filter this page…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240 }} /></div>
      <Status {...q} retry={q.reload} />
      {q.data ? <table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
        {rows.map((r) => <tr key={r.id}><td>{new Date(r.createdAt).toLocaleString()}</td><td>{r.action}</td><td className="muted">{r.entityType} {r.entityId?.slice(0, 8)}</td><td className="muted">{Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ''}</td></tr>)}
      </tbody></table> : null}
      {q.data && rows.length === 0 ? <p className="muted">No entries.</p> : null}
      {q.data ? <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}><span className="muted">{q.data.total} total</span><span className="row"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Newer</button><button disabled={offset + 25 >= q.data.total} onClick={() => setOffset(offset + 25)}>Older</button></span></div> : null}
    </section>
  );
}

function Jobs() {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string) => { setBusy(true); try { setOut(JSON.stringify(await api(path, { method: 'POST' }))); } catch (e) { setOut((e as Error).message); } finally { setBusy(false); } };
  return (
    <section className="card">
      <h2>Background jobs</h2>
      <p className="muted">Manual triggers for the job bodies. Scheduled execution (BullMQ) is not wired yet.</p>
      <div className="row"><button disabled={busy} onClick={() => run('/admin/jobs/expire')}>Run listing expiry</button><button disabled={busy} onClick={() => run('/admin/jobs/dispatch-alerts')}>Dispatch pending alerts</button></div>
      {out ? <pre role="status">{out}</pre> : null}
    </section>
  );
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ accessToken: string; user: Me }>('/auth/login', { body: { email, password } });
      if (r.user.role !== 'ADMIN' && r.user.role !== 'MODERATOR') throw new ApiError(403, 'This account does not have moderator or admin access.');
      setToken(r.accessToken); onDone(r.user);
    } catch (err) { setToken(null); setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <h1>Freebie Radar Admin</h1>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
      {error ? <p className="err" role="alert">{error}</p> : null}
      <button className="primary" disabled={busy}>Sign in</button>
    </form>
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

  if (checking) return <main><p className="muted" role="status">Loading…</p></main>;
  if (!me) return <Login onDone={(u) => { setMe(u); setTab(u.role === 'ADMIN' ? 'overview' : 'reports'); }} />;

  const isAdmin = me.role === 'ADMIN';
  const tabs: [Tab, string, boolean][] = [['overview', 'Overview', isAdmin], ['reports', 'Reports', true], ['appeals', 'Appeals', true], ['countries', 'Countries', isAdmin], ['audit', 'Audit log', isAdmin], ['jobs', 'Jobs', isAdmin]];
  return (
    <>
      <header>
        <h1>Freebie Radar Admin</h1>
        <nav aria-label="Sections">{tabs.filter(([, , show]) => show).map(([k, label]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}</nav>
        <span className="row"><span className="muted">{me.displayName} · {me.role.toLowerCase()}</span><button onClick={() => { setToken(null); setMe(null); }}>Sign out</button></span>
      </header>
      <main>
        {tab === 'overview' && isAdmin ? <Overview /> : null}
        {tab === 'reports' ? <Reports /> : null}
        {tab === 'appeals' ? <Appeals /> : null}
        {tab === 'countries' && isAdmin ? <Countries /> : null}
        {tab === 'audit' && isAdmin ? <Audit /> : null}
        {tab === 'jobs' && isAdmin ? <Jobs /> : null}
      </main>
    </>
  );
}
