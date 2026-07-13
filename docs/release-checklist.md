# Release checklist

This is the required finish line for every ReRouted change, including fixes, features, refactors, UI adjustments, and documentation iterations.

**Do not say "done" until every check has passed.**

## 1. Prepare the change

Start from the current remote `main`, create a branch, and give the app a new version so the installed build is unambiguous.

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c <branch-name>

npm version patch --no-git-tag-version
```

Use a minor or major bump when the scope warrants it. Do not reuse an already-installed version for a new iteration.

## 2. Test the branch

```bash
npm test
git diff --check
git status --short
```

Run additional focused checks for the changed area. For UI work, capture or inspect the relevant Electron states on macOS.

## 3. Commit and push the branch

```bash
git add <changed-files>
git commit -m "<message>"
git push -u origin <branch-name>
```

Record the branch commit:

```bash
git rev-parse HEAD
```

## 4. Merge and push `main`

Merge through the repository's normal review path. If a local merge is required, preserve a merge record:

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff <branch-name>
git push origin main
```

Confirm the remote contains the merged commit:

```bash
git fetch origin
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
git log -1 --oneline origin/main
```

The commit used for packaging is now:

```bash
MERGED_COMMIT="$(git rev-parse origin/main)"
```

## 5. Build the DMG from merged `main`

The DMG must be built on an Apple Silicon Mac from the exact merged commit, not from an unmerged branch or a dirty working tree.

```bash
set -euo pipefail

ORIGINAL_REPO="$(pwd)"
MERGED_COMMIT="<recorded origin/main SHA>"
git fetch origin
test "$(git rev-parse origin/main)" = "$MERGED_COMMIT"
BUILD_PARENT="$(mktemp -d)"
BUILD_DIR="$BUILD_PARENT/source"
git worktree add --detach "$BUILD_DIR" "$MERGED_COMMIT"
cd "$BUILD_DIR"
test "$(git rev-parse HEAD)" = "$MERGED_COMMIT"
test -z "$(git status --porcelain)"

export PATH=/opt/homebrew/bin:$PATH
npm ci
npm test
export REROUTED_NOTARY_PROFILE=rerouted-notary
export REROUTED_TEAM_ID=APPLE_TEAM_ID

VERSION="$(node -p "require('./package.json').version")"
DMG="dist/ReRouted-${VERSION}-arm64.dmg"
UPDATE_ZIP="dist/ReRouted-${VERSION}-mac-arm64.zip"
rm -f "$DMG" "$UPDATE_ZIP"
npm run package:dmg:release
test -s "$DMG"
test -s "$UPDATE_ZIP"

MOUNT="$(hdiutil attach "$DMG" -nobrowse | awk '/\/Volumes\// {sub(/^.*\/Volumes\//, "/Volumes/"); print; exit}')"
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT

codesign --verify --deep --strict "$MOUNT/ReRouted.app"
xcrun stapler validate "$MOUNT/ReRouted.app"
spctl --assess --type execute --verbose=4 "$MOUNT/ReRouted.app"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
shasum -a 256 "$DMG"

UPDATE_DIR="$(mktemp -d)"
ditto -x -k "$UPDATE_ZIP" "$UPDATE_DIR"
codesign --verify --deep --strict "$UPDATE_DIR/ReRouted.app"
xcrun stapler validate "$UPDATE_DIR/ReRouted.app"
spctl --assess --type execute --verbose=4 "$UPDATE_DIR/ReRouted.app"
shasum -a 256 "$UPDATE_ZIP"
rm -rf "$UPDATE_DIR"

hdiutil detach "$MOUNT"
trap - EXIT
```

Record the version, merged commit, DMG filename, and SHA-256 before installation.

## 6. Publish the exact build

Tag the exact commit used for packaging. Create a draft release, upload both verified artifacts, and publish only after their server-side digests match. Publishing is the update activation point.

```bash
set -euo pipefail

TAG="v${VERSION}"
LOCAL_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
UPDATE_SHA="$(shasum -a 256 "$UPDATE_ZIP" | awk '{print $1}')"

test "$(git rev-parse HEAD)" = "$MERGED_COMMIT"
git tag -a "$TAG" "$MERGED_COMMIT" -m "ReRouted ${VERSION}"
git push origin "refs/tags/$TAG:refs/tags/$TAG"

gh release create "$TAG" "$DMG#ReRouted ${VERSION} for Apple Silicon" "$UPDATE_ZIP#ReRouted ${VERSION} in-app update" \
  --repo gitcommit90/rerouted \
  --verify-tag \
  --draft \
  --title "ReRouted ${VERSION}" \
  --generate-notes

test "$(git rev-list -n 1 "$TAG")" = "$MERGED_COMMIT"
REMOTE_DIGEST="$(gh release view "$TAG" --repo gitcommit90/rerouted --json assets --jq ".assets[] | select(.name == \"$(basename "$DMG")\") | .digest")"
REMOTE_UPDATE_DIGEST="$(gh release view "$TAG" --repo gitcommit90/rerouted --json assets --jq ".assets[] | select(.name == \"$(basename "$UPDATE_ZIP")\") | .digest")"
test "$REMOTE_DIGEST" = "sha256:$LOCAL_SHA"
test "$REMOTE_UPDATE_DIGEST" = "sha256:$UPDATE_SHA"
gh release edit "$TAG" --repo gitcommit90/rerouted --draft=false --latest
```

Download the published asset into a clean directory and verify it before installation:

```bash
PUBLISHED_DIR="$(mktemp -d)"
gh release download "$TAG" --repo gitcommit90/rerouted --pattern "$(basename "$DMG")" --dir "$PUBLISHED_DIR"
gh release download "$TAG" --repo gitcommit90/rerouted --pattern "$(basename "$UPDATE_ZIP")" --dir "$PUBLISHED_DIR"
PUBLISHED_DMG="$PUBLISHED_DIR/$(basename "$DMG")"
PUBLISHED_UPDATE="$PUBLISHED_DIR/$(basename "$UPDATE_ZIP")"
test "$(shasum -a 256 "$PUBLISHED_DMG" | awk '{print $1}')" = "$LOCAL_SHA"
test "$(shasum -a 256 "$PUBLISHED_UPDATE" | awk '{print $1}')" = "$UPDATE_SHA"

curl -fsS "https://update.electronjs.org/gitcommit90/rerouted/darwin-arm64/0.0.0" | grep -F "$(basename "$UPDATE_ZIP")"
test "$(curl -sS -o /dev/null -w '%{http_code}' "https://update.electronjs.org/gitcommit90/rerouted/darwin-arm64/${VERSION}")" = "204"

git -C "$ORIGINAL_REPO" worktree remove --force "$BUILD_DIR"
rmdir "$BUILD_PARENT"
```

## 7. Put the published build on `macair`

The current fleet SSH alias is `macair`. Transfer the DMG if it was built elsewhere:

```bash
scp "$PUBLISHED_DMG" "macair:~/Downloads/"
```

On `macair`, quit the running app, mount the DMG, replace the application bundle, unmount, and relaunch. Do not delete its Application Support directory.

```bash
ssh macair

set -euo pipefail
VERSION="<version>"
DMG="$HOME/Downloads/ReRouted-${VERSION}-arm64.dmg"
MOUNT="$(hdiutil attach "$DMG" -nobrowse | awk '/\/Volumes\// {sub(/^.*\/Volumes\//, "/Volumes/"); print; exit}')"
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT

osascript -e 'tell application "ReRouted" to quit' || true
for _ in {1..10}; do
  pgrep -f "/Applications/ReRouted.app/Contents/MacOS/ReRouted" >/dev/null || break
  sleep 1
done
if pgrep -f "/Applications/ReRouted.app/Contents/MacOS/ReRouted" >/dev/null; then
  pkill -TERM -f "/Applications/ReRouted.app/Contents/MacOS/ReRouted"
  sleep 2
fi
test -z "$(pgrep -f "/Applications/ReRouted.app/Contents/MacOS/ReRouted" || true)"

rm -rf "/Applications/ReRouted.app"
ditto "$MOUNT/ReRouted.app" "/Applications/ReRouted.app"

codesign --verify --deep --strict "/Applications/ReRouted.app"
xcrun stapler validate "/Applications/ReRouted.app"
spctl --assess --type execute --verbose=4 "/Applications/ReRouted.app"

hdiutil detach "$MOUNT"
trap - EXIT
open -a "/Applications/ReRouted.app"
```

Only the application bundle is replaced. Do not remove the user's Application Support directory, config, or usage data.

## 8. Verify the MacBook Air

```bash
ssh macair '
  INSTALLED=$(plutil -extract CFBundleShortVersionString raw /Applications/ReRouted.app/Contents/Info.plist)
  printf "installed=%s\n" "$INSTALLED"
  codesign --verify --deep --strict /Applications/ReRouted.app
  xcrun stapler validate /Applications/ReRouted.app
  spctl --assess --type execute --verbose=4 /Applications/ReRouted.app
  pgrep -fl "/Applications/ReRouted.app/Contents/MacOS/ReRouted"
  curl -fsS http://127.0.0.1:4949/health
'
```

The installed version must match `package.json`, the process must be running from `/Applications/ReRouted.app`, and the local health endpoint must answer successfully.

## 9. Final evidence

The completion report must contain all five values:

```text
Version:        <package version>
Merged commit:  <origin/main commit SHA>
DMG:            ReRouted-<version>-arm64.dmg
DMG SHA-256:    <sha256>
Update ZIP:     ReRouted-<version>-mac-arm64.zip (<sha256>)
Release:        <GitHub release URL and matching asset digest>
Gatekeeper:     Developer ID signature, app ticket, and DMG ticket verified
MacBook Air:    installed version verified, process running, health check passed
```

If the DMG was not rebuilt, signed, notarized, and stapled; the MacBook Air was not updated; the code was not committed and pushed; or the change was not merged to `main`, the iteration is not complete. State the missing step plainly and do not use the word "done."
