import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ConnectionsPage.module.css';
import { useConnections } from '../ConnectionsContext.jsx';
import { TYPE_INFO } from '../utils/connectionsApi';
import ThemeToggle from '../components/ThemeToggle.jsx';

const DEFAULT_TYPE = 'servicenow';

function typeLabel(type) {
  return TYPE_INFO[type]?.label || type;
}

function emptySecretFor(type) {
  const fields = TYPE_INFO[type]?.fields || [];
  const out = {};
  for (const f of fields) out[f.key] = '';
  return out;
}

export default function ConnectionsPage() {
  const navigate = useNavigate();
  const {
    profiles, active, supportedTypes, loading, error, refreshing, lastRefresh,
    refresh, create, update, activate, remove, refreshActiveSource,
  } = useConnections();

  // Form state. When `editingId` is null, the form is in "create" mode.
  const [formOpen, setFormOpen]     = useState(false);
  const [editingId, setEditingId]   = useState(null);
  const [name, setName]             = useState('');
  const [type, setType]             = useState(DEFAULT_TYPE);
  const [secret, setSecret]         = useState(emptySecretFor(DEFAULT_TYPE));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError]   = useState(null);
  const [openMenuFor, setOpenMenuFor] = useState(null);

  // Close the ⋯ menu on any outside tap or Escape. Without this it stayed open
  // until something else happened to close it, so the Edit/Delete panel sat
  // over the page and followed you around. Same behaviour the Organizations
  // console already had.
  useEffect(() => {
    if (openMenuFor == null) return;
    const close = () => setOpenMenuFor(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenuFor]);

  // Reset secret fields whenever the chosen type changes — different
  // backends require different fields, so we don't want stale values.
  useEffect(() => {
    setSecret(emptySecretFor(type));
  }, [type]);

  const openCreateForm = () => {
    setEditingId(null);
    setName('');
    setType(DEFAULT_TYPE);
    setSecret(emptySecretFor(DEFAULT_TYPE));
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (profile) => {
    setEditingId(profile.id);
    setName(profile.name);
    setType(profile.type);
    setSecret(emptySecretFor(profile.type)); // never preload secrets
    setFormError(null);
    setFormOpen(true);
    setOpenMenuFor(null);
  };

  const closeForm = () => {
    if (submitting) return;
    setFormOpen(false);
    setFormError(null);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingId) {
        // Edit: send name always; send secret only if user typed in any
        // field (otherwise the stored credentials are kept).
        const hasSecret = Object.values(secret).some(v => String(v || '').length > 0);
        await update(editingId, {
          name,
          secret: hasSecret ? secret : undefined,
        });
      } else {
        await create({ name, type, secret });
      }
      setFormOpen(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const onActivate = async (id) => {
    setOpenMenuFor(null);
    try { await activate(id); } catch (err) { alert(err.message); }
  };

  const onDelete = async (profile) => {
    setOpenMenuFor(null);
    if (!confirm(`Delete connection "${profile.name}"?`)) return;
    try { await remove(profile.id); } catch (err) { alert(err.message); }
  };

  const inactive = useMemo(() =>
    profiles.filter(p => !p.is_active), [profiles]);

  const formFields = TYPE_INFO[type]?.fields || [];
  const formHint   = TYPE_INFO[type]?.hint   || null;

  return (
    <div className={`page page-full ${styles.page}`}>
      {/* ─── Header band ─── */}
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate(-1)}
          aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1 className={styles.title}>Data Sources</h1>
        <ThemeToggle />
      </header>

      <p className={styles.intro}>
        Saved databases this app can pull data from. The <strong>active</strong>
        {' '}connection is what every screen uses while you're signed in.
        Switch any time - the data refreshes from the new source.
      </p>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {refreshing && (
        <div className={styles.refreshBanner}>
          <span className={styles.refreshSpinner}/>
          Pulling fresh data from {active?.name || 'the new connection'}…
        </div>
      )}

      {/* ─── Last-refresh outcome ─── */}
      {lastRefresh && !refreshing && (
        lastRefresh.ok ? (
          <div className={styles.successBanner}>
            ✓ Pulled {lastRefresh.count ?? '-'} incident{lastRefresh.count === 1 ? '' : 's'}
            {' '}from <strong>{lastRefresh.instance}</strong>
          </div>
        ) : (
          <div className={styles.errorBanner}>
            Refresh failed: {lastRefresh.error}
          </div>
        )
      )}

      {/* ─── Active connection card ─── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Active</h2>
        {active ? (
          <div className={`${styles.profileCard} ${styles.activeCard}`}>
            <div className={styles.dot}/>
            <div className={styles.cardMain}>
              <p className={styles.cardName}>{active.name}</p>
              <p className={styles.cardType}>{typeLabel(active.type)}</p>
            </div>
            <span className={styles.activeBadge}>Active</span>
            <button
              type="button"
              className={styles.menuBtn}
              onClick={(e) => { e.stopPropagation(); setOpenMenuFor(openMenuFor === active.id ? null : active.id); }}
              aria-label="More options">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
            {openMenuFor === active.id && (
              <div className={styles.menu}>
                <button type="button" onClick={() => openEditForm(active)}>Edit</button>
                <button type="button" className={styles.menuDanger}
                  onClick={() => onDelete(active)}>Delete</button>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.emptyCard}>
            <p>No active connection.</p>
            <p className={styles.emptyHint}>
              Add a connection below to start pulling data from your CMDB.
            </p>
          </div>
        )}
        {active && active.type === 'servicenow' && (
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => refreshActiveSource().catch(() => { /* error shown in banner */ })}
            disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh data from this source'}
          </button>
        )}
      </section>

      {/* ─── Other saved connections ─── */}
      {inactive.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Other saved</h2>
          <ul className={styles.list}>
            {inactive.map(p => (
              <li key={p.id} className={styles.profileCard}>
                <div className={`${styles.dot} ${styles.dotInactive}`}/>
                <div className={styles.cardMain}>
                  <p className={styles.cardName}>{p.name}</p>
                  <p className={styles.cardType}>{typeLabel(p.type)}</p>
                </div>
                <button
                  type="button"
                  className={styles.useBtn}
                  onClick={() => onActivate(p.id)}>
                  Use
                </button>
                <button
                  type="button"
                  className={styles.menuBtn}
                  onClick={(e) => { e.stopPropagation(); setOpenMenuFor(openMenuFor === p.id ? null : p.id); }}
                  aria-label="More options">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="5" cy="12" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="19" cy="12" r="2"/>
                  </svg>
                </button>
                {openMenuFor === p.id && (
                  <div className={styles.menu}>
                    <button type="button" onClick={() => openEditForm(p)}>Edit</button>
                    <button type="button" className={styles.menuDanger}
                      onClick={() => onDelete(p)}>Delete</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─── Add button ─── */}
      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={openCreateForm}
          disabled={loading}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="12" y1="5"  x2="12" y2="19"/>
            <line x1="5"  y1="12" x2="19" y2="12"/>
          </svg>
          Add connection
        </button>
      </div>

      {/* ─── Create / Edit form modal ─── */}
      {formOpen && (
        <div className={styles.modalBackdrop} onClick={closeForm}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <header className={styles.modalHead}>
              <h2 className={styles.modalTitle}>
                {editingId ? 'Edit connection' : 'New connection'}
              </h2>
              <button type="button" className={styles.modalClose}
                onClick={closeForm} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6"  x2="6"  y2="18"/>
                  <line x1="6"  y1="6"  x2="18" y2="18"/>
                </svg>
              </button>
            </header>

            <form onSubmit={onSubmit} className={styles.form}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Name</span>
                <input
                  type="text"
                  className={styles.input}
                  placeholder="e.g. My ServiceNow Dev"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Type</span>
                <select
                  className={styles.input}
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={!!editingId}>
                  {(supportedTypes.length ? supportedTypes : Object.keys(TYPE_INFO)).map(t => (
                    <option key={t} value={t}>{typeLabel(t)}</option>
                  ))}
                </select>
                {editingId && (
                  <span className={styles.fieldHint}>
                    Type can't change after a connection is created.
                  </span>
                )}
              </label>

              {formFields.map(f => (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {f.label}
                    {f.required && <span className={styles.required}> *</span>}
                  </span>
                  <input
                    type={f.type || 'text'}
                    className={styles.input}
                    placeholder={f.placeholder || ''}
                    value={secret[f.key] || ''}
                    onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })}
                    required={!editingId && f.required}
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>
              ))}

              {editingId && (
                <p className={styles.editHint}>
                  Leave the credential fields blank to keep what's already saved.
                </p>
              )}

              {formHint && !editingId && (
                <p className={styles.editHint}>{formHint}</p>
              )}

              {formError && <div className={styles.formError}>{formError}</div>}

              <div className={styles.formActions}>
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={closeForm}
                  disabled={submitting}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={submitting}>
                  {submitting ? 'Saving…' : (editingId ? 'Save changes' : 'Save & use')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
