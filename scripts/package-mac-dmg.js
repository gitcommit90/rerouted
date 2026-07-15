#!/usr/bin/env node
/**
 * Build ReRouted.app (darwin/arm64) and wrap it in a drag-to-Applications .dmg.
 *
 * Must run on macOS (uses hdiutil and codesign).
 *
 *   node scripts/package-mac-dmg.js
 *   npm run package:dmg
 *   REROUTED_TEAM_ID=APPLE_TEAM_ID REROUTED_NOTARY_PROFILE=rerouted-notary npm run package:dmg:release
 *
 * Outputs:
 *   dist/ReRouted-<version>-arm64.dmg
 *   dist/ReRouted-<version>-mac-arm64.zip (notarized release builds only)
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { updateZipName } = require("./release-artifacts");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const PRODUCT = "ReRouted";
const APP_ID = "dev.rerouted.app";
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const ARCH = "arm64";
const REQUIRE_NOTARIZATION = process.env.REROUTED_REQUIRE_NOTARIZATION === "1";
const FORCE_ADHOC = process.env.REROUTED_ADHOC === "1";
const CONFIGURED_IDENTITY = (process.env.REROUTED_SIGN_IDENTITY || "").trim();
const CONFIGURED_TEAM_ID = (process.env.REROUTED_TEAM_ID || "").trim().toUpperCase();
const NOTARY_PROFILE = (process.env.REROUTED_NOTARY_PROFILE || "").trim();
const IGNORE_NON_RUNTIME_ROOTS =
  /^\/(?!package\.json$|src(?:$|\/)|resources(?:$|\/)|node_modules(?:$|\/))/;

if (!VERSION) throw new Error("package.json must define a version");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(" ")}`);
  }
  return res;
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) return "";
  return res.stdout || "";
}

function developerIdIdentities() {
  const output = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application:[^"]+)"/);
    if (match) identities.push({ hash: match[1], name: match[2] });
  }
  return identities;
}

function resolveDeveloperIdIdentity() {
  if (FORCE_ADHOC) return null;
  const identities = developerIdIdentities();
  if (!CONFIGURED_IDENTITY && !CONFIGURED_TEAM_ID) return identities[0] || null;
  const configured = CONFIGURED_IDENTITY.toUpperCase();
  const match = identities.find((identity) => {
    const identityMatches =
      !CONFIGURED_IDENTITY || identity.hash === configured || identity.name === CONFIGURED_IDENTITY;
    const teamMatches =
      !CONFIGURED_TEAM_ID || identity.name.toUpperCase().endsWith(`(${CONFIGURED_TEAM_ID})`);
    return identityMatches && teamMatches;
  });
  if (!match) {
    throw new Error(
      "The configured signing identity/team must match an installed Developer ID Application certificate."
    );
  }
  return match;
}

function notarize(filePath) {
  run("xcrun", [
    "notarytool",
    "submit",
    filePath,
    "--keychain-profile",
    NOTARY_PROFILE,
    "--wait",
  ]);
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("package-mac-dmg.js must run on macOS (needs hdiutil).");
    process.exit(1);
  }
  if (!which("hdiutil")) {
    console.error("hdiutil not found");
    process.exit(1);
  }

  if (FORCE_ADHOC && REQUIRE_NOTARIZATION) {
    throw new Error("REROUTED_ADHOC cannot be used for a notarized release build");
  }
  if (REQUIRE_NOTARIZATION && !CONFIGURED_IDENTITY && !CONFIGURED_TEAM_ID) {
    throw new Error(
      "Release builds require REROUTED_TEAM_ID or REROUTED_SIGN_IDENTITY to prevent signing with the wrong team."
    );
  }

  const identity = resolveDeveloperIdIdentity();
  if (REQUIRE_NOTARIZATION && !identity) {
    throw new Error(
      "No Developer ID Application identity found. Install the certificate or set REROUTED_SIGN_IDENTITY."
    );
  }
  if (REQUIRE_NOTARIZATION && !NOTARY_PROFILE) {
    throw new Error(
      "REROUTED_NOTARY_PROFILE is required. Create one with xcrun notarytool store-credentials."
    );
  }
  if (REQUIRE_NOTARIZATION && !which("xcrun")) {
    throw new Error("xcrun is required for notarization");
  }

  fs.mkdirSync(DIST, { recursive: true });
  const dmgName = `${PRODUCT}-${VERSION}-${ARCH}.dmg`;
  const dmgPath = path.join(DIST, dmgName);
  const dmgCandidate = path.join(DIST, `${PRODUCT}-${VERSION}-${ARCH}.candidate.dmg`);
  const updaterName = updateZipName(PRODUCT, VERSION, ARCH);
  const updaterPath = path.join(DIST, updaterName);
  const updaterCandidate = path.join(DIST, `${PRODUCT}-${VERSION}-mac-${ARCH}.candidate.zip`);
  // Never leave an older or partially built artifact under the canonical name.
  for (const file of [dmgPath, dmgCandidate, updaterPath, updaterCandidate]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  // 1) Package .app
  const packager = require("@electron/packager");
  console.log("Packaging Electron app…");
  const [appDir] = await packager({
    dir: ROOT,
    name: PRODUCT,
    appBundleId: APP_ID,
    appCategoryType: "public.app-category.utilities",
    platform: "darwin",
    arch: ARCH,
    out: DIST,
    overwrite: true,
    prune: true,
    asar: true,
    quiet: false,
    ignore: [
      // Package only the runtime graph, even if the checkout contains ignored local files.
      IGNORE_NON_RUNTIME_ROOTS,
      /\.log$/,
      /\.DS_Store$/,
      /\.md$/,
    ],
    extendInfo: {
      LSUIElement: true,
      CFBundleDisplayName: PRODUCT,
      CFBundleName: PRODUCT,
      NSHighResolutionCapable: true,
    },
    extraResource: [
      path.join(ROOT, "resources", "trayTemplate.png"),
      path.join(ROOT, "resources", "trayTemplate@2x.png"),
      path.join(ROOT, "LICENSE"),
    ].filter((p) => fs.existsSync(p)),
  });

  const appPath = path.join(appDir, `${PRODUCT}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`App not found at ${appPath}`);
  }

  // Ensure tray icons land in Resources (packager extraResource is fine; belt & suspenders)
  const resDir = path.join(appPath, "Contents", "Resources");
  const appLicense = path.join(resDir, "LICENSE");
  if (!fs.existsSync(appLicense)) {
    throw new Error("Packaged app is missing the MIT license notice");
  }
  for (const f of ["trayTemplate.png", "trayTemplate@2x.png"]) {
    const src = path.join(ROOT, "resources", f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(resDir, f));
  }

  // 2) Sign the complete Electron bundle. @electron/osx-sign applies the
  // hardened runtime and file-specific Electron entitlements.
  if (identity) {
    console.log(`Codesigning with ${identity.name} (${identity.hash})…`);
    const { signAsync } = require("@electron/osx-sign");
    await signAsync({
      app: appPath,
      identity: identity.hash,
      platform: "darwin",
      hardenedRuntime: true,
      strictVerify: true,
    });
  } else {
    console.log("Codesigning (ad-hoc local build)…");
    run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  }
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  // A stapled app launches cleanly even when the first run is offline.
  if (identity && NOTARY_PROFILE) {
    const appArchive = path.join(DIST, `${PRODUCT}-${VERSION}-${ARCH}-notary.zip`);
    if (fs.existsSync(appArchive)) fs.unlinkSync(appArchive);
    try {
      run("ditto", ["-c", "-k", "--keepParent", appPath, appArchive]);
      console.log("Notarizing app…");
      notarize(appArchive);
      run("xcrun", ["stapler", "staple", appPath]);
      run("xcrun", ["stapler", "validate", appPath]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    } finally {
      if (fs.existsSync(appArchive)) fs.unlinkSync(appArchive);
    }
  }

  // Native macOS updates consume a ZIP containing the already-stapled app.
  // Creating this before stapling would make offline Gatekeeper verification weaker.
  if (REQUIRE_NOTARIZATION) {
    console.log("Creating updater ZIP from notarized app…");
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, updaterCandidate]);

    const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-update-verify-"));
    try {
      run("ditto", ["-x", "-k", updaterCandidate, verifyDir]);
      const extractedApp = path.join(verifyDir, `${PRODUCT}.app`);
      if (!fs.existsSync(extractedApp)) throw new Error("Updater ZIP does not contain ReRouted.app");
      run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
      run("xcrun", ["stapler", "validate", extractedApp]);
      run("spctl", ["--assess", "--type", "execute", "--verbose=4", extractedApp]);
    } finally {
      fs.rmSync(verifyDir, { recursive: true, force: true });
    }
    fs.renameSync(updaterCandidate, updaterPath);
  }

  // 3) Stage DMG contents: App + Applications symlink.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-dmg-"));
  try {
    const stagedApp = path.join(stage, `${PRODUCT}.app`);
    run("ditto", [appPath, stagedApp]);
    run("ln", ["-s", "/Applications", path.join(stage, "Applications")]);
    fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(stage, "LICENSE.txt"));

    fs.writeFileSync(
      path.join(stage, "Install.txt"),
      [
        "ReRouted",
        "",
        "1. Drag ReRouted.app into the Applications folder.",
        identity && NOTARY_PROFILE
          ? "2. Open ReRouted normally from Applications."
          : "2. Open Applications → ReRouted (right-click → Open the first time if Gatekeeper warns).",
        "3. Look for the ReRouted icon in the menu bar (no Dock icon).",
        "",
        `Endpoint: http://127.0.0.1:4949/v1`,
        "",
      ].join("\n")
    );

    // 4) Create and validate a candidate before publishing the canonical path.
    console.log("Creating DMG…");
    run("hdiutil", [
      "create",
      "-volname",
      `${PRODUCT} ${VERSION}`,
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      dmgCandidate,
    ]);

    if (identity) {
      console.log("Signing DMG…");
      run("codesign", ["--force", "--sign", identity.hash, "--timestamp", dmgCandidate]);
      run("codesign", ["--verify", "--strict", "--verbose=2", dmgCandidate]);
    }

    if (identity && NOTARY_PROFILE) {
      console.log("Notarizing DMG…");
      notarize(dmgCandidate);
      run("xcrun", ["stapler", "staple", dmgCandidate]);
      run("xcrun", ["stapler", "validate", dmgCandidate]);
      run("spctl", [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=4",
        dmgCandidate,
      ]);
    }

    fs.renameSync(dmgCandidate, dmgPath);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (fs.existsSync(dmgCandidate)) fs.unlinkSync(dmgCandidate);
  }

  const st = fs.statSync(dmgPath);
  console.log("");
  console.log(`DMG ready: ${dmgPath}`);
  console.log(`Size: ${(st.size / (1024 * 1024)).toFixed(1)} MB`);
  if (fs.existsSync(updaterPath)) {
    const updateSize = fs.statSync(updaterPath).size;
    console.log(`Updater: ${updaterPath}`);
    console.log(`Updater size: ${(updateSize / (1024 * 1024)).toFixed(1)} MB`);
  }
  console.log("");
  console.log("Install: open the DMG → drag ReRouted into Applications.");
  if (identity && NOTARY_PROFILE) {
    console.log("Developer ID signed, notarized, and stapled for standard Gatekeeper launch.");
  } else if (identity) {
    console.log("Developer ID signed but not notarized. Set REROUTED_NOTARY_PROFILE for release builds.");
  } else {
    console.log("Ad-hoc local build. Use npm run package:dmg:release for distribution.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
