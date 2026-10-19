use anyhow::{Context, Result, anyhow};
use axum::{
    extract::ConnectInfo,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use bytes::Bytes;
use screenshots::{Screen, image::{DynamicImage, codecs::jpeg::JpegEncoder, imageops::{self, FilterType}}};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    net::SocketAddr,
    time::Duration,
};
use tokio::net::TcpListener;
use uuid::Uuid;
use webrtc::{
    api::{media_engine::MediaEngine, APIBuilder},
    data_channel::RTCDataChannel,
    ice_transport::ice_server::RTCIceServer,
    peer_connection::{configuration::RTCConfiguration, sdp::session_description::RTCSessionDescription},
};

const SIGNAL_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SCREEN_FRAME_INTERVAL: Duration = Duration::from_millis(700);
const MAX_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Serialize)]
struct HealthResponse {
    app: &'static str,
    status: &'static str,
    version: &'static str,
    capabilities: [&'static str; 3],
    remote_control_enabled: bool,
}

async fn health(ConnectInfo(_peer): ConnectInfo<SocketAddr>) -> impl IntoResponse {
    Json(HealthResponse {
        app: "RemoteDesk Host",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        capabilities: ["health-check", "temporary-pairing", "webrtc-screen-preview"],
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSignalRequest<'a> {
    session_id: &'a str,
    host_secret: &'a str,
    description: &'a str,
}

#[derive(Deserialize)]
struct StatusResponse {
    status: String,
}

#[derive(Deserialize)]
struct SignalResponse {
    status: String,
    description: Option<String>,
}

fn make_pairing_values() -> (String, String, String) {
    let session_id = Uuid::new_v4().simple().to_string();
    let host_secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let pair_code = Uuid::new_v4().simple().to_string()[..12].to_ascii_uppercase();
    (session_id, host_secret, pair_code)
}

fn format_pair_code(code: &str) -> String {
    format!("{}-{}-{}", &code[0..4], &code[4..8], &code[8..12])
}

async fn post_json<T: Serialize + ?Sized>(
    client: &reqwest::Client,
    url: &str,
    body: &T,
) -> Result<reqwest::Response, reqwest::Error> {
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

    match reqwest::Url::parse(&api_base) {
        Ok(url) if url.scheme() == "https" => {}
        _ => {
            eprintln!("Pairing disabled: REMOTEDESK_API_URL must be a valid HTTPS URL.");
            return;
        }
    }
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(20)).build() {
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
            println!("\nTemporary pairing is ready (expires in 5 minutes).\nOpen the RemoteDesk website on your iPhone and enter this code:\n  {}", format_pair_code(&pair_code));
            println!("Keep this terminal open. The screen is not shared until you approve a pairing request.");
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
        tokio::time::sleep(SIGNAL_POLL_INTERVAL).await;
        let status_response = post_json(
            &client,
            &format!("{api_base}/api/pairing/host-status"),
            &HostAuthRequest { session_id: &session_id, host_secret: &host_secret },
        ).await;

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
                    Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes" | "д" | "да"))
                }).await;
                let approve = match answer {
                    Ok(Ok(value)) => value,
                    Ok(Err(error)) => { eprintln!("Could not read approval response: {error}"); false }
                    Err(error) => { eprintln!("Approval task failed: {error}"); false }
                };

                match post_json(
                    &client,
                    &format!("{api_base}/api/pairing/decision"),
                    &DecisionRequest { session_id: &session_id, host_secret: &host_secret, approve },
                ).await {
                    Ok(response) if response.status().is_success() => {
                        if approve {
                            println!("Pairing approved. Negotiating a peer-to-peer WebRTC connection…");
                            println!("Only a read-only screen preview is enabled in this phase; mouse and keyboard input remain disabled.");
                            if let Err(error) = run_screen_stream(&client, &api_base, &session_id, &host_secret).await {
                                eprintln!("Screen preview stopped: {error:#}");
                            }
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
                println!("Pairing was approved. Starting read-only screen preview…");
                if let Err(error) = run_screen_stream(&client, &api_base, &session_id, &host_secret).await {
                    eprintln!("Screen preview stopped: {error:#}");
                }
                return;
            }
            "rejected" => { println!("Pairing request was rejected."); return; }
            "expired" => { println!("Pairing code expired. Restart RemoteDesk Host to generate a new one."); return; }
            other => { eprintln!("Unknown pairing state: {other}"); return; }
        }
    }
}

async fn run_screen_stream(client: &reqwest::Client, api_base: &str, session_id: &str, host_secret: &str) -> Result<()> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().context("register WebRTC codecs")?;
    let api = APIBuilder::new().with_media_engine(media_engine).build();
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }],
        ..Default::default()
    };
    let peer_connection = std::sync::Arc::new(api.new_peer_connection(config).await.context("create WebRTC peer connection")?);
    let data_channel = peer_connection.create_data_channel("screen-frames", None).await.context("create screen data channel")?;

    let (open_tx, mut open_rx) = tokio::sync::mpsc::channel::<()>(1);
    data_channel.on_open(Box::new(move || {
        let tx = open_tx.clone();
        Box::pin(async move { let _ = tx.send(()).await; })
    }));

    let offer = peer_connection.create_offer(None).await.context("create WebRTC offer")?;
    let mut gather_complete = peer_connection.gathering_complete_promise().await;
    peer_connection.set_local_description(offer).await.context("set local WebRTC offer")?;
    let _ = tokio::time::timeout(Duration::from_secs(25), gather_complete.recv()).await
        .context("timed out gathering ICE candidates")?;
    let local_description = peer_connection.local_description().await.ok_or_else(|| anyhow!("WebRTC offer was not created"))?;
    let description_json = serde_json::to_string(&local_description).context("serialize WebRTC offer")?;
    let offer_request = HostSignalRequest { session_id, host_secret, description: &description_json };
    let response = post_json(client, &format!("{api_base}/api/rtc/host-offer"), &offer_request).await
        .context("send WebRTC offer to Cloudflare")?;
    if !response.status().is_success() {
        let code = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("Cloudflare rejected WebRTC offer (HTTP {code}): {body}"));
    }
    println!("WebRTC offer published. Waiting for the iPhone answer…");

    let answer_deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let answer_description = loop {
        if tokio::time::Instant::now() >= answer_deadline {
            return Err(anyhow!("timed out waiting for iPhone WebRTC answer"));
        }
        tokio::time::sleep(SIGNAL_POLL_INTERVAL).await;
        let response = post_json(
            client,
            &format!("{api_base}/api/rtc/host-answer"),
            &HostAuthRequest { session_id, host_secret },
        ).await.context("poll WebRTC answer")?;
        if !response.status().is_success() {
            let code = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!("Cloudflare answer polling failed (HTTP {code}): {body}"));
        }
        let state: SignalResponse = response.json().await.context("parse WebRTC answer state")?;
        if state.status == "ready" {
            break state.description.ok_or_else(|| anyhow!("Cloudflare returned ready without an answer"))?;
        }
        if state.status == "expired" || state.status == "rejected" {
            return Err(anyhow!("pairing session ended with status {}", state.status));
        }
    };

    let answer: RTCSessionDescription = serde_json::from_str(&answer_description).context("parse iPhone WebRTC answer")?;
    peer_connection.set_remote_description(answer).await.context("apply iPhone WebRTC answer")?;
    println!("WebRTC answer applied. Waiting for the encrypted data channel to open…");
    tokio::time::timeout(Duration::from_secs(45), open_rx.recv()).await
        .context("timed out waiting for the WebRTC data channel")?;
    println!("Screen preview connected. Sending reduced-resolution JPEG frames (read-only). Press Ctrl+C to stop.");

    let screens = Screen::all().context("enumerate displays for screen capture")?;
    let screen = screens.into_iter().next().ok_or_else(|| anyhow!("Windows reported no capturable display"))?;
    let mut frame_id: u32 = 0;
    loop {
        let frame = capture_screen_jpeg(&screen).context("capture and encode desktop frame")?;
        send_frame_chunks(&data_channel, frame_id, &frame).await.context("send screen frame over WebRTC")?;
        frame_id = frame_id.wrapping_add(1);
        tokio::time::sleep(SCREEN_FRAME_INTERVAL).await;
    }
}

async fn send_frame_chunks(data_channel: &RTCDataChannel, frame_id: u32, frame: &[u8]) -> Result<()> {
    const HEADER_BYTES: usize = 8;
    let chunk_count = frame.len().div_ceil(MAX_CHUNK_BYTES);
    if chunk_count == 0 || chunk_count > u16::MAX as usize {
        return Err(anyhow!("encoded screen frame is outside the supported size"));
    }
    for (index, chunk) in frame.chunks(MAX_CHUNK_BYTES).enumerate() {
        let mut packet = Vec::with_capacity(HEADER_BYTES + chunk.len());
        packet.extend_from_slice(&frame_id.to_be_bytes());
        packet.extend_from_slice(&(index as u16).to_be_bytes());
        packet.extend_from_slice(&(chunk_count as u16).to_be_bytes());
        packet.extend_from_slice(chunk);
        data_channel.send(&Bytes::from(packet)).await.context("send WebRTC data-channel chunk")?;
    }
    Ok(())
}

fn capture_screen_jpeg(screen: &Screen) -> Result<Vec<u8>> {
    let screenshot = screen.capture().context("capture display")?;
    let (original_width, original_height) = screenshot.dimensions();
    if original_width == 0 || original_height == 0 {
        return Err(anyhow!("captured display has zero dimensions"));
    }
    let scale = (800.0_f32 / original_width as f32)
        .min(600.0_f32 / original_height as f32)
        .min(1.0);
    let width = ((original_width as f32 * scale).round() as u32).max(1);
    let height = ((original_height as f32 * scale).round() as u32).max(1);
    let resized = imageops::resize(&screenshot, width, height, FilterType::Triangle);
    let rgb = DynamicImage::ImageRgba8(resized).to_rgb8();
    let mut encoded = Vec::with_capacity(48 * 1024);
    JpegEncoder::new_with_quality(&mut encoded, 38)
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .context("encode JPEG frame")?;
    Ok(encoded)
}

#[tokio::main]
async fn main() -> Result<()> {
    // The local health endpoint stays loopback-only. It exposes no remote input.
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
    println!("Security: loopback-only health endpoint; remote mouse and keyboard are disabled.");
    println!("Press Ctrl+C to stop.");
    tokio::spawn(pairing_loop());

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        })
        .await?;
    Ok(())
}
