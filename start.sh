#!/usr/bin/env bash
# start.sh — Start the GoldTrack development server
#             Kills any existing processes first via stop.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================"
echo "  GoldTrack — Starting Dev Server"
echo "======================================"

# 1. Kill any running instances and free ports
echo ""
echo "--> Cleaning up existing processes..."
bash "$SCRIPT_DIR/stop.sh"

# 2. Install dependencies if node_modules is missing
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo ""
    echo "--> node_modules not found — running npm install..."
    cd "$SCRIPT_DIR" && npm install
fi

# 3. Load .env.local if present
if [ -f "$SCRIPT_DIR/.env.local" ]; then
    echo ""
    echo "--> Loading environment from .env.local"
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env.local"
    set +a
fi

# 4. Start the server
echo ""
echo "--> Starting server (tsx server.ts) on http://localhost:3000"
echo "    Press Ctrl+C to stop."
echo ""
cd "$SCRIPT_DIR" && npm run dev
