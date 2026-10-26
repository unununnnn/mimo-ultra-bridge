#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-mimo-ultra-bridge}"
VISIBILITY="${2:---public}" # --public or --private

echo "============================================================="
echo "📦 Preparing to push project to GitHub repository: ${REPO_NAME}"
echo "============================================================="

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -b main
  git add .
  git commit -m "feat: initial release of mimo-ultra-bridge (Playwright #/ultra OpenAI & Anthropic API bridge)"
fi

if command -v gh >/dev/null 2>&1; then
  echo "Detected GitHub CLI (gh). Creating repository '${REPO_NAME}' (${VISIBILITY})..."
  gh repo create "${REPO_NAME}" "${VISIBILITY}" --source=. --remote=origin --push
  echo "✅ Successfully created and pushed to GitHub via gh CLI!"
else
  echo "GitHub CLI (gh) not found. If you already created an empty repo on GitHub, run:"
  echo "  git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/${REPO_NAME}.git"
  echo "  git branch -M main"
  echo "  git push -u origin main"
fi
