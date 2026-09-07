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

      {error && <p className={styles.bad}>{error}</p>}
      {refreshing && (
        <p className={styles.note}>
          <span className={styles.refreshSpinner}/>
          Pulling fresh data from {active?.name || 'the new connection'}…
        </p>
      )}
      {lastRefresh && !refreshing && (
        lastRefresh.ok
          ? <p className={styles.good}>Pulled {lastRefresh.count ?? '-'} incident{lastRefresh.count === 1 ? '' : 's'} from {lastRefresh.instance}.</p>
          : <p className={styles.bad}>Refresh failed: {lastRefresh.error}</p>
      )}

      {/* One list. The connection in use is first and says so; the others
          are one tap from becoming it. No cards, no dots, no menus: a name,
          what kind of thing it is, and the two or three verbs that apply. */}
      {profiles.length === 0 ? (
        <div className={styles.empty}>
          <p>No connections yet.</p>
          <p className={styles.emptySub}>Add your CMDB or NetBox once and every screen uses it.</p>
        </div>
      ) : (
        <ul className={styles.rows}>
          {[...(active ? [active] : []), ...inactive].map((p) => {
            const isActive = active && p.id === active.id;
            return (
              <li key={p.id} className={`${styles.row} ${isActive ? styles.rowActive : ''}`}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{p.name}</span>
                  <span className={styles.rowType}>
                    {typeLabel(p.type)}{isActive ? ' · in use' : ''}
                  </span>
                </div>
                <div className={styles.verbs}>
                  {!isActive && (
                    <button type="button" onClick={() => onActivate(p.id)}>Use</button>
                  )}
                  {isActive && p.type === 'servicenow' && (
                    <button type="button" disabled={refreshing}
                      onClick={() => refreshActiveSource().catch(() => { /* shown above */ })}>
                      {refreshing ? 'Refreshing…' : 'Refresh'}
                    </button>
                  )}
                  <button type="button" onClick={() => openEditForm(p)}>Edit</button>
                  <button type="button" className={styles.verbBad} onClick={() => onDelete(p)}>Delete</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ─── Add button ─── */}
      <button type="button" className={styles.addMore} onClick={openCreateForm} disabled={loading}>
        <span aria-hidden="true">+</span> Add a connection
      </button>

      {/* ─── Create / Edit form modal ─── */}
      {formOpen && (
        <div className={styles.modalBackdrop} onClick={closeForm}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <header className={styles.modalHead}>
              <h2 className={styles.modalTitle}>
                {editingId ? 'Edit connection' : 'Add a connection'}
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
