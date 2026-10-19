use axum::{
    extract::ConnectInfo,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::{net::SocketAddr, time::Duration};
use tokio::net::TcpListener;

#[derive(Serialize)]
struct HealthResponse {
    app: &'static str,
    status: &'static str,
    version: &'static str,
    capabilities: [&'static str; 1],
    remote_control_enabled: bool,
}

async fn health(ConnectInfo(_peer): ConnectInfo<SocketAddr>) -> impl IntoResponse {
    Json(HealthResponse {
        app: "RemoteDesk Host",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        capabilities: ["health-check"],
        remote_control_enabled: false,
    })
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Phase 1 binds ONLY to loopback. Do not change this to 0.0.0.0.
    let address: SocketAddr = "127.0.0.1:47831".parse()?;
    let app = Router::new()
        .route("/health", get(health))
        .fallback(not_found)
        .layer(axum::middleware::map_response(|mut response: Response| async move {
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );
            response.headers_mut().insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            response
        }));

    let listener = TcpListener::bind(address).await?;
    println!("RemoteDesk Host v{}", env!("CARGO_PKG_VERSION"));
    println!("Health check: http://{address}/health");
    println!("Security: loopback-only; remote control is disabled.");
    println!("Press Ctrl+C to stop.");

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        })
        .await?;
    Ok(())
}
