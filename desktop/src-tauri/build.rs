fn main() {
    // The app's own commands, so a capability can grant them to the hub's page.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["desk_notify", "desk_notify_permission"]),
    ))
    .expect("tauri build");
}
