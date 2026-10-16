use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use vessel_core::config::{AppConfig, ConfigStore, ViewConfig};
use vessel_core::DomainService;

#[tauri::command]
fn load_config(store: tauri::State<'_, ConfigStore>) -> Result<AppConfig, String> {
    store.load()
}

#[tauri::command]
fn save_view_config(store: tauri::State<'_, ConfigStore>, view: ViewConfig) -> Result<(), String> {
    store.save_view(view)
}

#[tauri::command]
fn read_model(store: tauri::State<'_, ConfigStore>) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(
        store.read_model()?.unwrap_or_default(),
    ))
}

#[tauri::command]
fn save_model(
    store: tauri::State<'_, ConfigStore>,
    name: String,
    data: Vec<u8>,
) -> Result<(), String> {
    store.save_model(name, data)
}

/// Lets the frontend toggle click-through so clicks pass from the avatar
/// region onto the desktop underneath.
#[tauri::command]
fn toggle_click_through(window: tauri::WebviewWindow, ignore: bool) -> Result<(), tauri::Error> {
    set_click_through(window.app_handle(), ignore)
}

struct ClickThroughMenu(CheckMenuItem<tauri::Wry>);

#[tauri::command]
fn get_click_through(app: tauri::AppHandle) -> Result<bool, tauri::Error> {
    app.state::<ClickThroughMenu>().0.is_checked()
}

fn set_click_through(app: &tauri::AppHandle, ignore: bool) -> Result<(), tauri::Error> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_ignore_cursor_events(ignore)?;
        app.state::<ClickThroughMenu>().0.set_checked(ignore)?;
        win.emit("click-through-changed", ignore)?;
    }
    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}

struct AppServerState {
    _domain_service: Arc<DomainService>,
    shutdown_trigger: Option<tokio::sync::oneshot::Sender<()>>,
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {info:?}");
        let _ = std::fs::write("vessel.panic.log", &msg);
        eprintln!("{msg}");
    }));

    let port: u16 = std::env::var("VESSEL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8765);
    let auth_token = std::env::var("VESSEL_AUTH_TOKEN").ok();
    let domain_service = DomainService::new(auth_token);

    let is_headless = std::env::args().any(|arg| arg == "--headless")
        || std::env::var("VESSEL_HEADLESS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);

    if is_headless {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to initialize tokio runtime");
        rt.block_on(async move {
            match vessel_core::start_server(port, domain_service).await {
                Ok(mut handle) => {
                    eprintln!(
                        "[VESSEL] Native server listening (headless) on 127.0.0.1:{}",
                        handle.port
                    );
                    let _ = tokio::signal::ctrl_c().await;
                    handle.stop().await;
                    eprintln!("[VESSEL] Headless server stopped cleanly.");
                }
                Err(err) => {
                    eprintln!("[VESSEL ERROR] Failed to bind local server on port {port}: {err}");
                }
            }
        });
        return;
    }

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let server_service = domain_service.clone();
    tauri::async_runtime::spawn(async move {
        match vessel_core::start_server(port, server_service).await {
            Ok(mut handle) => {
                eprintln!(
                    "[VESSEL] Native server listening on 127.0.0.1:{}",
                    handle.port
                );
                let _ = shutdown_rx.await;
                handle.stop().await;
                eprintln!("[VESSEL] Native server stopped cleanly.");
            }
            Err(err) => {
                eprintln!("[VESSEL ERROR] Failed to bind local server on port {port}: {err}");
            }
        }
    });

    let app_state = AppServerState {
        _domain_service: domain_service,
        shutdown_trigger: Some(shutdown_tx),
    };

    let result = tauri::Builder::default()
        .manage(std::sync::Mutex::new(app_state))
        .setup(|app| {
            let store = ConfigStore::new(app.path().config_dir()?.join("v.e.s.s.e.l."));
            if let Ok(config) = store.load() {
                if let Ok(preset) =
                    serde_json::from_value(serde_json::Value::String(config.view.framing))
                {
                    app.state::<std::sync::Mutex<AppServerState>>()
                        .lock()
                        .unwrap()
                        ._domain_service
                        .set_framing(preset);
                }
            }
            app.manage(store);
            let windows = app.webview_windows();
            for win in windows.values() {
                let _ = win.set_skip_taskbar(true);
                let _ = win.show();
                let _ = win.set_focus();
            }

            let toggle_item = MenuItem::with_id(
                app,
                "toggle_visibility",
                "Показать / Скрыть",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let click_through_item = CheckMenuItem::with_id(
                app,
                "click_through",
                "Пропускать клики",
                true,
                false,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&toggle_item, &click_through_item, &quit_item])?;
            app.manage(ClickThroughMenu(click_through_item));

            let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico"))
                    .expect("Failed to load tray icon")
            });

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("VESSEL")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle_visibility" => {
                        toggle_main_window(app);
                    }
                    "click_through" => {
                        // Native check menu items already toggle before this callback.
                        if let Ok(ignore) = app.state::<ClickThroughMenu>().0.is_checked() {
                            if let Err(error) = set_click_through(app, ignore) {
                                let _ = app.state::<ClickThroughMenu>().0.set_checked(!ignore);
                                eprintln!("Cannot toggle click-through: {error}");
                            }
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            toggle_click_through,
            get_click_through,
            load_config,
            save_view_config,
            read_model,
            save_model
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            app.run(|app_handle, event| match event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    if let Some(state_mutex) =
                        app_handle.try_state::<std::sync::Mutex<AppServerState>>()
                    {
                        if let Ok(mut state) = state_mutex.lock() {
                            if let Some(trigger) = state.shutdown_trigger.take() {
                                let _ = trigger.send(());
                            }
                        }
                    }
                }
                _ => {}
            });
        }
        Err(e) => {
            let msg = format!("TAURI RUN ERROR: {e:?}");
            let _ = std::fs::write("vessel.err.log", &msg);
            eprintln!("{msg}");
        }
    }
}
