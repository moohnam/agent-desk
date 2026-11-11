//! Agent Desk desktop shell.
//!
//! Loads the hub (default http://127.0.0.1:4317/, overridable via AGENT_DESK_URL) in a
//! single window and forwards Finder drag & drop to the page as DOM CustomEvents carrying
//! the files' absolute paths. A local hub not yet running is started (and starts the runner) from
//! this repository; both keep running after the app quits, for phones and running agents.

use std::fs::OpenOptions;
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::{DragDropEvent, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[cfg(target_os = "macos")]
mod notify;

const DEFAULT_URL: &str = "http://127.0.0.1:4317/";

/// Shows an OS notification; a click opens `task`'s thread.
#[tauri::command]
fn desk_notify(id: String, title: String, body: String, task: Option<String>) {
    #[cfg(target_os = "macos")]
    notify::post(&id, &title, &body, task.as_deref());
    #[cfg(not(target_os = "macos"))]
    let _ = (id, title, body, task);
}

/// Asks the OS for permission to notify (a prompt the first time); whether it is given.
#[tauri::command]
async fn desk_notify_permission() -> bool {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(notify::authorize).await.unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    false
}

fn hub_url() -> Url {
    let raw = std::env::var("AGENT_DESK_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());
    Url::parse(raw.trim()).unwrap_or_else(|e| {
        eprintln!("[agent-desk] invalid AGENT_DESK_URL {raw:?}: {e}; falling back to {DEFAULT_URL}");
        Url::parse(DEFAULT_URL).unwrap()
    })
}

/// Quick TCP reachability check (does not spawn or touch the hub).
fn hub_reachable(url: &Url) -> bool {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(800)).is_ok())
}

/// The agent-desk repository: AGENT_DESK_HOME, else the one this app was built from.
fn repo_dir() -> PathBuf {
    std::env::var_os("AGENT_DESK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")))
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")))
}

/// Starts `node <script>` in its own process group (so it outlives the app), logging to
/// data/<log>. Through a login shell: an app launched from Finder lacks the shell's PATH,
/// which node and the agents' CLIs need.
fn spawn_node(cwd: PathBuf, script: &str, log: &str, envs: &[(&str, String)]) -> Result<(), String> {
    let log_path = repo_dir().join("data").join(log);
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("{}: {e}", log_path.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(format!("exec node {script}"))
        .current_dir(&cwd)
        .envs(envs.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("node {script}: {e}"))?;
    // Reap it if it exits while the app runs.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Starts the hub, which in turn starts the runner when that is not up either.
fn start_local(hub: &Url) -> Result<(), String> {
    let repo = repo_dir();
    if !repo.join("hub/src/index.ts").exists() {
        return Err(format!("허브 코드를 찾을 수 없습니다: {}", repo.display()));
    }
    let port = hub.port_or_known_default().unwrap_or(4317).to_string();
    spawn_node(repo.join("hub"), "src/index.ts", "hub.log", &[("PORT", port)])
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Runs on every page load (hub page and the local "hub not running" page). `start`: what
/// happened to a hub that was not up ("starting", or why it could not be started).
fn init_script(hub: &Url, start: &str) -> String {
    let hub_json = serde_json::to_string(hub.as_str()).unwrap();
    let start_json = serde_json::to_string(start).unwrap();
    format!(
        "window.__AGENT_DESK_APP__ = true;\n\
         window.__AGENT_DESK_HUB_URL__ = {hub_json};\n\
         window.__AGENT_DESK_START__ = {start_json};\n\
         window.dispatchEvent(new Event('desk-app'));\n\
         document.addEventListener('DOMContentLoaded', function () {{ window.dispatchEvent(new Event('desk-app')); }});"
    )
}

fn drag_js(over: bool) -> String {
    format!("window.dispatchEvent(new CustomEvent('desk-drag', {{ detail: {{ over: {over} }} }}));")
}

/// `desk-drop` with the dropped files' paths; for a drag from a web page (no files), its
/// address (`url`) and markup (`html`, an image's <img src>), for the page to download.
fn drop_js(paths: &[PathBuf], web: Option<WebDrag>) -> String {
    let list: Vec<String> = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let (url, html) = web.map(|w| (w.url, w.html)).unwrap_or_default();
    let detail = serde_json::json!({ "paths": list, "url": url, "html": html });
    format!("window.dispatchEvent(new CustomEvent('desk-drop', {{ detail: {detail} }}));")
}

#[derive(Default)]
struct WebDrag {
    url: Option<String>,
    html: Option<String>,
}

/// What a drag without files (an image or a link from a web page) carries. Tauri takes every
/// drag, so the page never sees these; read them from the drag pasteboard. An image with no
/// address (only its pixels) is saved under data/uploads and passed as a path.
#[cfg(target_os = "macos")]
fn web_drag() -> (Vec<PathBuf>, Option<WebDrag>) {
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeHTML, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
        NSPasteboardTypeURL,
    };
    unsafe {
        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        let text = |t| pb.stringForType(t).map(|s| s.to_string()).filter(|s| !s.is_empty());
        let web = WebDrag { url: text(NSPasteboardTypeURL), html: text(NSPasteboardTypeHTML) };
        if web.url.is_some() || web.html.is_some() {
            return (vec![], Some(web));
        }
        for (t, ext) in [(NSPasteboardTypePNG, "png"), (NSPasteboardTypeTIFF, "tiff")] {
            if let Some(data) = pb.dataForType(t) {
                return match save_image(&data.to_vec(), ext) {
                    Ok(p) => (vec![p], None),
                    Err(e) => {
                        eprintln!("[agent-desk] could not save dragged image: {e}");
                        (vec![], None)
                    }
                };
            }
        }
        (vec![], None)
    }
}

#[cfg(not(target_os = "macos"))]
fn web_drag() -> (Vec<PathBuf>, Option<WebDrag>) {
    (vec![], None)
}

/// Saves dragged image pixels as data/uploads/<today>/<random>-dragged.png (TIFF converted).
fn save_image(bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let day = Command::new("/bin/date").arg("+%Y-%m-%d").output().map_err(|e| e.to_string())?;
    let dir = repo_dir().join("data/uploads").join(String::from_utf8_lossy(&day.stdout).trim());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = format!("{:08x}-dragged", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0));
    let raw = dir.join(format!("{stem}.{ext}"));
    std::fs::write(&raw, bytes).map_err(|e| e.to_string())?;
    if ext == "png" {
        return Ok(raw);
    }
    let png = dir.join(format!("{stem}.png"));
    let ok = Command::new("/usr/bin/sips").args(["-s", "format", "png"]).arg(&raw).arg("--out").arg(&png)
        .stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if ok {
        let _ = std::fs::remove_file(&raw);
        Ok(png)
    } else {
        Ok(raw)
    }
}

/// The URL pattern of the hub's origin (`http://127.0.0.1:4317/*`), or None for a host the pattern
/// syntax can't hold (IPv6).
fn notification_origin(hub: &Url) -> Option<String> {
    let host = match hub.host()? {
        url::Host::Domain(d) => d.to_string(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(_) => return None,
    };
    let port = hub.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{host}{port}/*", hub.scheme()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desk_notify, desk_notify_permission])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            notify::init(app.handle());
            let hub = hub_url();
            // Only the configured hub origin can show notifications or change this window's zoom.
            // The local "hub not running" page gets zoom only, never notification permissions.
            // Tauri panics on a pattern it can't parse, and an IPv6 host ([::1]) is one: such a
            // hub gets no notifications rather than an app that won't start.
            if let Some(pattern) = notification_origin(&hub) {
                app.add_capability(
                    tauri::ipc::CapabilityBuilder::new("hub-notifications")
                        .remote(pattern)
                        .local(false)
                        .window("main")
                        .permission("allow-desk-notify")
                        .permission("allow-desk-notify-permission")
                        .permission("core:webview:allow-set-webview-zoom"),
                )?;
            } else {
                eprintln!("[agent-desk] notifications off: hub address {hub} is not a plain host name or IPv4 address");
            }
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("local-window-zoom")
                    .local(true)
                    .window("main")
                    .permission("core:webview:allow-set-webview-zoom"),
            )?;
            let mut started = String::new();
            let start = if hub_reachable(&hub) {
                WebviewUrl::External(hub.clone())
            } else {
                started = if !is_loopback(&hub) {
                    "remote".into()
                } else {
                    match start_local(&hub) {
                        Ok(()) => "starting".into(),
                        Err(e) => e,
                    }
                };
                eprintln!("[agent-desk] hub not reachable at {hub}; {started}");
                WebviewUrl::App("index.html".into())
            };

            let nav_hub = hub.clone();
            let nav_handle = app.handle().clone();
            let popup_handle = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", start)
                .title("Agent Desk")
                .inner_size(1500.0, 950.0)
                .min_inner_size(800.0, 500.0)
                .zoom_hotkeys_enabled(true)
                .initialization_script(init_script(&hub, &started))
                // Same-origin (hub) and internal app pages stay in the window;
                // other http(s) links open in the system browser.
                .on_navigation(move |url| {
                    match url.scheme() {
                        "http" | "https" => {
                            if same_origin(url, &nav_hub) {
                                true
                            } else {
                                let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                                false
                            }
                        }
                        _ => true,
                    }
                })
                // target=_blank / window.open -> system browser instead of a new app window.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = popup_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            let target = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::DragDrop(dd) = event {
                    let js = match dd {
                        DragDropEvent::Enter { .. } => drag_js(true),
                        DragDropEvent::Over { .. } => return,
                        DragDropEvent::Leave => drag_js(false),
                        DragDropEvent::Drop { paths, .. } => {
                            let js = if paths.is_empty() {
                                let (saved, web) = web_drag();
                                drop_js(&saved, web)
                            } else {
                                drop_js(paths, None)
                            };
                            format!("{}\n{}", js, drag_js(false))
                        }
                        _ => return,
                    };
                    if let Err(e) = target.eval(&js) {
                        eprintln!("[agent-desk] eval failed: {e}");
                    }
                }
            });

            let _ = app.get_webview_window("main").map(|w| w.set_focus());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Agent Desk");
}
