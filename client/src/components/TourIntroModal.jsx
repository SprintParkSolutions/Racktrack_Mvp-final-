import { useState } from 'react';
import { useTour } from '../TourContext.jsx';
import useModalA11y from '../hooks/useModalA11y.js';
import styles from './TourIntroModal.module.css';
import GuideBot from './GuideBot.jsx';
// The RackTrack mascot, replacing the two-PNG robot testers found off-putting
// ("bot design must be change its not giving good vibe", "the guide bot
// scary"). GuideBot renders the 3D model where the device supports it and the
// flat SVG where it does not — both honour prefers-reduced-motion, which the
// PNG pair never did.

// First-run prompt: "New to RackTrack?" Yes/No, then (on Yes) a short
// welcome + "Get Started" that kicks off the step-by-step walkthrough.
export default function TourIntroModal() {
  const { showIntro, dismissIntro, startTour } = useTour();
  const [stage, setStage] = useState('ask'); // 'ask' | 'welcome'

  // Escape closes it, Tab stays inside it, focus returns where it came from,
  // and the page behind stops scrolling — the same contract every other dialog
  // in the app honours (MoreSheet, CmdbApprovalModal, OrgConsolePage). The
  // hook must run before the early return below.
  const panelRef = useModalA11y(dismissIntro, { active: showIntro });

  if (!showIntro) return null;

  return (
    <div className={styles.backdrop}>
      <div ref={panelRef} className={styles.panel}
           role="dialog" aria-modal="true" aria-labelledby="rt-tour-intro-heading">
        {/* Anchored to the card's bottom-left corner, entirely below it —
            not layered on top of the card's own content. */}
        <div className={styles.mascot} aria-hidden="true">
          <GuideBot framing="full" className={styles.mascotBody} />
        </div>
        {stage === 'ask' ? (
            <>
              <p className={styles.eyebrow}>Welcome</p>
              <h2 id="rt-tour-intro-heading" className={styles.heading}>New to RackTrack?</h2>
              <p className={styles.body}>
                We can walk you through scanning your first rack, step by step.
              </p>
              <div className={styles.actions}>
                <button className="btn btn-ghost btn-full" onClick={dismissIntro}>
                  No, I'm good
                </button>
                <button className="btn btn-primary btn-full" onClick={() => setStage('welcome')}>
                  Yes, show me
                </button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.eyebrow}>Quick tour</p>
              <h2 id="rt-tour-intro-heading" className={styles.heading}>Let's scan your first rack</h2>
              <p className={styles.body}>
                We'll highlight what to tap, one step at a time - upload a photo,
                analyze it, then find a port. Tap the highlighted control on each
                screen to move to the next step.
              </p>
              <div className={styles.actions}>
                <button className="btn btn-ghost btn-full" onClick={dismissIntro}>
                  Skip for now
                </button>
                <button className="btn btn-primary btn-full" onClick={startTour}>
                  Get Started
                </button>
              </div>
            </>
          )}
      </div>
    </div>
  );
}
