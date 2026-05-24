#!/bin/bash

LOG_DIR="$HOME/xarm_logs"
MAX_LOGS=10
TUNNEL_NAME="xarm-controller"
SERVER_SCRIPT="/home/xarmlite6/Documents/xarm_remote/bimanual_pi_server.py"
CAMERA_SCRIPT="/home/xarmlite6/Documents/xarm_remote/camera_server_dual.py"
VENV_PATH="/home/xarmlite6/Documents/xarm_remote/../vent/bin/activate"


mkdir -p "$LOG_DIR"

# Rotate logs: keep only last MAX_LOGS
cleanup_old_logs() {
    ls -1t "$LOG_DIR"/run_*.log 2>/dev/null | tail -n +$((MAX_LOGS + 1)) | xargs -r rm
    # Rotate camera logs same way
    ls -1t "$LOG_DIR"/camera_run_*.log 2>/dev/null | tail -n +$((MAX_LOGS + 1)) | xargs -r rm
}

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE="$LOG_DIR/run_${TIMESTAMP}.log"
CAM_LOGFILE="$LOG_DIR/camera_run_${TIMESTAMP}.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOGFILE"
}

cleanup_old_logs

log "=== Run started ==="
log "Log file: $LOGFILE"



# --- Start tunnel ---
log "Starting Cloudflare tunnel..."
cloudflared tunnel run "$TUNNEL_NAME" >> "$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!
log "Tunnel PID: $TUNNEL_PID"

# Wait for tunnel to be healthy
TUNNEL_READY=false
for i in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:8000 2>/dev/null | grep -q "000\|502"; then
        if kill -0 $TUNNEL_PID 2>/dev/null; then
            TUNNEL_READY=true
            log "Tunnel is running (attempt $i)"
            break
        fi
    fi
    sleep 2
done

if [ "$TUNNEL_READY" = false ]; then
    log "ERROR: Tunnel failed to start after 60s"
    log "=== Run ended: TUNNEL FAILURE ==="
    exit 1
fi

# --- Start server ---
log "Starting xArm WebSocket server..."
log "Activating virtual environment..."
source "$VENV_PATH"

# Start Camera Server with its own rotated log
log "Starting Camera Server on port 8001..."
python3 "$CAMERA_SCRIPT" --device-a /dev/video0 --device-b /dev/video2 --port-a 8001 --port-b 8002 --width 1280 --height 720 --rtc-width 640 --rtc-height 360 --capture-fps 30 --fps 15 >> "$CAM_LOGFILE" 2>&1 &
CAMERA_PID=$!

START_TIME=$(date +%s)

python3 "$SERVER_SCRIPT" 2>&1 | while IFS= read -r line; do
    case "$line" in
        *"[ERR]"*|*"[WARN]"*|*"[ROBOT]"*|*"[INIT]"*|*"[WS] Client"*)
            echo "[$(date '+%H:%M:%S')] $line" >> "$LOGFILE"
            ;;
    esac
done

END_TIME=$(date +%s)
RUNTIME=$(( END_TIME - START_TIME ))

log "=== Run ended ==="
log "Runtime: ${RUNTIME}s ($(( RUNTIME / 3600 ))h $(( (RUNTIME % 3600) / 60 ))m $(( RUNTIME % 60 ))s)"

# Clean up
kill $TUNNEL_PID $CAMERA_PID 2>/dev/null
wait $TUNNEL_PID 2>/dev/null

cleanup_old_logs