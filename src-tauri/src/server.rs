use axum::routing::get;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::health::{health_handler, not_found_handler};
use crate::mcp_server::{mcp_get_handler, mcp_post_handler};
use crate::service::DomainService;
use crate::ws_server::ws_avatar_handler;

pub struct ServerHandle {
    pub port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
}

impl ServerHandle {
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.await;
        }
    }
}

pub fn create_router(service: Arc<DomainService>) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health_handler))
        .route("/mcp", get(mcp_get_handler).post(mcp_post_handler))
        .route("/ws/avatar", get(ws_avatar_handler))
        .fallback(not_found_handler)
        .with_state(service)
}

pub async fn start_server(
    port: u16,
    service: Arc<DomainService>,
) -> Result<ServerHandle, std::io::Error> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr).await?;
    let actual_port = listener.local_addr()?.port();
    let app = create_router(service);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let join_handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap_or_default();
    });

    Ok(ServerHandle {
        port: actual_port,
        shutdown_tx: Some(shutdown_tx),
        join_handle: Some(join_handle),
    })
}
