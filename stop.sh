#!/usr/bin/env bash
# stop.sh — Safely stop GoldTrack server and free all used ports

set -euo pipefail

PORTS=(3000 5173 4173)   # Express server, Vite dev, Vite preview

echo "==> Stopping GoldTrack processes..."

# Kill any process running server.ts / tsx
if pgrep -f "tsx server.ts" > /dev/null 2>&1; then
    pkill -SIGTERM -f "tsx server.ts" && echo "    Killed: tsx server.ts"
    sleep 1
    # Force-kill if still alive
    pgrep -f "tsx server.ts" > /dev/null 2>&1 && pkill -SIGKILL -f "tsx server.ts" || true
fi

# Kill any process running vite (dev / preview)
if pgrep -f "vite" > /dev/null 2>&1; then
    pkill -SIGTERM -f "vite" && echo "    Killed: vite"
    sleep 1
    pgrep -f "vite" > /dev/null 2>&1 && pkill -SIGKILL -f "vite" || true
fi

# Free ports explicitly (belt-and-suspenders)
echo "==> Freeing ports: ${PORTS[*]}"
for PORT in "${PORTS[@]}"; do
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        echo "    Port $PORT — killing PID(s): $PIDS"
        echo "$PIDS" | xargs kill -SIGTERM 2>/dev/null || true
        sleep 1
        PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
        [ -n "$PIDS" ] && echo "$PIDS" | xargs kill -SIGKILL 2>/dev/null || true
    else
        echo "    Port $PORT — already free"
    fi
done

echo "==> Done. All GoldTrack processes stopped."
