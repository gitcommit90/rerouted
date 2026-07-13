"use strict";

(function exposeRendererLockState(root) {
  function requiresLockScreen(state) {
    return !!(
      state?.onboardingComplete &&
      state.hasAdminPassword &&
      !state.unlocked
    );
  }

  function guardSensitiveRender(state, renderLock) {
    if (!requiresLockScreen(state)) return false;
    renderLock();
    return true;
  }

  function createLatestRequestGate() {
    let latestRequest = 0;
    return {
      begin() {
        const request = ++latestRequest;
        return () => request === latestRequest;
      },
    };
  }

  const api = {
    requiresLockScreen,
    guardSensitiveRender,
    createLatestRequestGate,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedRendererLockState = api;
})(typeof window !== "undefined" ? window : null);
