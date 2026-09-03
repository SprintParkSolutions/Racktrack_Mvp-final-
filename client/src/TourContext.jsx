import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TOUR_STEPS } from './tourSteps.js';
import { useAuth } from './AuthContext.jsx';
import { getItem, setItem } from './utils/safeStorage';

const TourContext = createContext(null);

// Shown once per ACCOUNT: answering the "New to RackTrack?" prompt either way
// (taking the tour, or declining it) is remembered, so it never interrupts a
// returning user again. Storage that throws — blocked site data, full quota —
// degrades to "ask again next load" rather than breaking the app, which is
// what safeStorage guarantees.
//
// The flag used to be one unsuffixed device-wide key, which meant the first
// person to answer the prompt on a phone or browser answered it for everyone
// after them: signing out and signing in with a brand-new account showed no
// tour at all, because nothing about the key or the sign-out path was tied to
// who was asked. Suffixing with the user id is what makes "once per account"
// true. Signed-out callers keep the bare key — TourGate holds the prompt back
// until sign-in anyway, so that branch only exists to keep this total.
const ASKED_PREFIX = 'racktrack:tour-asked';

function askedKey(userId) {
  return userId ? `${ASKED_PREFIX}:${userId}` : ASKED_PREFIX;
}

export function TourProvider({ children }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const storageKey = askedKey(user?.id ?? null);

  const [asked, setAsked] = useState(() => getItem(storageKey) === '1');
  const [active, setActive] = useState(false);
  // The tour steps aside while the app is busy with something the user started
  // from inside it. Analysing a rack is the case that matters: the tour's
  // spotlight and card sat on top of the analysing overlay, hiding the progress
  // bar the user had just triggered, and the tour's own next step is about the
  // result — which does not exist yet. Suspended, not stopped: the walkthrough
  // resumes on the same step the moment the scan finishes.
  const [suspended, setSuspended] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // This provider lives above the router outlet and never unmounts, so the
  // lazy initialiser above runs exactly once for the lifetime of the app — a
  // sign-out / sign-in inside that one session has to re-read storage under
  // the new account's key. Adjusting during render rather than in an effect
  // keeps the intro from flashing for a frame with the previous account's
  // answer (and tears down a walkthrough the previous account left running).
  const [keyInState, setKeyInState] = useState(storageKey);
  if (keyInState !== storageKey) {
    setKeyInState(storageKey);
    setAsked(getItem(storageKey) === '1');
    setActive(false);
    setStepIndex(0);
  }

  const showIntro = !asked;

  const markAsked = useCallback(() => {
    setItem(storageKey, '1');
    setAsked(true);
  }, [storageKey]);

  const dismissIntro = useCallback(() => {
    markAsked();
  }, [markAsked]);

  const startTour = useCallback(() => {
    markAsked();
    setStepIndex(0);
    setActive(true);
    navigate('/scan');
  }, [markAsked, navigate]);

  const stopTour = useCallback(() => {
    setActive(false);
  }, []);

  // Browser/hardware back (and the Android back button, which also drives
  // history via navigate(-1) in AndroidBackHandler) fires a native
  // `popstate` event — stopping the tour here catches all of those in one
  // place, on top of the explicit in-page "Back" buttons calling stopTour()
  // themselves before they navigate.
  // Marks the document while the walkthrough is running so the app's own
  // navigation can be held shut (see index.css).
  //
  // The dim layer only confines the user while a step has a control to point
  // at. Between steps — during an analysis, or while the image-quality prompt
  // is up — there is no spotlight and therefore no dim, and the sidebar and
  // bottom nav stayed live: it was possible to wander off to Data Sources
  // mid-pipeline and leave the tour asking for a control on a page you had
  // left. The point of the walkthrough is to hold you on the pipeline from
  // end to end, so navigation is shut for its duration.
  //
  // Back is deliberately exempt — it carries data-tour-bypass and ends the
  // tour, so there is always a way out.
  useEffect(() => {
    const root = document.documentElement;
    if (active) root.setAttribute('data-tour-active', 'true');
    else root.removeAttribute('data-tour-active');
    return () => root.removeAttribute('data-tour-active');
  }, [active]);

  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    const onPopState = () => { if (activeRef.current) stopTour(); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [stopTour]);

  const advance = useCallback(() => {
    setStepIndex((i) => {
      const next = i + 1;
      if (next >= TOUR_STEPS.length) {
        setActive(false);
        return i;
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    showIntro,
    dismissIntro,
    startTour,
    stopTour,
    advance,
    setSuspended,
    suspended,
    // `active` stays true while suspended — the tour has not ended, it is out
    // of the way — but nothing renders, because currentStep is null and the
    // overlay keys off that.
    active,
    stepIndex,
    steps: TOUR_STEPS,
    currentStep: active && !suspended ? TOUR_STEPS[stepIndex] : null,
  }), [showIntro, dismissIntro, startTour, stopTour, advance, active, suspended, stepIndex]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour() {
  return useContext(TourContext);
}
