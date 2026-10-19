use axum::{
    extract::ConnectInfo,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    net::SocketAddr,
    time::Duration,
};
use tokio::net::TcpListener;
use uuid::Uuid;

#[derive(Serialize)]
struct HealthResponse {
    app: &'static str,
    status: &'static str,
    version: &'static str,
    capabilities: [&'static str; 2],
    remote_control_enabled: bool,
}

async fn health(ConnectInfo(_peer): ConnectInfo<SocketAddr>) -> impl IntoResponse {
    Json(HealthResponse {
        app: "RemoteDesk Host",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        capabilities: ["health-check", "temporary-pairing"],
        remote_control_enabled: false,
    })
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartPairingRequest<'a> {
    session_id: &'a str,
    host_secret: &'a str,
    pair_code: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostAuthRequest<'a> {
    session_id: &'a str,
    host_secret: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecisionRequest<'a> {
    session_id: &'a str,
    host_secret: &'a str,
    approve: bool,
}

#[derive(Deserialize)]
struct StatusResponse {
    status: String,
}

fn make_pairing_values() -> (String, String, String) {
    let session_id = Uuid::new_v4().simple().to_string();
    let host_secret = format!(
        "{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let pair_code = Uuid::new_v4().simple().to_string()[..12].to_ascii_uppercase();
    (session_id, host_secret, pair_code)
}

fn format_pair_code(code: &str) -> String {
    format!("{}-{}-{}", &code[0..4], &code[4..8], &code[8..12])
}

async fn post_json<T: Serialize + ?Sized>(client: &reqwest::Client, url: &str, body: &T) -> Result<reqwest::Response, reqwest::Error> {
    client.post(url).json(body).send().await
}

async fn pairing_loop() {
    let api_base = match std::env::var("REMOTEDESK_API_URL") {
        Ok(value) if !value.trim().is_empty() => value.trim().trim_end_matches('/').to_string(),
        _ => {
            println!("Cloudflare pairing: disabled. Set REMOTEDESK_API_URL to enable temporary pairing.");
            return;
        }
    };

    let parsed = match reqwest::Url::parse(&api_base) {
        Ok(url) if url.scheme() == "https" => url,
        _ => {
            eprintln!("Pairing disabled: REMOTEDESK_API_URL must be a valid HTTPS URL.");
            return;
        }
    };
    let _ = parsed;
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Pairing client initialization failed: {error}");
            return;
        }
    };

    let (session_id, host_secret, pair_code) = make_pairing_values();
    let start = StartPairingRequest {
        session_id: &session_id,
        host_secret: &host_secret,
        pair_code: &pair_code,
    };

    match post_json(&client, &format!("{api_base}/api/pairing/start"), &start).await {
        Ok(response) if response.status().is_success() => {
            println!("\nTemporary pairing is ready (expires in 5 minutes).");
            println!("Open the RemoteDesk website on your iPhone and enter this code:");
            println!("  {}", format_pair_code(&pair_code));
            println!("Keep this terminal open. The desktop has not been shared yet.");
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            eprintln!("Could not start pairing (HTTP {status}): {body}");
            return;
        }
        Err(error) => {
            eprintln!("Could not reach RemoteDesk API: {error}");
            return;
        }
    }

    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let status_response = post_json(
            &client,
            &format!("{api_base}/api/pairing/host-status"),
            &HostAuthRequest {
                session_id: &session_id,
                host_secret: &host_secret,
            },
        )
        .await;

        let status: StatusResponse = match status_response {
            Ok(response) if response.status().is_success() => match response.json().await {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("Invalid pairing status response: {error}");
                    return;
                }
            },
            Ok(response) => {
                let code = response.status();
                if code.as_u16() == 404 {
                    eprintln!("Pairing session no longer exists. Restart RemoteDesk Host.");
                    return;
                }
                let body = response.text().await.unwrap_or_default();
                eprintln!("Pairing status request failed (HTTP {code}): {body}");
                return;
            }
            Err(error) => {
                eprintln!("Connection to RemoteDesk API failed: {error}");
                return;
            }
        };

        match status.status.as_str() {
            "waiting" => {}
            "pending" => {
                println!("\nA device entered the pairing code.");
                let answer = tokio::task::spawn_blocking(|| -> io::Result<bool> {
                    print!("Approve this device pairing? [y/N]: ");
                    io::stdout().flush()?;
                    let mut line = String::new();
                    io::stdin().read_line(&mut line)?;
                    let answer = matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes" | "д" | "да");
                    Ok(answer)
                })
                .await;

                let approve = match answer {
                    Ok(Ok(value)) => value,
                    Ok(Err(error)) => {
                        eprintln!("Could not read approval response: {error}");
                        false
                    }
                    Err(error) => {
                        eprintln!("Approval task failed: {error}");
                        false
                    }
                };

                match post_json(
                    &client,
                    &format!("{api_base}/api/pairing/decision"),
                    &DecisionRequest { session_id: &session_id, host_secret: &host_secret, approve },
                ).await {
                    Ok(response) if response.status().is_success() => {
                        if approve {
                            println!("Pairing request approved. The web client can now see the approval.");
                            println!("Note: screen streaming and remote input are not enabled in this phase.");
                        } else {
                            println!("Pairing request rejected.");
                        }
                    }
                    Ok(response) => {
                        let code = response.status();
                        let body = response.text().await.unwrap_or_default();
                        eprintln!("Could not submit pairing decision (HTTP {code}): {body}");
                    }
                    Err(error) => eprintln!("Could not submit pairing decision: {error}"),
                }
                return;
            }
            "approved" => {
                println!("Pairing was approved. Screen streaming is not enabled yet.");
                return;
            }
            "rejected" => {
                println!("Pairing request was rejected.");
                return;
            }
            "expired" => {
                println!("Pairing code expired. Restart RemoteDesk Host to generate a new one.");
                return;
            }
            other => {
                eprintln!("Unknown pairing state: {other}");
                return;
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // The local health endpoint remains loopback-only and cannot control the PC.
    let address: SocketAddr = "127.0.0.1:47831".parse()?;
    let app = Router::new()
        .route("/health", get(health))
        .fallback(not_found)
        .layer(axum::middleware::map_response(|mut response: Response| async move {
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            response
        }));

    let listener = TcpListener::bind(address).await?;
    println!("RemoteDesk Host v{}", env!("CARGO_PKG_VERSION"));
    println!("Health check: http://{address}/health");
    println!("Security: loopback-only; remote control is disabled.");
    println!("Press Ctrl+C to stop.");

    tokio::spawn(pairing_loop());

    axum::serve(app, listener.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        })
        .await?;
    Ok(())
}
