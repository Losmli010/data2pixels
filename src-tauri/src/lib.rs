use std::sync::Arc;
use tauri::Manager as _;

mod acq;
mod stats;
pub use acq::AcqEngine;

#[tauri::command]
fn start_acq(running: tauri::State<'_, Arc<std::sync::atomic::AtomicBool>>) {
    running.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn stop_acq(running: tauri::State<'_, Arc<std::sync::atomic::AtomicBool>>) {
    running.store(false, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn set_acq_config(
    config: acq::GenParams,
    params: tauri::State<'_, Arc<std::sync::Mutex<acq::GenParams>>>,
) -> Result<(), String> {
    *params.lock().map_err(|e| e.to_string())? = config.clamped();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_acq, stop_acq, set_acq_config])
        .setup(|app| {
            let engine = AcqEngine::spawn(app.handle().clone());
            app.manage(engine.running.clone());
            app.manage(engine.params.clone());
            stats::spawn_stats_thread(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
