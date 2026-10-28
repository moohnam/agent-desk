# Shared by the start-*/stop-*/restart-* scripts; sourced, not run.
# The hub (PORT, default 4317) starts the runner daemon (RUNNER_PORT, default 4318) by itself when
# none is listening, so a runner stopped while the hub runs comes back within about 10 seconds.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA=$ROOT/data
HUB_PORT=${PORT:-4317}
RUNNER_PORT=${RUNNER_PORT:-4318}
HUB_LOG=${HUB_LOG:-$DATA/hub.log}
RUNNER_LOG=${RUNNER_LOG:-$DATA/runner.log}
export PORT=$HUB_PORT RUNNER_PORT RUNNER_LOG
mkdir -p "$DATA"

# PID listening on a TCP port, or nothing.
listener() { lsof -tnP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }

# Waits up to $2 seconds for the port to have a listener (want=up) or none (want=down).
wait_port() {
  _port=$1; _secs=$2; _want=$3; _i=0
  while [ "$_i" -lt $((_secs * 2)) ]; do
    _pid=$(listener "$_port")
    if [ "$_want" = up ] && [ -n "$_pid" ]; then return 0; fi
    if [ "$_want" = down ] && [ -z "$_pid" ]; then return 0; fi
    sleep 0.5; _i=$((_i + 1))
  done
  return 1
}

# Runs a command in a new session, detached from this shell and its process group, so stopping
# whatever started the script (e.g. a desk session the runner owns) doesn't take it along.
detach() { nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' "$@" </dev/null >/dev/null 2>&1 & }

# Stops what listens on a port: SIGTERM, then SIGKILL after 10 seconds.
stop_port() {
  name=$1; port=$2
  pid=$(listener "$port")
  if [ -z "$pid" ]; then echo "$name: 실행 중이 아닙니다 (포트 $port)"; return 0; fi
  kill -TERM "$pid"
  if wait_port "$port" 10 down; then echo "$name: 종료했습니다 (pid $pid)"; return 0; fi
  kill -KILL "$pid" 2>/dev/null
  if wait_port "$port" 5 down; then echo "$name: 강제 종료했습니다 (pid $pid)"; return 0; fi
  echo "$name: 종료하지 못했습니다 (pid $pid)" >&2; return 1
}

# True when this script runs under the runner (inside a desk session), which a runner stop would kill.
under_runner() {
  runner=$(listener "$RUNNER_PORT"); [ -n "$runner" ] || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$runner" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# Re-runs this script detached when it would otherwise die with the runner; output goes to data/restart.log.
detach_if_under_runner() {
  [ -z "$AGENT_DESK_DETACHED" ] && under_runner || return 0
  echo "데스크 세션 안에서 실행 중이라 러너 재시작이 이 세션을 끊습니다. 백그라운드로 진행합니다: $DATA/restart.log"
  echo "이 세션도 함께 종료됩니다. 다음 메시지를 보내면 데스크가 세션을 다시 이어갑니다."
  self=$ROOT/scripts/$(basename "$0")
  export AGENT_DESK_DETACHED=1
  detach /bin/sh -c 'exec >>"$1" 2>&1; echo "=== $(date "+%F %T") $0"; exec "$0"' "$self" "$DATA/restart.log"
  exit 0
}
