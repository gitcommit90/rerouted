"use strict";

/**
 * Tracks renderer unlock state while treating an active macOS login session as
 * sufficient authentication. Locking the screen clears any manual unlock.
 */
function createSessionAuth({ platform = process.platform, initialMacUnlocked = false } = {}) {
  let manuallyUnlocked = false;
  let macSessionUnlocked = platform === "darwin" && !!initialMacUnlocked;

  function isUnlocked(hasPassword) {
    if (!hasPassword) return true;
    if (platform === "darwin" && macSessionUnlocked) return true;
    return manuallyUnlocked;
  }

  function setManualUnlocked(value) {
    manuallyUnlocked = !!value;
  }

  function setMacSessionUnlocked(value) {
    if (platform !== "darwin") return;
    macSessionUnlocked = !!value;
    if (!macSessionUnlocked) manuallyUnlocked = false;
  }

  function snapshot() {
    return { manuallyUnlocked, macSessionUnlocked };
  }

  return { isUnlocked, setManualUnlocked, setMacSessionUnlocked, snapshot };
}

function isMacSessionActive(idleState) {
  return idleState === "active" || idleState === "idle";
}

module.exports = { createSessionAuth, isMacSessionActive };
