use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter as _;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

pub fn spawn_stats_thread(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let pid = sysinfo::Pid::from_u32(std::process::id());
        loop {
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(proc) = sys.process(pid) {
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let sample = StatsSample {
                    ts,
                    cpu: proc.cpu_usage(),
                    mem_bytes: proc.memory(),
                };
                let _ = app.emit("sys-stats", sample);
            } else {
                eprintln!("sys-stats: process {} not found, skipping sample", pid);
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    });
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSample {
    pub ts: u64,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_serializes_to_camel_case_json() {
        let s = StatsSample { ts: 1_700_000_000_000, cpu: 12.5, mem_bytes: 48 * 1024 * 1024 };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"ts\":1700000000000"), "{json}");
        assert!(json.contains("\"cpu\":12.5"), "{json}");
        assert!(json.contains("\"memBytes\":50331648"), "{json}");
    }
}
