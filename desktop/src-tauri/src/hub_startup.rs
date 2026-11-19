use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use socket2::{Domain, Protocol, Socket, Type};
use url::Url;

const CURRENT_PORT: u16 = 17641;
const LEGACY_PORT: u16 = 4317;
const PROBE_INTERVAL: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);
const START_COOLDOWN: Duration = Duration::from_secs(5);

fn configured_port(value: Option<&Value>) -> Result<Option<u16>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    value
        .as_str()
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .map(Some)
        .ok_or_else(|| "관리형 설정의 PORT는 \"17641\"처럼 문자열로 지정해 주세요.".into())
}

// Keep the same on-disk selection as hub/src/ports.ts.
fn default_port(db: &Path, overrides: impl IntoIterator<Item = PathBuf>) -> u16 {
    let dir = db.parent().unwrap_or_else(|| Path::new(""));
    if dir.join(".desk-ports-v2").exists() {
        return CURRENT_PORT;
    }
    if db.exists()
        || [
            "gateway.db",
            "local-mode.json",
            "runner-token",
            "access-token",
        ]
        .into_iter()
        .any(|name| dir.join(name).exists())
        || overrides.into_iter().any(|path| path.exists())
    {
        LEGACY_PORT
    } else {
        CURRENT_PORT
    }
}

fn read_managed_config() -> Result<Option<Value>, String> {
    let path = std::env::var_os("AGENT_DESK_UPDATE_CONFIG")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".local/share/agent-desk/update.json"))
        });
    let Some(path) = path else {
        return Ok(None);
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .filter(|config| config["roles"].is_array())
            .map(Some)
            .ok_or_else(|| "관리형 업데이트 설정을 읽지 못했습니다.".into()),
        Err(error)
            if error.kind() == ErrorKind::NotFound
                && std::fs::symlink_metadata(path)
                    .is_err_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(_) => Err("관리형 업데이트 설정을 읽지 못했습니다.".into()),
    }
}

const PORT_EVIDENCE: [&str; 4] = [
    "AGENT_DESK_GATEWAY_DB",
    "AGENT_DESK_LOCAL_MODE_FILE",
    "RUNNER_TOKEN_FILE",
    "AGENT_DESK_TOKEN_FILE",
];

fn managed_port(config: &Value) -> Result<Option<u16>, String> {
    if !config["roles"]
        .as_array()
        .is_some_and(|roles| roles.iter().any(|role| role == "hub"))
    {
        return Ok(None);
    }
    let environment = &config["environment"];
    if let Some(port) = configured_port(environment.get("PORT"))? {
        return Ok(Some(port));
    }
    let db = environment["AGENT_DESK_DB"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| {
            config["dataDir"]
                .as_str()
                .map(|dir| Path::new(dir).join("agent-desk.db"))
        })
        .ok_or_else(|| "관리형 허브의 데이터 경로를 확인하지 못했습니다.".to_string())?;
    Ok(Some(default_port(
        &db,
        PORT_EVIDENCE
            .into_iter()
            .filter_map(|key| environment[key].as_str().map(PathBuf::from)),
    )))
}

fn active_managed_port(config: &Value) -> Result<Option<u16>, String> {
    let port = managed_port(config)?;
    if port.is_some() && installed_state(config)?.is_some() {
        Ok(port)
    } else {
        Ok(None)
    }
}

fn hub_url() -> Result<Url, String> {
    if let Ok(raw) = std::env::var("AGENT_DESK_URL") {
        if let Ok(url) = Url::parse(raw.trim()) {
            if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
                return Ok(url);
            }
        }
        return Err("AGENT_DESK_URL은 HTTP(S) 주소여야 합니다.".into());
    }
    local_hub_port().map(loopback_url)
}

fn local_hub_port() -> Result<u16, String> {
    let configured = read_managed_config()?
        .as_ref()
        .map(active_managed_port)
        .transpose()?
        .flatten();
    let port = configured.or_else(environment_port).unwrap_or_else(|| {
        let root = repo_dir();
        let cwd = root.join("hub");
        let db = std::env::var_os("AGENT_DESK_DB")
            .map(|path| cwd.join(path))
            .unwrap_or_else(|| root.join("data/agent-desk.db"));
        default_port(
            &db,
            PORT_EVIDENCE
                .into_iter()
                .filter_map(|key| std::env::var_os(key).map(|path| cwd.join(path))),
        )
    });
    Ok(port)
}

fn environment_port() -> Option<u16> {
    std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
}

fn matches_local_port(
    url_port: u16,
    local_port: u16,
    explicit_url: bool,
    environment_port: Option<u16>,
) -> bool {
    url_port == local_port && (!explicit_url || environment_port == Some(url_port))
}

fn loopback_url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
}

fn hub_addresses(url: &Url) -> Option<impl Iterator<Item = SocketAddr>> {
    let (host, port) = (url.host_str()?, url.port_or_known_default()?);
    (host.trim_matches(['[', ']']), port).to_socket_addrs().ok()
}

fn connect_hub(url: &Url) -> Option<TcpStream> {
    hub_addresses(url)?.find_map(|address| TcpStream::connect_timeout(&address, PROBE_TIMEOUT).ok())
}

/// A timeout or a listener that is still starting is insufficient evidence to start another hub.
fn port_is_free(url: &Url) -> bool {
    let Some(mut addresses) = hub_addresses(url).map(Iterator::peekable) else {
        return false;
    };
    addresses.peek().is_some()
        && addresses.all(|address| {
            TcpStream::connect_timeout(&address, PROBE_TIMEOUT)
                .is_err_and(|error| error.kind() == ErrorKind::ConnectionRefused)
        })
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Check the local HTTP service so a different process on the port is not opened as the Desk.
fn hub_reachable(url: &Url) -> bool {
    if !is_loopback(url) || url.scheme() != "http" {
        return connect_hub(url).is_some();
    }
    let read = |path| -> Option<String> {
        let mut socket = connect_hub(url)?;
        let (host, port) = (url.host_str()?, url.port_or_known_default()?);
        socket.set_read_timeout(Some(PROBE_TIMEOUT)).ok()?;
        socket.set_write_timeout(Some(PROBE_TIMEOUT)).ok()?;
        write!(
            socket,
            "GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        )
        .ok()?;
        let mut reply = Vec::new();
        let _ = socket.take(4096).read_to_end(&mut reply);
        Some(String::from_utf8_lossy(&reply).into_owned())
    };
    let Some(reply) = read("/__desk_ready") else {
        return false;
    };
    if reply.split_once("\r\n\r\n").is_some_and(|(headers, _)| {
        headers.starts_with("HTTP/1.1 204 ")
            && headers
                .lines()
                .any(|line| line.eq_ignore_ascii_case("x-agent-desk-ready: 1"))
    }) {
        return true;
    }
    // Pre-marker hubs expose this small authenticated response to localhost.
    read("/api/instructions").is_some_and(|reply| {
        reply
            .lines()
            .next()
            .is_some_and(|line| line.split_whitespace().nth(1) == Some("200"))
            && reply.split_once("\r\n\r\n").is_some_and(|(headers, body)| {
                headers.contains("application/json") && body.starts_with("{\"text\":")
            })
    })
}

pub(super) fn repo_dir() -> PathBuf {
    let root = || {
        option_env!("AGENT_DESK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")))
    };
    let path = std::env::var_os("AGENT_DESK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(root);
    path.canonicalize().unwrap_or(path)
}

fn managed_state(hub: &Url) -> Result<Option<(Value, PathBuf)>, String> {
    let Some(config) = read_managed_config()? else {
        return Ok(None);
    };
    if managed_port(&config)?
        .filter(|port| Some(*port) == hub.port_or_known_default())
        .is_none()
    {
        return Ok(None);
    }
    installed_state(&config)
}

fn installed_state(config: &Value) -> Result<Option<(Value, PathBuf)>, String> {
    let deploy = config["deploymentDir"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| "관리형 허브의 배포 경로를 확인하지 못했습니다.".to_string())?;
    let state = match std::fs::read(deploy.join("state.json")) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "관리형 허브의 실행 상태를 확인하지 못했습니다.".to_string())?,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("관리형 허브의 실행 상태를 확인하지 못했습니다.".into()),
    };
    if state["current"].is_null() && state["attempted"].is_null() && state["phase"] != "switching" {
        return Ok(None);
    }
    let logs = config["dataDir"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or(deploy)
        .join("update-logs");
    Ok(Some((state, logs)))
}

fn has_hub_manager() -> Result<bool, String> {
    if std::env::var("AGENT_DESK_MANAGED_RUNNERS").as_deref() == Ok("1") {
        return Ok(true);
    }
    let Some(config) = read_managed_config()? else {
        return Ok(false);
    };
    Ok(managed_port(&config)?.is_some())
}

#[cfg(target_os = "macos")]
fn start_managed(hub: &Url) -> Result<bool, String> {
    let Some((state, _)) = managed_state(hub)? else {
        return Ok(false);
    };
    if !state["attempted"].is_null()
        && (state["restoreCurrent"].is_null() || state["restoreCurrent"] != state["current"])
    {
        return Err("교체가 중단됐습니다. 로그를 확인하고 수정된 후속 버전으로 복구하세요.".into());
    }
    let uid = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|err| format!("관리형 허브 시작 계정을 확인하지 못했습니다: {err}"))?;
    let uid = String::from_utf8_lossy(&uid.stdout);
    let result = Command::new("/bin/launchctl")
        .args([
            "kickstart",
            &format!("gui/{}/com.agent-desk.managed", uid.trim()),
        ])
        .output()
        .map_err(|err| format!("관리형 허브 시작을 요청하지 못했습니다: {err}"))?;
    if result.status.success() {
        Ok(true)
    } else {
        Err("관리형 허브를 시작하지 못했습니다. 로그인 시작 설정을 확인해 주세요.".into())
    }
}

/// Use the login shell to find Node. The hub continues running after the app closes.
fn spawn_unmanaged(port: u16, host: &str) -> Result<(), String> {
    if !can_listen(host, port) {
        return Err(format!(
            "{host}의 {port} 포트를 열 수 없습니다. 포트 점유와 허브 주소 설정을 확인해 주세요."
        ));
    }
    let repo = repo_dir();
    if !repo.join("hub/src/index.ts").exists() {
        return Err(format!("허브 코드를 찾을 수 없습니다: {}", repo.display()));
    }
    let log = repo.join("data/hub.log");
    std::fs::create_dir_all(log.parent().unwrap()).map_err(|err| err.to_string())?;
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg("umask 077; if [ -f src/runtime-log.ts ]; then node src/runtime-log.ts \"$2\" || exit; fi; PORT=\"$3\" HOST=\"$4\" exec node \"$1\" >>\"$2\" 2>&1")
        .arg("agent-desk").arg("src/index.ts").arg(log).arg(port.to_string()).arg(host)
        .current_dir(repo.join("hub")).stdin(Stdio::null()).stdout(Stdio::null()).process_group(0)
        .spawn().map_err(|err| format!("허브를 시작하지 못했습니다: {err}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn can_listen(host: &str, port: u16) -> bool {
    (host, port).to_socket_addrs().is_ok_and(|mut addresses| {
        addresses.any(|address| {
            let probe = || -> std::io::Result<()> {
                let socket = Socket::new(
                    Domain::for_address(address),
                    Type::STREAM,
                    Some(Protocol::TCP),
                )?;
                // Match Node's reuse behavior so recently closed connections do not look occupied.
                socket.set_reuse_address(true)?;
                socket.bind(&address.into())?;
                socket.listen(1)
            };
            probe().is_ok()
        })
    })
}

#[derive(Default)]
struct Recovery {
    missed: u8,
    attempted: bool,
}

impl Recovery {
    fn should_start(&mut self, absent: bool, ready: bool) -> bool {
        if ready {
            *self = Self::default();
        }
        if !absent {
            self.missed = 0;
            return false;
        }
        if self.attempted {
            return false;
        }
        self.missed += 1;
        self.attempted = self.missed == 3;
        self.attempted
    }
}

pub(super) struct DesktopHub {
    pub(super) url: Url,
    configuration_error: Option<String>,
    ready: AtomicBool,
    closed: AtomicBool,
    last_start: Mutex<Option<Instant>>,
}

impl DesktopHub {
    pub(super) fn new() -> Self {
        let (url, configuration_error) = match hub_url() {
            Ok(url) => (url, None),
            Err(error) => (loopback_url(CURRENT_PORT), Some(error)),
        };
        Self {
            url,
            configuration_error,
            ready: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            last_start: Mutex::new(None),
        }
    }

    fn start(&self, allow_managed: bool) -> Result<bool, String> {
        if !is_loopback(&self.url)
            || self.url.scheme() != "http"
            || self.closed.load(Ordering::Relaxed)
        {
            return Ok(false);
        }
        let mut last = self
            .last_start
            .lock()
            .map_err(|_| "허브 기동 상태를 확인하지 못했습니다.")?;
        if last.is_some_and(|at| at.elapsed() < START_COOLDOWN) {
            return Ok(true);
        }
        let port = self.url.port_or_known_default().unwrap_or(CURRENT_PORT);
        if !self.can_start_local(port)? {
            return Ok(false);
        }
        if !port_is_free(&self.url) {
            return Err(format!("{port} 포트에서 Agent Desk 응답을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요."));
        }
        #[cfg(target_os = "macos")]
        if allow_managed && start_managed(&self.url)? {
            *last = Some(Instant::now());
            return Ok(true);
        }
        if (!allow_managed && has_hub_manager()?)
            || std::env::var("AGENT_DESK_MANAGED_RUNNERS").as_deref() == Ok("1")
        {
            return Ok(false);
        }
        let host = std::env::var("HOST").unwrap_or_else(|_| {
            if self.url.host_str() == Some("[::1]") {
                "::1".into()
            } else {
                "0.0.0.0".into()
            }
        });
        spawn_unmanaged(port, &host)?;
        *last = Some(Instant::now());
        Ok(true)
    }

    fn can_start_local(&self, port: u16) -> Result<bool, String> {
        Ok(matches_local_port(
            port,
            local_hub_port()?,
            std::env::var_os("AGENT_DESK_URL").is_some(),
            environment_port(),
        ))
    }

    pub(super) fn monitor(self: &Arc<Self>) {
        if self.configuration_error.is_some()
            || !is_loopback(&self.url)
            || self.url.scheme() != "http"
            || !matches!(has_hub_manager(), Ok(false))
            || !self
                .url
                .port_or_known_default()
                .is_some_and(|port| matches!(self.can_start_local(port), Ok(true)))
        {
            return;
        }
        let hub = Arc::clone(self);
        std::thread::spawn(move || {
            let mut recovery = Recovery::default();
            loop {
                std::thread::sleep(PROBE_INTERVAL);
                if hub.closed.load(Ordering::Relaxed) {
                    break;
                }
                if !hub.ready.load(Ordering::Relaxed) {
                    continue;
                }
                let absent = port_is_free(&hub.url);
                let ready = recovery.attempted && !absent && hub_reachable(&hub.url);
                if recovery.should_start(absent, ready) {
                    if let Err(error) = hub.start(false) {
                        eprintln!("[agent-desk] {error}");
                    }
                }
            }
        });
    }

    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
    }

    fn status(&self, retry: bool) -> Value {
        if let Some(error) = &self.configuration_error {
            return json!({ "ready": false, "error": format!("{error} 수정한 뒤 앱을 다시 열어 주세요."), "configurationError": true });
        }
        let reachable = hub_reachable(&self.url);
        if reachable {
            self.ready.store(true, Ordering::Relaxed);
            return json!({ "ready": true });
        }
        let mut info = json!({ "ready": false, "local": is_loopback(&self.url) });
        if !is_loopback(&self.url) {
            return info;
        }
        if retry {
            match self.start(true) {
                Ok(starting) => info["starting"] = starting.into(),
                Err(error) => info["error"] = error.into(),
            }
        }
        match managed_state(&self.url) {
            Ok(Some((state, logs))) => {
                for key in ["phase", "current", "candidate", "attempted", "blockedPort"] {
                    info[key] = state[key].clone();
                }
                info["canRestore"] = (!state["restoreCurrent"].is_null()
                    && state["restoreCurrent"] == state["current"])
                    .into();
                info["logs"] = logs.to_string_lossy().into_owned().into();
            }
            Err(error) => info["error"] = error.into(),
            Ok(None) => (),
        }
        info
    }
}

#[tauri::command]
pub(super) async fn desk_startup(
    retry: bool,
    hub: tauri::State<'_, Arc<DesktopHub>>,
) -> Result<Value, String> {
    let hub = Arc::clone(hub.inner());
    tauri::async_runtime::spawn_blocking(move || hub.status(retry))
        .await
        .map_err(|_| "허브의 상태를 확인하지 못했습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::{
        active_managed_port, configured_port, default_port, matches_local_port, Recovery,
        CURRENT_PORT, LEGACY_PORT,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn a_healthy_response_rearms_the_single_recovery_attempt() {
        let mut recovery = Recovery::default();
        assert!(!recovery.should_start(true, false));
        assert!(!recovery.should_start(false, false));
        assert!(!recovery.should_start(true, false));
        assert!(!recovery.should_start(true, false));
        assert!(recovery.should_start(true, false));
        assert!(
            !recovery.should_start(false, false),
            "a different listener is not a recovered hub"
        );
        assert!(
            !recovery.should_start(true, false),
            "only one start per outage"
        );
        assert!(!recovery.should_start(false, true));
        assert!(!recovery.should_start(true, false));
        assert!(!recovery.should_start(true, false));
        assert!(recovery.should_start(true, false));
    }

    #[test]
    fn managed_ports_use_the_update_workers_string_contract() {
        assert_eq!(
            configured_port(Some(&json!("17641"))).unwrap(),
            Some(CURRENT_PORT)
        );
        assert!(configured_port(Some(&json!(17641))).is_err());
        assert!(configured_port(Some(&json!(null))).is_err());
        assert_eq!(configured_port(None).unwrap(), None);
    }

    #[test]
    fn an_explicit_url_requires_a_matching_port_to_launch_locally() {
        assert!(matches_local_port(CURRENT_PORT, CURRENT_PORT, false, None));
        assert!(!matches_local_port(CURRENT_PORT, CURRENT_PORT, true, None));
        assert!(matches_local_port(
            CURRENT_PORT,
            CURRENT_PORT,
            true,
            Some(CURRENT_PORT)
        ));
        assert!(!matches_local_port(
            LEGACY_PORT,
            CURRENT_PORT,
            true,
            Some(LEGACY_PORT)
        ));
    }

    #[test]
    fn established_data_and_fresh_profiles_choose_stable_ports() {
        let dir = std::env::temp_dir().join(format!("desk-ports-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let db = dir.join("custom.db");
        assert_eq!(default_port(&db, []), CURRENT_PORT);
        fs::write(&db, "").unwrap();
        assert_eq!(default_port(&db, []), LEGACY_PORT);
        fs::write(dir.join(".desk-ports-v2"), "v2\n").unwrap();
        assert_eq!(default_port(&db, []), CURRENT_PORT);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn preparing_update_settings_does_not_switch_the_desktop_to_the_managed_port() {
        let dir = std::env::temp_dir().join(format!("desk-managed-port-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let config =
            json!({"roles": ["hub"], "deploymentDir": dir, "environment": {"PORT": "17641"}});
        assert_eq!(active_managed_port(&config).unwrap(), None);
        fs::write(dir.join("state.json"), r#"{"current":"installed"}"#).unwrap();
        assert_eq!(active_managed_port(&config).unwrap(), Some(CURRENT_PORT));
        fs::remove_dir_all(dir).unwrap();
    }
}
