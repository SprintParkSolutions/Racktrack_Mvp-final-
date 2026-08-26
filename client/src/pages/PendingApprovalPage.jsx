import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';

// Shown to a logged-in user whose organization is still awaiting the platform
// owner's approval (self-signup creates a 'pending' org). It blocks the rest of
// the app and polls /api/auth/me; the moment the owner approves (status ->
// 'active') the user is moved into the app.
export default function PendingApprovalPage() {
  const { user, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const timer = useRef(null);

  const orgName = user?.organization?.name || user?.tenant?.name || 'your organization';
  const status = user?.organization?.status || 'pending';
  const isPending = status === 'pending';

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const u = await refreshUser();
      if (u && u.organization?.status === 'active') {
        navigate('/scan', { replace: true });   // approved / reactivated → into the app
      }
    } finally {
      setChecking(false);
    }
  }, [refreshUser, navigate]);

  // Keep polling so approval / reactivation lets the user in automatically.
  useEffect(() => {
    check();
    timer.current = setInterval(check, 12000);
    return () => clearInterval(timer.current);
  }, [check]);

  const signOut = () => { logout(); navigate('/', { replace: true }); };

  // Per-status content.
  const content = isPending
    ? {
        title: 'Waiting for approval',
        body: <>Your request to create <b>{orgName}</b> has been sent to the platform owner.
              You’ll be let in as soon as they approve it - this usually doesn’t take long.</>,
        sub: 'This page checks automatically every few seconds.',
      }
    : status === 'rejected'
    ? {
        title: 'Request not approved',
        body: <>Your request to create <b>{orgName}</b> was not approved by the platform owner.
              If you think this is a mistake, please contact them.</>,
        sub: null,
      }
    : {
        title: 'Organization deactivated',
        body: <><b>{orgName}</b> has been deactivated by the platform owner, so the app is
              paused for now. It will come back automatically if they reactivate it.</>,
        sub: null,
      };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.badge}>RACKTRACK</div>
        {isPending
          ? <div style={S.spinner} aria-hidden />
          : <div style={S.blocked} aria-hidden>!</div>}
        <h1 style={S.h1}>{content.title}</h1>
        <p style={S.p}>{content.body}</p>
        {content.sub && <p style={S.sub}>{content.sub}</p>}

        {isPending && (
          <button style={S.primary} onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
        <button style={isPending ? S.ghost : S.primary} onClick={signOut}>Sign out</button>
      </div>
      <style>{`@keyframes rtspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// No colour accent in this app — ink does the accenting.
const BLUE = '#121212';
const S = {
  wrap: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--ground, #ffffff)', padding: '24px', fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif" },
  card: { background: 'var(--raised, #fff)', borderRadius: 18, padding: '40px 32px', maxWidth: 420, width: '100%',
    textAlign: 'center', boxShadow: 'var(--lift)' },
  badge: { display: 'inline-block', fontSize: 11, letterSpacing: '.2em', fontWeight: 700,
    color: BLUE, background: '#f2f2f2', padding: '5px 12px', borderRadius: 20, marginBottom: 20 },
  spinner: { width: 44, height: 44, margin: '0 auto 20px', borderRadius: '50%',
    border: '4px solid #e5e5e5', borderTopColor: BLUE, animation: 'rtspin 1s linear infinite' },
  blocked: { width: 46, height: 46, margin: '0 auto 20px', borderRadius: '50%',
    background: '#efefef', color: '#c0392b', fontSize: 26, fontWeight: 800,
    display: 'flex', alignItems: 'center', justifyContent: 'center' },
  h1: { margin: '0 0 10px', fontSize: 22, fontWeight: 750, color: '#232323' },
  p: { margin: '0 0 8px', color: '#545454', fontSize: 15, lineHeight: 1.6 },
  sub: { margin: '0 0 24px', color: '#929292', fontSize: 13 },
  primary: { width: '100%', padding: '13px', border: 0, borderRadius: 12, background: BLUE,
    color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 10 },
  ghost: { width: '100%', padding: '12px', border: '1px solid #dddddd', borderRadius: 12,
    background: '#fff', color: '#666666', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
};
