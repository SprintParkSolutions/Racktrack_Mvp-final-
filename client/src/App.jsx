import { useEffect, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { parseAuthFragment, isAuthCallbackUrl } from './utils/socialSession';
import BottomNav from './components/BottomNav.jsx';
import DesktopShell from './components/DesktopShell.jsx';
import PointerGlow from './components/PointerGlow.jsx';
import RouteBoundary from './components/RouteBoundary.jsx';
import { useHasSidebar } from './hooks/useIsDesktop';
import HomePage from './pages/HomePage.jsx';
import ScanPage from './pages/ScanPage.jsx';
import ResultsPage from './pages/ResultsPage.jsx';
import RackResultsRoute from './pages/RackResultsRoute.jsx';
import { RackSwitchesRoute, RackNetworkRoute, RackPortsRoute } from './pages/SideBySideRacks.jsx';
import RackTopologyRoute from './pages/RackTopologyRoute.jsx';
import PortsPage from './pages/PortsPage.jsx';
import SwitchTestPage from './pages/SwitchTestPage.jsx';
import TopologyPage from './pages/TopologyPage.jsx';
import NetdiscoPage from './pages/NetdiscoPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import HelpPage from './pages/HelpPage.jsx';
import ContactPage from './pages/ContactPage.jsx';
import LogoCompare from './pages/LogoCompare.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import AcceptInvitePage from './pages/AcceptInvitePage.jsx';
import PendingApprovalPage from './pages/PendingApprovalPage.jsx';
import ForgotPasswordPage from './pages/ForgotPasswordPage.jsx';
import AuthCallbackPage from './pages/AuthCallbackPage.jsx';
import SwitchInformationPage from './pages/SwitchInformationPage.jsx';
import MultiRackRedirect from './pages/MultiRackRedirect.jsx';
import PortHistoryPage from './pages/PortHistoryPage.jsx';
import LabPage from './pages/LabPage.jsx';
import GroundTruthPage from './pages/GroundTruthPage.jsx';
import TenantMatPage from './pages/TenantMatPage.jsx';
import ConnectionsPage from './pages/ConnectionsPage.jsx';
// ── Deferred routes ──────────────────────────────────────────────────
// Everything below loads on navigation rather than at startup.
//
// MultiRackTopologyPage imports three.js, @react-three/fiber and drei at the
// top level, so importing it eagerly put the entire 3D engine in front of the
// login form — every user paid for it to reach a page most never open. The
// Marketplace cluster is admin-only, so ordinary members were downloading
// seven pages they cannot navigate to.
const MultiRackTopologyPage = lazy(() => import('./pages/MultiRackTopologyPage.jsx'));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage.jsx'));
const MarketplaceNewPage = lazy(() => import('./pages/MarketplaceNewPage.jsx'));
const MarketplaceCheckoutPage = lazy(() => import('./pages/MarketplaceCheckoutPage.jsx'));
const MarketplaceOrdersPage = lazy(() => import('./pages/MarketplaceOrdersPage.jsx'));
const MarketplaceAlertsPage = lazy(() => import('./pages/MarketplaceAlertsPage.jsx'));
const MarketplaceDashboardPage = lazy(() => import('./pages/MarketplaceDashboardPage.jsx'));
const MarketplacePartnerAccountsPage = lazy(() => import('./pages/MarketplacePartnerAccountsPage.jsx'));
import OrgConsolePage from './pages/OrgConsolePage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import MultiRackNewPage from './pages/MultiRackNewPage.jsx';
import { ShutterProvider } from './ShutterContext.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { getPendingScan, clearPendingScan, fetchScanJob } from './utils/pendingScan';
import { TourProvider } from './TourContext.jsx';
import TourIntroModal from './components/TourIntroModal.jsx';
import TourOverlay from './components/TourOverlay.jsx';
import { ConnectionsProvider } from './ConnectionsContext.jsx';
import { ThemeProvider } from './ThemeContext.jsx';

// Bounces unauthenticated visitors to /login, remembering where they were
// trying to go so we can send them back after login/signup.
// Development-only tripwire. index.css hides overflow-x on body / #root so any
// element that lays out wider than the viewport is silently CLIPPED instead of
// producing a scrollbar — which is how the "content is off screen" bugs reach
// testers unseen. This measures the page after each navigation and on resize
// and warns when something exceeds its container, so the next overflow shows up
// in a developer's console first. Gated on import.meta.env.DEV: never ships.
function OverflowGuard() {
  const location = useLocation();
  useEffect(() => {
    let raf1;
    let raf2;
    const check = () => {
      const root = document.getElementById('root');
      if (!root) return;
      const nodes = [root, ...Array.from(root.children)];
      for (const el of nodes) {
        if (!el || typeof el.scrollWidth !== 'number') continue;
        // 1px slack absorbs sub-pixel rounding on fractional-DPR screens.
        if (el.scrollWidth > el.clientWidth + 1) {
          const cls = typeof el.className === 'string' && el.className
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';
          console.warn(
            `[RackTrack] horizontal overflow on ${location.pathname}: ` +
            `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}> ` +
            `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}. ` +
            'Something is wider than the viewport and is being clipped, not scrolled.',
          );
        }
      }
    };
    // Two rAFs: let the route commit and lay out before measuring.
    raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(check); });
    window.addEventListener('resize', check);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', check);
    };
  }, [location.pathname]);
  return null;
}

// True when the signed-in user's organization is NOT active — pending owner
// approval, rejected, or deactivated. Owners have no org and are never gated.
// Such users are held on the /pending screen (which explains the exact state)
// instead of being let into an app they can't actually use.
function orgNotActive(user) {
  const s = user?.organization?.status;
  return user?.role !== 'owner' && !!s && s !== 'active';
}

function ProtectedRoute({ children }) {
  const { isAuthed, user } = useAuth();
  const location = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (orgNotActive(user)) {
    return <Navigate to="/pending" replace />;
  }
  return children;
}

// Integrations + Marketplace are organization-admin features (only the admin
// manages connected systems and sells surplus gear). Everyone else is sent home.
function AdminRoute({ children }) {
  const { isAuthed, user } = useAuth();
  const location = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (orgNotActive(user)) {
    return <Navigate to="/pending" replace />;
  }
  if (user?.role !== 'org_admin' && user?.role !== 'owner') {
    return <Navigate to="/" replace />;
  }
  return children;
}

// Ground Truth is owner-only for now. To open it to every role later, swap
// <OwnerRoute> for <ProtectedRoute> on its route and drop the isOwner wrap on
// its nav entry — the server queries are already role-scoped.
function OwnerRoute({ children }) {
  const { isAuthed, user } = useAuth();
  const location = useLocation();
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (orgNotActive(user)) {
    return <Navigate to="/pending" replace />;
  }
  if (user?.role !== 'owner') {
    return <Navigate to="/" replace />;
  }
  return children;
}

// The /pending waiting screen: only for a signed-in user whose org is pending.
// If they're not authed -> login; if their org is already active -> into the app.
function PendingRoute({ children }) {
  const { isAuthed, user } = useAuth();
  if (!isAuthed) return <Navigate to="/login" replace />;
  if (!orgNotActive(user)) return <Navigate to="/scan" replace />;
  return children;
}

// Gate for the guided tour. The walkthrough drives the user through
// /scan → /results, so it only makes sense for someone who can actually
// reach those pages: signed in, with an active organization. Held back on
// the sign-in / pending screens, where the prompt would cover the form the
// user is trying to fill in.
function TourGate() {
  const { isAuthed, user } = useAuth();
  if (!isAuthed || orgNotActive(user)) return null;
  return (
    <>
      <TourIntroModal />
      <TourOverlay />
    </>
  );
}

// Responsive layout wrapper — at ≥1024px viewports every page renders
// inside DesktopShell (sidebar + topbar + full-width main canvas).
// Below the breakpoint the page renders bare, exactly as the mobile
// build does today — so the mobile experience is untouched.
function ResponsiveLayout({ children, withBottomNav = false }) {
  const showSidebar = useHasSidebar();
  if (showSidebar) {
    return <DesktopShell>{children}</DesktopShell>;
  }
  return <>{children}{withBottomNav && <BottomNav />}</>;
}


// Bridges Android's hardware back button to React Router. Without this, the
// system back closes the WebView activity (kicks user to launcher) instead of
// walking the SPA history. Root pages exit the app explicitly.
function AndroidBackHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let sub;
    (async () => {
      sub = await CapApp.addListener('backButton', () => {
        if (location.pathname === '/' || location.pathname === '/login') {
          CapApp.exitApp();
        } else {
          navigate(-1);
        }
      });
    })();
    return () => { sub?.remove?.(); };
  }, [navigate, location.pathname]);
  return null;
}

// Catches the social sign-in deep link on native.
//
// The web build lands on /auth/callback as a page load; native cannot, because
// the OAuth happens in an in-app browser tab and the app underneath never
// navigated anywhere. Instead the server redirects to
// com.racktrack.app://auth/callback#token=… , the OS hands that to the running
// app as appUrlOpen, and we adopt the session here.
//
// Registered unconditionally at the app root rather than on the login page: the
// tab is a separate process, and on a memory-pressured phone the WebView can be
// reclaimed and rebuilt while it's in front — landing the deep link on a
// freshly mounted tree that was never on /login.
function SocialDeepLinkHandler() {
  const navigate = useNavigate();
  const { adoptSession } = useAuth();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let sub;
    (async () => {
      sub = await CapApp.addListener('appUrlOpen', ({ url }) => {
        if (!isAuthCallbackUrl(url)) return;   // some other deep link — leave it alone
        const result = parseAuthFragment(url);
        if (!result) return;

        // Dismiss the browser tab still sitting over the app. Best-effort: on
        // Android the Custom Tab may already be gone, which throws.
        Browser.close().catch(() => {});

        if (!result.ok) {
          navigate('/login', { replace: true, state: { socialError: result.message } });
          return;
        }
        const user = adoptSession(result.token, result.user);
        navigate(user?.role === 'owner' || user?.role === 'org_admin' ? '/' : '/scan',
          { replace: true });
      });
    })();
    return () => { sub?.remove?.(); };
  }, [adoptSession, navigate]);

  return null;
}

// NOTE: there used to be a ResumeToScan handler here that, on every native
// resume, bounced the user from /results back to /scan "to start fresh". In
// practice that threw away the scan they had just run: switch to another app,
// come back, and their results were gone. Leaving the WebView on whatever page
// the user was on is the correct behaviour — an in-flight scan is separately
// reclaimed by PendingScanResumer below.

// Reclaims a scan that was analyzing when the app got suspended. ScanPage left
// a marker (see utils/pendingScan); here we poll the server for that scan and,
// once it's done, drop the user straight on its results — instead of the empty
// upload screen they'd otherwise see. Runs on cold start (leftover marker) and
// on every native resume.
function PendingScanResumer() {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;
    let sub = null;

    const tryResume = () => {
      const pending = getPendingScan();
      if (!pending || !isAuthed || resuming) return;
      setResuming(true);
      const deadline = Date.now() + 45000;
      const poll = async () => {
        if (cancelled) return;
        const job = await fetchScanJob(pending.id);
        if (cancelled) return;
        if (job.status === 'done' && job.rackId) {
          clearPendingScan(); setResuming(false);
          navigate(`/results/${encodeURIComponent(job.rackId)}`, { replace: true });
          return;
        }
        if (job.status === 'error' || job.status === 'missing') {
          clearPendingScan(); setResuming(false);
          return;   // fall back to whatever screen they're on (usually /scan)
        }
        if (Date.now() > deadline) { setResuming(false); return; }  // keep marker; let them retry
        pollTimer = setTimeout(poll, 1500);   // 'running' or transient error — keep waiting
      };
      poll();
    };

    tryResume();  // cold start with a leftover marker
    if (Capacitor.isNativePlatform()) {
      (async () => { sub = await CapApp.addListener('resume', () => tryResume()); })();
    }
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer); sub?.remove?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  if (!resuming) return null;
  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '18px', background: 'rgba(0, 0, 0,0.82)', backdropFilter: 'blur(6px)',
      color: '#efefef', textAlign: 'center',
      padding: 'max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left))',
    }}>
      <div style={{
        width: '46px', height: '46px', borderRadius: '50%',
        border: '3px solid rgba(255,255,255,0.18)', borderTopColor: '#5fa0ff',
        animation: 'rtspin 0.8s linear infinite',
      }} />
      <div style={{ fontSize: '16px', fontWeight: 600 }}>Bringing your scan back&hellip;</div>
      <div style={{ fontSize: '13.5px', opacity: 0.7, maxWidth: '32ch' }}>
        We&rsquo;re finishing the analysis you started. This takes a moment.
      </div>
      <style>{`@keyframes rtspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <ConnectionsProvider>
          <ShutterProvider>
            <AndroidBackHandler />
            <SocialDeepLinkHandler />
            <PendingScanResumer />
            <PointerGlow />
            {/* Stale rack images (a token that expired while the page sat open,
                or a first paint before the token landed) are handled per-image
                by the AssetImg component, which re-mints and retries on a 404. */}
            {import.meta.env.DEV && <OverflowGuard />}
            {/* Per-route boundary INSIDE the shell: a chunk-load failure or a
                render error in one route is contained here instead of unmounting
                the whole app at the root boundary. Deferred routes suspend while
                their chunk loads; the fallback is deliberately quiet — a spinner
                that flashes for 80 ms on a warm connection reads as jank. */}
            {/* The tour spotlights real controls on /scan and /results, so the
                pages themselves call useTour() — the provider has to be above
                the router outlet, not beside it. TourGate renders last so that
                the intro card and the dim layer win any z-index tie against
                page chrome painted before them. */}
            <TourProvider>
            <RouteBoundary>
            <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
            <Routes>
            {/* HomePage has its own desktop branch (HomeDesktop) via
                useIsDesktop, so DesktopShell is bypassed for "/" —
                otherwise we'd double-render the chrome. */}
            <Route path="/" element={<ProtectedRoute><HomePage /></ProtectedRoute>} />
            <Route path="/login"  element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/invite/:code" element={<AcceptInvitePage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            {/* Where the server drops the browser after a social sign-in.
                Native uses the same path via a custom-scheme deep link, which
                SocialDeepLinkHandler intercepts before routing gets involved. */}
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="/pending" element={<PendingRoute><PendingApprovalPage /></PendingRoute>} />
            <Route path="/scan" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><ScanPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Two-rack scan: pick 2 images (or a video) → detect both →
                combined topology with the uplinks that cross between racks.
                Static segment, so it out-ranks /multi-rack/:groupId. */}
            <Route path="/multi-rack/new" element={
              <ProtectedRoute><ResponsiveLayout><MultiRackNewPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Legacy multi-rack landing → redirect to first member rack's
                Ports page (the rack-tabs strip there lets the user reach
                every other rack in the group + the combined 3D topology). */}
            <Route path="/multi-rack/:groupId" element={
              <ProtectedRoute><MultiRackRedirect /></ProtectedRoute>
            } />
            <Route path="/multi-rack/:groupId/topology" element={
              <ProtectedRoute><ResponsiveLayout><MultiRackTopologyPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* RackTrack Assist — the full-screen help page. The floating
                panel covers mid-task questions; this is the destination. */}
            <Route path="/help" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><HelpPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Contact support — where "Reach a person" (from DOT) lands. */}
            <Route path="/contact" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><ContactPage /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/profile" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><ProfilePage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Organization console — owner (platform) + org_admin manage
                Organizations → Sites → Members. Renders inside the shell
                (sidebar) on tablet/desktop like every other page; it keeps its
                own header because it needs a back button for org→list. */}
            <Route path="/organizations" element={
              <ProtectedRoute><ResponsiveLayout><OrgConsolePage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Live operations dashboard — owner-gated on the server; the page
                itself shows a clear message if a non-owner reaches it. */}
            <Route path="/dashboard" element={
              <AdminRoute><ResponsiveLayout><DashboardPage /></ResponsiveLayout></AdminRoute>
            } />
            {/* Logs are now a tab inside the Operations Console; keep the old
                path working for existing bookmarks. */}
            <Route path="/logs" element={<Navigate to="/dashboard" replace />} />
            <Route path="/connections" element={
              <AdminRoute><ResponsiveLayout><ConnectionsPage /></ResponsiveLayout></AdminRoute>
            } />
            {/* Switch test — the phone talking SNMP to a switch directly,
                instead of asking the server to (which cannot reach a switch
                inside a customer's network). One build, one question. Open to
                any signed-in tester: the whole point is getting it in front of
                people standing next to real switches. */}
            <Route path="/switch-test" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><SwitchTestPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Ground Truth — technicians verify what the model detected.
                Owner-only for now (OwnerRoute); the page also refuses non-owners
                and the server API is requireRole('owner'). */}
            {/* Per-scan now: reached from a rack's results after analyse, scoped
                to that one upload (/ground-truth/:rackId). */}
            <Route path="/ground-truth/:rackId" element={
              <OwnerRoute><ResponsiveLayout withBottomNav><GroundTruthPage /></ResponsiveLayout></OwnerRoute>
            } />
            {/* Marketplace — restricted to Admin / Owner only. */}
            <Route path="/marketplace" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplacePage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/new" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceNewPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/checkout/:listingId" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceCheckoutPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/orders" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceOrdersPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/orders/:orderId" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceOrdersPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/alerts" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceAlertsPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/dashboard" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplaceDashboardPage /></ResponsiveLayout></AdminRoute>
            } />
            <Route path="/marketplace/partners" element={
              <AdminRoute><ResponsiveLayout withBottomNav><MarketplacePartnerAccountsPage /></ResponsiveLayout></AdminRoute>
            } />
            {/* CMDB-driven switch list. /switch-info reads rackId from
                location.state; /switch-info/:rackId is the deep-link form. */}
            <Route path="/switch-info" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><SwitchInformationPage /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/switch-info/:rackId" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><RackSwitchesRoute /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* The full scan archive — searchable, filtered and paged. Profile
                keeps the five most recent and links here for the rest. */}
            <Route path="/history" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><HistoryPage /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/results" element={
              <ProtectedRoute><ResponsiveLayout><ResultsPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Deep-linkable variant — when state.result is absent (cold link
                or rack-tab switch in a multi-rack scan), ResultsPage uses
                useParams + /api/scan/:rackId to populate itself. */}
            <Route path="/results/:rackId" element={
              <ProtectedRoute><ResponsiveLayout><RackResultsRoute /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/results/:rackId/ports" element={
              <ProtectedRoute><ResponsiveLayout><RackPortsRoute /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/results/:rackId/topology" element={
              <ProtectedRoute><ResponsiveLayout><RackTopologyRoute /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/results/:rackId/netdisco" element={
              <ProtectedRoute><ResponsiveLayout><RackNetworkRoute /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/port-history" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><PortHistoryPage /></ResponsiveLayout></ProtectedRoute>
            } />
            {/* Owner-only EVE-NG lab view. The role gate that matters is
                server-side (requireRole('owner') on /api/lab/*); LabPage
                renders a refusal for non-owners so the route isn't a
                confusing blank. */}
            <Route path="/lab" element={
              <ProtectedRoute><ResponsiveLayout withBottomNav><LabPage /></ResponsiveLayout></ProtectedRoute>
            } />
            <Route path="/compare" element={<LogoCompare />} />
            {/* Demo: unified tenant rack-layout view. No auth — backed by
                server/data/demo_tenant.json, isolated from real scan data. */}
            <Route path="/demo/topology" element={<TenantMatPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </RouteBoundary>
            <TourGate />
            </TourProvider>
          </ShutterProvider>
          </ConnectionsProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}
