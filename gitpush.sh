#!/usr/bin/env bash
# gitpush.sh — Stage, commit, and push all changes to GitHub
# Usage:
#   ./gitpush.sh                     # prompts for commit message
#   ./gitpush.sh "your message"      # uses provided commit message
#   ./gitpush.sh "msg" <branch>      # uses provided message and branch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================"
echo "  GoldTrack — Git Push"
echo "======================================"

# Determine commit message
if [ -n "${1:-}" ]; then
    COMMIT_MSG="$1"
else
    echo ""
    read -rp "Enter commit message: " COMMIT_MSG
    if [ -z "$COMMIT_MSG" ]; then
        echo "ERROR: Commit message cannot be empty."
        exit 1
    fi
fi

# Determine branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET_BRANCH="${2:-$CURRENT_BRANCH}"

echo ""
echo "--> Branch  : $TARGET_BRANCH"
echo "--> Message : $COMMIT_MSG"
echo ""

# Show what will be committed
echo "--> Status:"
git status --short
echo ""

# Check if there is anything to commit
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "Nothing to commit — working tree is clean."
    echo ""
    echo "--> Pushing existing commits to origin/$TARGET_BRANCH..."
    git push -u origin "$TARGET_BRANCH"
    echo "Done."
    exit 0
fi

# Stage all changes
echo "--> Staging all changes..."
git add -A

# Commit
echo "--> Committing..."
git commit -m "$COMMIT_MSG"

# Push
echo ""
echo "--> Pushing to origin/$TARGET_BRANCH..."
git push -u origin "$TARGET_BRANCH"

echo ""
echo "======================================"
echo "  Done! Changes pushed to GitHub."
echo "======================================"
