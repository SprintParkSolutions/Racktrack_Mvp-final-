import { createPortal } from 'react-dom';
import { NavLink, useNavigate } from 'react-router-dom';
import styles from './MoreSheet.module.css';
import useModalA11y from '../hooks/useModalA11y.js';
import { useAuth } from '../AuthContext.jsx';

/**
 * The navigation drawer.
 *
 * It was a bottom sheet titled "Go to" — a flat list with no sense of what
 * belonged with what, and the account nowhere in it. A drawer instead: it
 * comes from the edge, it is grouped, and it ends with who you are signed in
 * as and the way out. That is the shape people already know from every tool
 * they use, and it costs nothing to match it.
 *
 * Grouping is derived from the destinations themselves rather than hardcoded,
 * so a link added to nav/navLinks.jsx lands in the right section without
 * anyone remembering to edit this file too.
 *
 * Portalled to <body> so it escapes #root's 540px cap and is sized against the
 * viewport, not its parent.
 */

const SECTIONS = [
  { key: 'work', title: 'Racks', match: ['/scan', '/multi-rack/new', '/history', '/results'] },
  { key: 'manage', title: 'Manage', match: ['/organizations', '/dashboard', '/lab', '/connections', '/marketplace'] },
  { key: 'help', title: 'Support', match: ['/help', '/contact'] },
];

/** Which section a destination belongs to; anything unmatched goes last. */
function sectionOf(to) {
  const hit = SECTIONS.find((s) => s.match.some((m) => to === m || to.startsWith(`${m}/`)));
  return hit ? hit.key : 'more';
}

/** Initials for the avatar, from whatever name we actually hold. */
function initials(user) {
  const from = user?.username || user?.name || user?.email || '';
  const parts = String(from).replace(/@.*$/, '').split(/[.\s_-]+/).filter(Boolean);
  return (parts[0]?.[0] || 'R').concat(parts[1]?.[0] || '').toUpperCase();
}

export default function MoreSheet({ links, onClose }) {
  // Escape closes, Tab stays inside, and focus moves into the drawer so a
  // keyboard or screen-reader user is not left behind on the button that
  // opened it — and back to that button on close.
  const panelRef = useModalA11y(onClose);
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // Profile is in the footer beside Sign out, so it is not also listed above.
  const listed = links.filter((l) => l.to !== '/profile');
  const grouped = [...SECTIONS, { key: 'more', title: 'More' }]
    .map((s) => ({ ...s, items: listed.filter((l) => sectionOf(l.to) === s.key) }))
    .filter((s) => s.items.length > 0);

  const signOut = () => {
    onClose();
    logout?.();
    navigate('/login', { replace: true });
  };

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <aside
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Who you are, first. A menu that never says which account it is
            acting as is the one people get wrong in a room with two logins. */}
        <header className={styles.head}>
          <button type="button" className={styles.x} onClick={onClose} aria-label="Close menu">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <span className={styles.avatar} aria-hidden="true">{initials(user)}</span>
          <span className={styles.who}>
            <span className={styles.nameRow}>
              <span className={styles.name}>{user?.username || user?.name || 'Signed in'}</span>
              {user?.role && <span className={styles.role}>{user.role}</span>}
            </span>
            <span className={styles.mail}>{user?.email || ''}</span>
          </span>
        </header>

        <div className={styles.scroll}>
          {grouped.map((section) => (
            <nav key={section.key} className={styles.group} aria-label={section.title}>
              <p className={styles.groupTitle}>{section.title}</p>
              {section.items.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  onClick={onClose}
                  className={({ isActive }) => `${styles.row} ${isActive ? styles.rowActive : ''}`}
                >
                  <span className={styles.icon} aria-hidden="true">{l.icon}</span>
                  <span className={styles.text}>
                    <span className={styles.label}>{l.label}</span>
                    {l.hint && <span className={styles.hint}>{l.hint}</span>}
                  </span>
                </NavLink>
              ))}
            </nav>
          ))}
        </div>

        <footer className={styles.foot}>
          <NavLink to="/profile" onClick={onClose} className={styles.footRow}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </NavLink>
          <button type="button" className={`${styles.footRow} ${styles.signOut}`} onClick={signOut}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" />
            </svg>
            Sign out
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
