import { Component, Suspense, lazy, useEffect, useState } from 'react';
import racktrackBot from '../assets/racktrack-bot/racktrack-bot.svg';

// The guide mascot. Renders the 3D model where the device can handle it and
// falls back to the flat SVG where it cannot — same silhouette either way, so
// the layout boxes in TourIntroModal.module.css / TourOverlay.module.css do
// not need to know which one they got.
//
// Everything three.js-shaped lives behind this lazy boundary. A user who never
// opens the tour never downloads the renderer or the ~950KB model.
const GuideBot3D = lazy(() => import('./GuideBot3D.jsx'));

// The SVG stand-in, also used while the model streams in and whenever 3D is
// unavailable. It carries its own float animation, so it is never a dead frame.
function FlatBot({ className }) {
  return <img className={className} src={racktrackBot} alt="" draggable="false" />;
}

// WebGL can be absent (older Android WebViews), disabled by policy, or refused
// because too many contexts are already live. Any of those must degrade to the
// SVG rather than take the tour down with them.
function useCanRender3D() {
  const [ok, setOk] = useState(null);
  useEffect(() => {
    let alive = true;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (alive) setOk(!!gl);
      // Release the probe context immediately; browsers cap how many exist.
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      if (alive) setOk(false);
    }
    return () => { alive = false; };
  }, []);
  return ok;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// A lost WebGL context or a failed model fetch throws during render. Without
// this the whole tour unmounts, which is a far worse outcome than a flat robot.
class BotBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    // eslint-disable-next-line no-console
    console.warn('[GuideBot] 3D mascot unavailable, using the flat one:', err?.message);
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export default function GuideBot({ framing = 'full', className }) {
  const can3D = useCanRender3D();
  const reduced = usePrefersReducedMotion();
  const flat = <FlatBot className={className} />;

  // `null` means the probe has not run yet — show the SVG rather than an
  // empty box, so the mascot never pops in late.
  if (can3D !== true) return flat;

  return (
    <BotBoundary fallback={flat}>
      <Suspense fallback={flat}>
        <GuideBot3D framing={framing} reduced={reduced} />
      </Suspense>
    </BotBoundary>
  );
}
