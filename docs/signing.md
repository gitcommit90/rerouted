# macOS signing and notarization

Official ReRouted releases use Apple's direct-distribution path:

1. Sign the Electron app with a `Developer ID Application` certificate.
2. Enable the hardened runtime and Electron-specific entitlements.
3. Submit the signed app to Apple's notarization service and staple the ticket.
4. Create and sign the DMG.
5. Notarize and staple the DMG.
6. Publish the DMG and the post-stapling updater ZIP on the same stable GitHub Release.

This lets users download the DMG and open ReRouted through the normal Gatekeeper flow without using the right-click bypass.

## One-time Mac setup

The build Mac needs a valid `Developer ID Application` identity in its login Keychain. Confirm it with:

```bash
security find-identity -v -p codesigning
```

If a newly issued certificate appears as an identity but is not valid, install Apple's
Developer ID G2 intermediate and check again:

```bash
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
  -o /tmp/DeveloperIDG2CA.cer
security import /tmp/DeveloperIDG2CA.cer \
  -k "$HOME/Library/Keychains/login.keychain-db"
rm -f /tmp/DeveloperIDG2CA.cer
security find-identity -v -p codesigning
```

Create an app-specific password for the Apple ID associated with the developer team, then store notarization credentials in the Keychain:

```bash
xcrun notarytool store-credentials rerouted-notary \
  --apple-id "APPLE_ID_EMAIL" \
  --team-id "APPLE_TEAM_ID"
```

`notarytool` prompts securely for the app-specific password. The password is stored in the macOS Keychain and is not committed to the repository, shell history, or later build commands.

## Release build

```bash
export REROUTED_NOTARY_PROFILE=rerouted-notary
export REROUTED_TEAM_ID=APPLE_TEAM_ID
npm run package:dmg:release
```

`package:dmg:release` fails if it cannot find a Developer ID identity for the configured team or cannot use the notarization profile. Set `REROUTED_SIGN_IDENTITY` to the certificate SHA-1 hash only when the Keychain contains more than one eligible identity for that team.

Local builds can still use:

```bash
npm run package:dmg
```

That command uses Developer ID signing when an identity is available. Without one, it creates an explicitly labeled ad-hoc local build.

## Verification

The release script verifies each stage. These commands provide an independent check:

```bash
codesign --verify --deep --strict --verbose=2 \
  dist/ReRouted-darwin-arm64/ReRouted.app

xcrun stapler validate dist/ReRouted-darwin-arm64/ReRouted.app
spctl --assess --type execute --verbose=4 \
  dist/ReRouted-darwin-arm64/ReRouted.app

xcrun stapler validate dist/ReRouted-0.3.1-arm64.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 \
  dist/ReRouted-0.3.1-arm64.dmg

UPDATE_DIR="$(mktemp -d)"
ditto -x -k dist/ReRouted-0.3.1-mac-arm64.zip "$UPDATE_DIR"
codesign --verify --deep --strict --verbose=2 "$UPDATE_DIR/ReRouted.app"
xcrun stapler validate "$UPDATE_DIR/ReRouted.app"
spctl --assess --type execute --verbose=4 "$UPDATE_DIR/ReRouted.app"
rm -rf "$UPDATE_DIR"
```

Successful `spctl` output should identify the source as `Notarized Developer ID`.
