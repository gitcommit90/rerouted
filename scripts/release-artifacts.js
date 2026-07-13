"use strict";

function updateZipName(product, version, arch) {
  if (!product || !version || !arch) throw new Error("Product, version, and architecture are required");
  return `${product}-${version}-mac-${arch}.zip`;
}

function isRecognizedMacUpdateZip(name, arch = "arm64") {
  const value = String(name || "").toLowerCase();
  return value.endsWith(".zip") && /-(?:mac|darwin|osx)(?:-|\.)/.test(value) && value.includes(`-${arch}`);
}

module.exports = { updateZipName, isRecognizedMacUpdateZip };
