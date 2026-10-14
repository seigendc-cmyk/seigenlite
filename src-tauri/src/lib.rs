#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Dispatch: save the Delivery Note to Documents/seiGEN/Dispatches, reveal
    // it, and open WhatsApp. Reached from JS via window.__TAURI__ (withGlobalTauri).
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    // No service worker inside the program (it can't update itself here, so
    // an old one kept serving an old build after a new install): see sw-off.js.
    .plugin(
      tauri::plugin::Builder::<tauri::Wry>::new("sw-off")
        .js_init_script(include_str!("../sw-off.js").to_string())
        .build(),
    )
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
