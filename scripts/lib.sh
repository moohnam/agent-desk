# Shared by the start-*/stop-*/restart-* scripts; sourced, not run.
# The hub starts the runner daemon by itself when
# none is listening, so a runner stopped while the hub runs comes back within about 10 seconds.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA=$ROOT/data
DESK_PORTS=$(node --input-type=module -e '
  import {pathToFileURL} from "node:url";
  import {join} from "node:path";
  const root = process.argv[1], env = process.env;
  const {configuredPort, deskPortDefaults} = await import(pathToFileURL(join(root, "hub/src/ports.ts")));
  const db = env.AGENT_DESK_DB ?? join(root, "data/agent-desk.db");
  const hub = deskPortDefaults(db, env, join(root, "hub")).hub;
  const daemon = deskPortDefaults(db, env, root).daemon;
  console.log(configuredPort(env.PORT, hub) + " " + configuredPort(env.RUNNER_PORT, daemon));
' "$ROOT") || exit 2
HUB_PORT=${DESK_PORTS%% *}
RUNNER_PORT=${DESK_PORTS#* }
# A machine on managed updates runs its hub and runners from release directories. These scripts would
# replace them with unmanaged copies of this checkout, so they refuse there unless forced.
MANAGED_CONFIG=${AGENT_DESK_UPDATE_CONFIG:-$HOME/.local/share/agent-desk/update.json}
if [ -f "$MANAGED_CONFIG" ] && [ -z "${AGENT_DESK_UNMANAGED:-}" ]; then
  # A config file can exist before the first transition. Block only if activation has begun.
  if node --input-type=module -e '
    import {readFileSync, existsSync} from "node:fs";
    import {join} from "node:path";
    import {pathToFileURL} from "node:url";
    const config = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const path = join(config.deploymentDir, "state.json");
    const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const [script, hubPort, runnerPort, root] = process.argv.slice(2);
    const {deskPortDefaults} = await import(pathToFileURL(join(root, "hub/src/ports.ts")));
    const env = config.environment;
    const ports = deskPortDefaults(env.AGENT_DESK_DB ?? join(config.dataDir, "agent-desk.db"), env);
    const selected = (key, fallback) => {
      if (!(key in env)) return fallback;
      const port = Number(env[key]);
      if (typeof env[key] !== "string" || !Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("관리형 포트 설정을 확인하세요.");
      return port;
    };
    const managesHub = !script.endsWith("-runner") && config.roles.includes("hub") && selected("PORT", ports.hub) === Number(hubPort);
    const managesRunner = !script.endsWith("-hub") && config.roles.includes("daemon") && selected("RUNNER_PORT", ports.daemon) === Number(runnerPort);
    const activated = state.current || state.attempted || state.phase === "switching";
    process.exitCode = activated && (managesHub || managesRunner) ? 0 : 3;
  ' "$MANAGED_CONFIG" "$(basename "$0")" "$HUB_PORT" "$RUNNER_PORT" "$ROOT" 2>/dev/null; then
    echo "관리형 허브·러너는 설정 → 버전 정보에서 교체하고 update-cli start로 기동하세요. 수동 운영이 필요하면 AGENT_DESK_UNMANAGED=1을 지정하세요." >&2
    exit 2
  elif [ "$?" -ne 3 ]; then
    echo "업데이트 관리 상태를 확인하지 못했습니다. 업데이트 설정을 확인해 주세요." >&2
    exit 2
  fi
fi
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
