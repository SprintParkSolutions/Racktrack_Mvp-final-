import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import styles from './HomePage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useTheme } from '../ThemeContext.jsx';
import { useAuth } from '../AuthContext.jsx';
import HomeHero from './HomeHero.jsx';

/* ──────────────────────────────────────────────────────────────────────
   HomePage — RackTrack, modelled on the EV app reference

   Views (user-controlled):
     home      — light/cream, greeting + rack card + uptime + DC map
     controls  — dark, rack centred + tile grid (Uptime/Temp/Net/Lock/Maint)
     alert     — red glow + alert pins on rack + 2 mild issues card
     network   — dark, rack at centre with named nodes + stats
     map       — dark, datacenter route + DC list

   The rack is a real CSS-3D object (no PNG) — it tilts as a stack of unit
   panels (switches, firewall, servers, PDU) and rotates via --rot-y.
   ────────────────────────────────────────────────────────────────────── */

const Back   = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>);
const ChevL  = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="15 18 9 12 15 6"/></svg>);
const ChevR  = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="9 18 15 12 9 6"/></svg>);
const Bolt   = (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M13 2L3 14h7l-1 8 11-14h-7l0-6z"/></svg>);
const Bell   = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 8H4c0-2 2-3 2-8z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>);
const ArrowR = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>);
const IcCamera = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="4"/></svg>);

/* ─── Real CSS 3D rack ─────────────────────────────────────────────────
   The whole rack is a stack of unit panels rendered in 3D. The
   parent's --rot-y rotates them; each panel has a back/side face
   via pseudo-elements so depth is visible from any angle.
   ──────────────────────────────────────────────────────────────────── */
function Rack3D({ active, port }) {
  return (
    <div className={styles.rack3d}>
      {/* Frame edges (top + side bars to suggest the rack chassis) */}
      <div className={styles.rackFrameTop} aria-hidden="true" />
      <div className={styles.rackFrameSide} aria-hidden="true" />
      <div className={styles.rackFrameBase} aria-hidden="true" />

      {/* Unit stack — rendered top-down */}
      <div className={styles.rackStack}>
        {/* 1U switch — S-48 */}
        <div className={`${styles.u} ${styles.uSwitch} ${active === 'S-48' ? styles.uActive : ''}`} data-unit="S-48">
          <div className={styles.uFace}>
            <div className={styles.uTag}>S-48</div>
            <div className={styles.uPorts}>
              {Array.from({ length: 24 }).map((_, i) => {
                const isTarget = active === 'S-48' && port === i + 1;
                return (
                  <span
                    key={i}
                    className={`${styles.uPort} ${isTarget ? styles.uPortTarget : ''}`}
                    style={{ animationDelay: `${(i * 80) % 2400}ms` }}
                  />
                );
              })}
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 1U switch — S-24 */}
        <div className={styles.u}>
          <div className={styles.uFace}>
            <div className={styles.uTag}>S-24</div>
            <div className={styles.uPorts}>
              {Array.from({ length: 12 }).map((_, i) => (
                <span key={i} className={styles.uPort} style={{ animationDelay: `${(i * 110) % 2400}ms` }} />
              ))}
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 2U blank / cable management */}
        <div className={`${styles.u} ${styles.uBlank} ${styles.u2}`}>
          <div className={styles.uFace}>
            <div className={styles.uVent} />
            <div className={styles.uVent} />
            <div className={styles.uVent} />
          </div>
        </div>

        {/* 1U firewall — F-20 */}
        <div className={`${styles.u} ${styles.uFirewall} ${active === 'F-20' ? styles.uActive : ''}`} data-unit="F-20">
          <div className={styles.uFace}>
            <div className={styles.uTag}>F-20</div>
            <div className={styles.uScreen}>
              <span className={styles.uScreenBlip} />
              <span className={styles.uScreenBlip} />
              <span className={styles.uScreenBlip} />
            </div>
            <div className={`${styles.uLed} ${styles.uLedAmber}`} />
          </div>
        </div>

        {/* 1U server */}
        <div className={`${styles.u} ${styles.uServer}`}>
          <div className={styles.uFace}>
            <div className={styles.uDisks}>
              <span/><span/><span/><span/><span/><span/>
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 1U server */}
        <div className={`${styles.u} ${styles.uServer}`}>
          <div className={styles.uFace}>
            <div className={styles.uDisks}>
              <span/><span/><span/><span/><span/><span/>
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 2U PDU — PDU-A (warn state) */}
        <div className={`${styles.u} ${styles.u2} ${styles.uPdu} ${active === 'PDU-A' ? styles.uActive : ''}`} data-unit="PDU-A">
          <div className={styles.uFace}>
            <div className={styles.uTag}>PDU-A</div>
            <div className={styles.uOutlets}>
              {Array.from({ length: 6 }).map((_, i) => {
                const isTarget = active === 'PDU-A' && port === i + 1;
                return (
                  <span
                    key={i}
                    className={`${styles.uOutlet} ${isTarget ? styles.uOutletTarget : ''}`}
                  />
                );
              })}
            </div>
            <div className={`${styles.uLed} ${styles.uLedAmber}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* Racks the user can swipe between, modelled on the real RackTrack
   data: short ID + role label, capacity (U-units + active ports), DC.
   Each rack carries its open ServiceNow incident — the same one is
   threaded through every view. Device IDs use the real
   U-XX-CLASS-NN format from ResultsPage (U01-SW01 etc). */
const RACKS = [
  {
    id: 'R-101', role: 'Core',     u: 24, ports: 48, dc: 'Chennai-DC1',
    devices: [
      { tag: 'U01-SW01', name: 'Catalyst 9300',     ports: 24, status: 'ok'   },
      { tag: 'U02-SW02', name: 'Catalyst 9200',     ports: 12, status: 'ok'   },
      { tag: 'U05-FW01', name: 'Firewall · HA',     ports: 8,  status: 'ok'   },
      { tag: 'U07-PP01', name: 'Patch panel · 48p', ports: 48, status: 'ok'   },
      { tag: 'U10-PDU01', name: 'PDU · 6× 120V',    ports: 6,  status: 'warn' },
    ],
    incident: {
      number: 'INC0042', priority: 'P3',
      device: 'U01-SW01', port: 14,
      summary: 'Port 14 link flapping · 4% packet loss',
      cmdb: { state: 'open', summary: { added_devices: 0, changed_devices: 1, added_ports: 0 }, opened: '2h ago' },
    },
  },
  {
    id: 'R-102', role: 'Edge A',   u: 24, ports: 24, dc: 'Chennai-DC1',
    devices: [
      { tag: 'U01-SW01', name: 'Edge switch',       ports: 12, status: 'ok' },
      { tag: 'U03-PP01', name: 'Patch panel · 24p', ports: 24, status: 'ok' },
    ],
    incident: null,
  },
  {
    id: 'R-103', role: 'Edge B',   u: 24, ports: 24, dc: 'Hyderabad-DC2',
    devices: [
      { tag: 'U01-SW01', name: 'Edge switch',       ports: 24, status: 'warn' },
      { tag: 'U06-PP01', name: 'Patch panel · 48p', ports: 48, status: 'ok'   },
    ],
    incident: {
      number: 'INC0058', priority: 'P2',
      device: 'U01-SW01', port: 14,
      summary: 'Port 14 link flapping · 4% packet loss',
      cmdb: { state: 'open', summary: { added_devices: 0, changed_devices: 0, added_ports: 0 }, opened: '14m ago' },
    },
  },
];

/* The SCREENS that loop when you tap the rack:
     home → controls → scan → network → alert → home → ...
   The 3 feature screens (scan/network/alert) are also reachable
   directly by tapping their tile in controls. */
const SCREENS    = ['home', 'controls', 'scan', 'alert'];
const FLOW       = ['scan', 'alert'];
/* Each non-home view is one step of a simple 3-step workflow that
   the user walks through — see the problem, find the device, fix it. */
const STEP_LABEL = {
  controls: 'Step 1 · See the issue',
  scan:     'Step 2 · Find the device',
  alert:    'Step 3 · Locate the port',
};

export default function HomePage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const auth = useAuth();
  const userName =
    (auth?.user?.username) ||
    (auth?.user?.name) ||
    (auth?.user?.email && String(auth.user.email).split('@')[0]) ||
    'Engineer';
  const logoSrc = theme === 'light' ? '/white_logo.png' : '/dark_logo.png';

  const [view, setView] = useState('home');
  const [idx, setIdx]   = useState(0);
  const [rotY, setRotY] = useState(0);
  const dragRef = useRef({ active: false, startX: 0, base: 0, moved: 0 });
  const rack = RACKS[idx];

  const goView = (v) => () => setView(v);
  const goPrev = () => setIdx((i) => (i - 1 + RACKS.length) % RACKS.length);
  const goNext = () => setIdx((i) => (i + 1) % RACKS.length);

  /* Linear flow through the 5 in-page views */
  const flowIdx = FLOW.indexOf(view);
  const inFlow  = flowIdx !== -1;

  /* Tap on the rack ⇒ advance through all 5 SCREENS in a loop:
       home → controls → scan → network → alert → home → ...
     Drag still rotates; we use the moved-distance to distinguish. */
  const advanceOnTap = () => {
    const i = SCREENS.indexOf(view);
    setView(SCREENS[(i + 1) % SCREENS.length]);
  };

  /* Drag-to-rotate the 3D rack — also detects tap-without-drag */
  const onPointerDown = (e) => {
    dragRef.current = { active: true, startX: e.clientX, base: rotY, moved: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.active) return;
    const delta = e.clientX - d.startX;
    d.moved = Math.max(d.moved, Math.abs(delta));
    setRotY(Math.max(-32, Math.min(32, d.base + delta * 0.30)));
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    d.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setRotY(0); /* spring back via CSS transition */
    /* If pointer barely moved, treat as a tap → advance the flow */
    if (d.moved < 6) advanceOnTap();
  };

  /* When view changes, reset rotation */
  useEffect(() => { setRotY(0); }, [view]);

  /* iPad + desktop (>=768px) get the editorial HomeStudio welcome — a
     centred, full-viewport, no-scroll hero with fine line-art. Phones stay
     on the clean, simple HomeLight welcome, untouched. */
  // One home for every screen — the light two-column hero: the claim on the
  // left, a real rack on the right with its scan read out over the photo.
  // Replaces the dark full-bleed HomeImmersive, which is kept in the tree
  // alongside the other home variants.
  return <HomeHero />;

}
