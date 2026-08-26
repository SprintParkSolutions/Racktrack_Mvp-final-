/**
 * The single source of truth for the app's primary destinations.
 *
 * The sidebar (DesktopShell) and the phone's bottom bar used to each keep
 * their own hardcoded list. They drifted: the sidebar grew to eight
 * role-gated destinations while the bottom bar stayed at three constants,
 * so Lab and Marketplace became unreachable by tapping on a phone — the
 * routes worked, nothing linked to them.
 *
 * Both navigations now read this list, so a destination added here shows up
 * everywhere or nowhere. Add new destinations HERE, not in a component.
 */
import { useAuth } from '../AuthContext.jsx';

/* ── icons ─────────────────────────────────────────────────────────────
   Stroked 24px outlines, sized by the consuming stylesheet. */
const s = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
};

export const HomeIcon = () => (
  <svg {...s}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><path d="M9 21V12h6v9"/></svg>
);
export const ScanIcon = () => (
  <svg {...s}><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
);
export const ProfileIcon = () => (
  <svg {...s}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
);
export const MarketIcon = () => (
  <svg {...s}><path d="M3 7l1.5-3h15L21 7"/><path d="M3 7v12a1 1 0 001 1h16a1 1 0 001-1V7"/><path d="M8 7v3a4 4 0 008 0V7"/></svg>
);
export const DashboardIcon = () => (
  <svg {...s}><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 4-6"/></svg>
);
export const DataSourcesIcon = () => (
  <svg {...s}><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>
);
export const TwoRackIcon = () => (
  <svg {...s}><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/><path d="M10 8h4"/></svg>
);
export const LabIcon = () => (
  <svg {...s}><path d="M9 3v6.5L4.5 18A2 2 0 006.3 21h11.4a2 2 0 001.8-3L15 9.5V3"/><path d="M8 3h8"/><path d="M7.5 14h9"/></svg>
);
export const GroundTruthIcon = () => (
  <svg {...s}><circle cx="12" cy="12" r="9"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>
);
export const OrgIcon = () => (
  <svg {...s}><path d="M3 21h18"/><path d="M5 21V6a1 1 0 011-1h6a1 1 0 011 1v15"/><path d="M13 21V10a1 1 0 011-1h4a1 1 0 011 1v11"/><path d="M8 9h1M8 13h1M8 17h1M16 13h.5M16 17h.5"/></svg>
);
export const HelpIcon = () => (
  <svg {...s}><circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.9 2.9 0 015.6 1c0 2-2.8 2.6-2.8 4"/><circle cx="12" cy="17.4" r="1" fill="currentColor" stroke="none"/></svg>
);
export const ContactIcon = () => (
  <svg {...s}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>
);
export const MoreIcon = () => (
  <svg {...s}><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>
);

/* ── the destinations ──────────────────────────────────────────────────
   `inBar` marks the four that get a permanent slot in the phone's bottom
   bar; an item may also set `barLabel` for a shorter name there than the
   sidebar uses. Everything else lives behind More on a phone and in the
   sidebar on a tablet or desktop — same list, same order, same role gating. */
export function usePrimaryNav() {
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const isAdmin = isOwner || user?.role === 'org_admin';

  return [
    { to: '/',               label: 'Home',         icon: <HomeIcon />,        end: true,  inBar: true },
    { to: '/scan',           label: 'Scan',         icon: <ScanIcon />,        end: false, inBar: true },
    // In the phone's bottom bar as well as the sidebar. It used to be behind
    // "More", and testers reported not knowing the mode existed at all —
    // the scan page deliberately has no two-rack card (one home for the entry),
    // so a hidden menu item was the ONLY way in. `barLabel` keeps the bar
    // legible: "TWO RACKS" is too wide for a fifth 10px slot on a 320px phone,
    // where "2 RACKS" fits.
    { to: '/multi-rack/new', label: 'Two racks',    icon: <TwoRackIcon />,     end: false,
      inBar: true, barLabel: '2 Racks',
      hint: 'Scan two racks together' },
    // Organization Console — manage organizations, members and sites. Owner
    // and org-admin only. This used to be reachable ONLY from the Profile
    // page, so on a tablet it was missing from the sidebar entirely and on a
    // phone it was missing from the More menu. Putting it in the shared list
    // makes it show in both, from one definition.
    ...(isAdmin ? [{ to: '/organizations', label: 'Organizations', icon: <OrgIcon />, end: false,
      hint: 'Organizations, members and sites' }] : []),
    // Operations Console (live ops + server logs) — owner-only.
    ...(isOwner ? [{ to: '/dashboard', label: 'Console', icon: <DashboardIcon />, end: false,
      hint: 'Live operations and server logs' }] : []),
    // EVE-NG lab switches — owner-only while the Cisco path is shaken out.
    ...(isOwner ? [{ to: '/lab', label: 'Lab', icon: <LabIcon />, end: false,
      hint: 'Live switches in the test lab' }] : []),
    // Ground Truth is no longer a standalone destination — it's now a per-scan
    // step reached from a rack's results after analyse (/ground-truth/:rackId),
    // scoped to that one upload. See the rack context nav in DesktopShell.
    // Data Sources (ServiceNow / NetBox / Orion …) and Marketplace are
    // organization-admin features.
    ...(isAdmin ? [{ to: '/connections', label: 'Data Sources', icon: <DataSourcesIcon />, end: false,
      hint: 'Connect ServiceNow, NetBox and others' }] : []),
    ...(isAdmin ? [{ to: '/marketplace', label: 'Marketplace', icon: <MarketIcon />, end: false,
      hint: 'Buy and sell hardware' }] : []),
    { to: '/help',           label: 'Ask DOT',      icon: <HelpIcon />,        end: false,
      hint: 'Answers from verified documentation' },
    // Contact support — reachable directly (not only via DOT's hand-off).
    // Available to everyone; shows in the sidebar and the phone's Menu.
    { to: '/contact',        label: 'Contact',      icon: <ContactIcon />,     end: false,
      hint: 'Email the RackTrack support team' },
    { to: '/profile',        label: 'Profile',      icon: <ProfileIcon />,     end: false, inBar: true },
  ];
}
