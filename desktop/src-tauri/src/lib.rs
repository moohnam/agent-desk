//! Agent Desk desktop shell.
//!
//! Loads the hub (overridable via AGENT_DESK_URL) in a
//! single window and forwards Finder drag & drop to the page as DOM CustomEvents carrying
//! the files' absolute paths. A local hub not yet running is started (and starts the runner) from
//! this repository; both keep running after the app quits, for phones and running agents.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;

use tauri::{DragDropEvent, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

#[cfg(target_os = "macos")]
mod notify;
mod hub_startup;
use hub_startup::{repo_dir, DesktopHub};

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

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Runs on every page load, including the local connection page.
fn init_script(hub: &Url) -> String {
    let hub_json = serde_json::to_string(hub.as_str()).unwrap();
    format!(
        "window.__AGENT_DESK_APP__ = true;\n\
         window.__AGENT_DESK_HUB_URL__ = {hub_json};\n\
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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        // WebKit discarded this document. The bundled page can wait for the hub
        // even if the network has not returned yet after waking the Mac.
        let webview = webview.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = webview.navigate(Url::parse("tauri://localhost/index.html").unwrap()) {
                eprintln!("[agent-desk] could not restore the connection page: {error}");
            }
        });
    });
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desk_notify, desk_notify_permission, hub_startup::desk_startup])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            notify::init(app.handle());
            let startup = Arc::new(DesktopHub::new());
            let hub = startup.url.clone();
            app.manage(startup.clone());
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
                    .permission("allow-desk-startup")
                    .permission("core:webview:allow-set-webview-zoom"),
            )?;
            let nav_hub = hub.clone();
            let nav_handle = app.handle().clone();
            let popup_handle = app.handle().clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent Desk")
                .inner_size(1500.0, 950.0)
                .min_inner_size(800.0, 500.0)
                .zoom_hotkeys_enabled(true)
                .initialization_script(init_script(&hub))
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
            startup.monitor();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) { startup.close(); }
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
