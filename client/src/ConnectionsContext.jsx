/**
 * Connection-profiles context — per-user saved credentials for external
 * data sources (ServiceNow, NetBox, SolarWinds Orion, CA Spectrum,
 * generic SQL, generic REST).
 *
 * The active profile is the single source the server uses for that
 * user's session — switching profiles flips where ALL data comes from
 * (no aggregation across sources, by design).
 *
 * The context auto-loads on mount when the user is authenticated and
 * exposes mutation helpers that refresh state after each change.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { useAuth } from './AuthContext.jsx';
import * as api from './utils/connectionsApi';

const ConnectionsContext = createContext(null);

export function ConnectionsProvider({ children }) {
  const { isAuthed, user } = useAuth();
  // An account with an organisation manages the organisation's sources.
  const orgScoped = Boolean(user?.organization_id);
  api.setConnectionsScope({ org: orgScoped });
  const [profiles, setProfiles] = useState([]);
  const [supportedTypes, setSupportedTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // True while a downstream refresh is running after activating a profile.
  // The UI uses this to show a "pulling fresh data…" banner so the user
  // knows incidents / CMDB caches are updating in the background.
  const [refreshing, setRefreshing] = useState(false);
  // Last refresh outcome — for surfacing failures the user would otherwise
  // miss. Shape: { ok, instance, count, polled_at, error } or null.
  const [lastRefresh, setLastRefresh] = useState(null);

  const refresh = useCallback(async () => {
    if (!isAuthed) {
      setProfiles([]); setError(null);
      return;
    }
    setLoading(true);
    try {
      api.setConnectionsScope({ org: orgScoped });
      const { profiles, supportedTypes } = await api.listConnections();
      setProfiles(profiles);
      setSupportedTypes(supportedTypes);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAuthed, orgScoped]);

  useEffect(() => { refresh(); }, [refresh]);

  // Derived: currently-active profile (the one the server treats as the
  // user's single source of truth). Declared up here so the callbacks
  // below can list it as a dependency.
  const active = useMemo(() => profiles.find(p => p.is_active) || null, [profiles]);

  // Mutations — each refreshes state on success so the UI stays in sync.
  const create = useCallback(async (payload) => {
    const profile = await api.createConnection(payload);
    await refresh();
    return profile;
  }, [refresh]);

  const update = useCallback(async (id, patch) => {
    const profile = await api.updateConnection(id, patch);
    await refresh();
    return profile;
  }, [refresh]);

  // Poll the server every 3 s while a refresh is running. Stops on
  // 'done' or 'failed' (success / failure surfaced via lastRefresh), or
  // after maxWaitMs as a safety cap so we never leak the interval. The
  // server already has its own 5-minute hard timeout on the poller, so
  // this client-side cap is mostly belt-and-braces.
  const waitForRefresh = useCallback(async (profileForEvent) => {
    const start = Date.now();
    const MAX_WAIT_MS = 360_000;   // 6 min — gives the server's 5-min cap room
    const dispatch = (refreshed, error) => {
      try {
        window.dispatchEvent(new CustomEvent('rt:connection-activated', {
          detail: { profile: profileForEvent, refreshed, error: error || null },
        }));
      } catch (_) { /* SSR / test envs */ }
    };
    return new Promise((resolve) => {
      const tick = async () => {
        try {
          const s = await api.getRefreshStatus();
          if (s.state === 'done') {
            setLastRefresh({ ok: true, instance: s.instance, count: s.count, polled_at: s.finishedAt });
            setRefreshing(false);
            dispatch(true, null);
            return resolve();
          }
          if (s.state === 'failed') {
            setLastRefresh({ ok: false, instance: s.instance, error: s.error });
            setRefreshing(false);
            dispatch(false, s.error);
            return resolve();
          }
        } catch (_) { /* transient network blip — try again next tick */ }
        if (Date.now() - start > MAX_WAIT_MS) {
          setLastRefresh({ ok: false, error: 'Stopped waiting after 6 minutes - check the server log for poll progress.' });
          setRefreshing(false);
          dispatch(false, 'wait-timeout');
          return resolve();
        }
        setTimeout(tick, 3000);
      };
      setTimeout(tick, 1500);   // give the server a head start
    });
  }, []);

  const activate = useCallback(async (id) => {
    const profile = await api.activateConnection(id);
    await refresh();

    // For ServiceNow profiles, kick off the inbox re-poll and watch it
    // complete in the background. The activate call returns fast; the
    // refreshing flag drives the "Pulling fresh data…" banner so the
    // user can navigate around the app while it works.
    if (profile?.type === 'servicenow') {
      setRefreshing(true);
      setLastRefresh(null);
      try {
        await api.refreshIncidents();   // returns immediately (202)
        waitForRefresh(profile);        // fire-and-forget poll loop
      } catch (err) {
        console.warn('[connections] could not start incidents refresh:', err.message);
        setLastRefresh({ ok: false, error: err.message });
        setRefreshing(false);
      }
    } else {
      try {
        window.dispatchEvent(new CustomEvent('rt:connection-activated', {
          detail: { profile, refreshed: true, error: null },
        }));
      } catch (_) {}
    }

    return profile;
  }, [refresh, waitForRefresh]);

  // Manual "Refresh now" — same poll as activate, but the user-triggered
  // version. Surfaces explicit error/success in lastRefresh so the
  // Connections screen can display the outcome.
  const refreshActiveSource = useCallback(async () => {
    setRefreshing(true);
    setLastRefresh(null);
    try {
      await api.refreshIncidents();    // 202 immediately
      waitForRefresh(active);          // fire-and-forget; updates state when done
    } catch (err) {
      setLastRefresh({ ok: false, error: err.message });
      setRefreshing(false);
    }
  }, [active, waitForRefresh]);

  const deactivate = useCallback(async () => {
    await api.deactivateConnections();
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id) => {
    await api.deleteConnection(id);
    await refresh();
  }, [refresh]);

  return (
    <ConnectionsContext.Provider value={{
      orgScoped,
      profiles, active, supportedTypes, loading, error, refreshing, lastRefresh,
      refresh, create, update, activate, deactivate, remove,
      refreshActiveSource,
    }}>
      {children}
    </ConnectionsContext.Provider>
  );
}

export function useConnections() {
  const ctx = useContext(ConnectionsContext);
  if (!ctx) throw new Error('useConnections must be used inside <ConnectionsProvider>');
  return ctx;
}
