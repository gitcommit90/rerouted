"use strict";

function acquireSingleInstance(app) {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) app.exit(0);
  return acquired;
}

module.exports = { acquireSingleInstance };
