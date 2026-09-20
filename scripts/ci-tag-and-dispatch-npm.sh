#!/usr/bin/env bash
# After a Version Packages merge (no pending changesets), tag vX.Y.Z and
# dispatch publish.yml. A GITHUB_TOKEN tag push does not start other workflows,
# so publish.yml is invoked via workflow_dispatch — that keeps npm OIDC bound
# to publish.yml (trusted publisher filename).
set -euo pipefail

: "${GITHUB_SHA:?}"
: "${GITHUB_REPOSITORY:?}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
: "${GH_TOKEN:?}"
export GH_TOKEN

NAME="$(bun --print "require('./package.json').name")"
VERSION="$(bun --print "require('./package.json').version")"
TAG="v${VERSION}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::unexpected package.json version ${VERSION}"
  exit 1
fi

ENCODED_NAME="$(bun --print "encodeURIComponent(require('./package.json').name)")"
REGISTRY_STATUS="$(curl -sS -o /dev/null -w "%{http_code}" \
  "https://registry.npmjs.org/${ENCODED_NAME}/${VERSION}")"

if [ "$REGISTRY_STATUS" = "200" ]; then
  echo "${NAME}@${VERSION} already on npm; skip."
  exit 0
fi

if [ "$REGISTRY_STATUS" != "404" ]; then
  echo "::error::npm registry returned HTTP ${REGISTRY_STATUS} for ${NAME}@${VERSION}"
  exit 1
fi

if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "GitHub release ${TAG} already exists."
else
  gh release create "$TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --title "${NAME} ${TAG}" \
    --target "$GITHUB_SHA" \
    --generate-notes
  echo "Created GitHub release ${TAG} at ${GITHUB_SHA}."
fi

# First push that adds workflow_dispatch can race GitHub's workflow index.
dispatch_ok=0
for attempt in 1 2 3 4 5 6 7 8; do
  if gh workflow run publish.yml \
    --repo "$GITHUB_REPOSITORY" \
    --field "tag=${TAG}"; then
    dispatch_ok=1
    break
  fi
  echo "dispatch publish.yml failed (attempt ${attempt}); retrying..."
  sleep 5
done

if [ "$dispatch_ok" -ne 1 ]; then
  echo "::error::failed to dispatch publish.yml for ${TAG}"
  exit 1
fi

echo "Dispatched publish.yml for ${TAG}."
