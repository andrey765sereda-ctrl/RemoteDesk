use anyhow::{Context, Result, anyhow};
use axum::{
    extract::ConnectInfo,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use bytes::Bytes;
use openh264::{encoder::Encoder, formats::RgbSliceU8};
use screenshots::{Screen, image::{DynamicImage, imageops::{self, FilterType}}};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    net::SocketAddr,
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use uuid::Uuid;
use webrtc::{
    api::{media_engine::{MediaEngine, MIME_TYPE_H264}, APIBuilder},
    media::Sample,
    ice_transport::ice_server::RTCIceServer,
    peer_connection::{configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState, sdp::session_description::RTCSessionDescription},
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::track_local::{TrackLocal, track_local_static_sample::TrackLocalStaticSample},
};

const SIGNAL_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SCREEN_FRAME_INTERVAL: Duration = Duration::from_millis(67);
const STREAM_STATS_INTERVAL: Duration = Duration::from_secs(5);
const MAX_SCREEN_WIDTH: u32 = 1280;
const MAX_SCREEN_HEIGHT: u32 = 720;

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

fn summarize_candidates(sdp: &str) -> String {
    let (mut host, mut srflx, mut relay, mut prflx) = (0usize, 0usize, 0usize, 0usize);
    for line in sdp.lines().filter(|line| line.starts_with("a=candidate:")) {
        if line.contains(" typ host") { host += 1; }
        else if line.contains(" typ srflx") { srflx += 1; }
        else if line.contains(" typ relay") { relay += 1; }
        else if line.contains(" typ prflx") { prflx += 1; }
    }
    format!("host={host}, srflx={srflx}, relay={relay}, prflx={prflx}")
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

fn direct_ice_servers() -> Vec<RTCIceServer> {
    // STUN only: no TURN relay or relay credentials are used in this build.
    vec![RTCIceServer {
        urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
        ..Default::default()
    }]
}
async fn run_screen_stream(client: &reqwest::Client, api_base: &str, session_id: &str, host_secret: &str) -> Result<()> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().context("register WebRTC codecs")?;
    let api = APIBuilder::new().with_media_engine(media_engine).build();
    let config = RTCConfiguration {
        ice_servers: direct_ice_servers(),
        ..Default::default()
    };
    println!("WebRTC network mode: direct connection with STUN only; TURN is disabled.");
    println!("Video codec: H.264 / OpenH264 software encoder, target 15 FPS, maximum 1280x720.");

    let peer_connection = std::sync::Arc::new(
        api.new_peer_connection(config).await.context("create WebRTC peer connection")?
    );

    // Send an actual H.264 RTP video track instead of individual JPEG frames over a data channel.
    let video_track = std::sync::Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_H264.to_owned(),
            ..Default::default()
        },
        "screen-video".to_owned(),
        "remotedesk".to_owned(),
    ));
    let rtp_sender = peer_connection
        .add_track(std::sync::Arc::clone(&video_track) as std::sync::Arc<dyn TrackLocal + Send + Sync>)
        .await
        .context("add H.264 video track")?;

    // Drain incoming RTCP feedback so the sender's RTCP reader does not remain blocked.
    tokio::spawn(async move {
        let mut rtcp_buffer = vec![0_u8; 1500];
        while let Ok((_size, _attributes)) = rtp_sender.read(&mut rtcp_buffer).await {}
    });

    let (state_tx, mut state_rx) = tokio::sync::mpsc::channel::<RTCPeerConnectionState>(8);
    peer_connection.on_peer_connection_state_change(Box::new(move |state| {
        println!("WebRTC peer connection state: {state}");
        let _ = state_tx.try_send(state);
        Box::pin(async {})
    }));

    let offer = peer_connection.create_offer(None).await.context("create WebRTC offer")?;
    let mut gather_complete = peer_connection.gathering_complete_promise().await;
    peer_connection.set_local_description(offer).await.context("set local WebRTC offer")?;
    let _ = tokio::time::timeout(Duration::from_secs(25), gather_complete.recv()).await
        .context("timed out gathering ICE candidates")?;
    let local_description = peer_connection.local_description().await.ok_or_else(|| anyhow!("WebRTC offer was not created"))?;
    println!("Local ICE candidates: {}", summarize_candidates(&local_description.sdp));
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
    println!("iPhone ICE candidates: {}", summarize_candidates(&answer.sdp));
    if !answer.sdp.to_ascii_lowercase().contains("h264") {
        return Err(anyhow!("the iPhone WebRTC answer did not negotiate H.264; check browser codec support"));
    }
    peer_connection.set_remote_description(answer).await.context("apply iPhone WebRTC answer")?;
    println!("WebRTC answer applied. Waiting for the H.264 media transport to connect…");

    let connection_result = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            match state_rx.recv().await {
                Some(RTCPeerConnectionState::Connected) => return Ok(()),
                Some(RTCPeerConnectionState::Failed) => return Err(anyhow!("WebRTC peer connection failed before video could start")),
                Some(RTCPeerConnectionState::Closed) => return Err(anyhow!("WebRTC peer connection closed before video could start")),
                Some(_) => {}
                None => return Err(anyhow!("WebRTC state observer closed")),
            }
        }
    }).await.context("timed out waiting for WebRTC media transport to connect")?;
    connection_result?;

    let screens = Screen::all().context("enumerate displays for screen capture")?;
    let screen = screens.into_iter().next().ok_or_else(|| anyhow!("Windows reported no capturable display"))?;
    let mut encoder = Encoder::new().map_err(|error| anyhow!("initialize OpenH264 encoder: {error}"))?;

    println!("H.264 screen preview connected. Sending encoded RTP video (read-only). Press Ctrl+C to stop.");
    println!("Video size is capped at 1280x720; target frame rate is about 15 FPS. Encoder is software-based in this build.");

    let mut stats_started = Instant::now();
    let mut stats_frames: u64 = 0;
    let mut stats_bytes: u64 = 0;
    let mut stats_capture_time = Duration::ZERO;
    let mut stats_encode_time = Duration::ZERO;
    let mut stats_send_time = Duration::ZERO;

    loop {
        let cycle_started = Instant::now();
        let capture_started = Instant::now();
        let (rgb, width, height) = capture_screen_rgb(&screen).context("capture desktop frame")?;
        let capture_elapsed = capture_started.elapsed();

        let encode_started = Instant::now();
        let rgb_source = RgbSliceU8::new(&rgb, (width, height));
        let encoded = encoder
            .encode(&rgb_source)
            .map_err(|error| anyhow!("H.264 encode failed: {error}"))?
            .to_vec();
        let encode_elapsed = encode_started.elapsed();

        if !encoded.is_empty() {
            let encoded_size = encoded.len();
            let send_started = Instant::now();
            let sample = Sample {
                data: Bytes::from(encoded),
                duration: SCREEN_FRAME_INTERVAL,
                ..Default::default()
            };
            video_track.write_sample(&sample).await.context("send H.264 RTP video sample")?;
            let send_elapsed = send_started.elapsed();

            stats_frames += 1;
            stats_bytes = stats_bytes.saturating_add(encoded_size as u64);
            stats_capture_time += capture_elapsed;
            stats_encode_time += encode_elapsed;
            stats_send_time += send_elapsed;
        }

        let stats_elapsed = stats_started.elapsed();
        if stats_elapsed >= STREAM_STATS_INTERVAL {
            let frames = stats_frames.max(1) as f64;
            println!(
                "H.264 performance: {:.1} FPS | avg frame {:.1} KiB | capture {:.0} ms | encode {:.0} ms | send {:.0} ms",
                stats_frames as f64 / stats_elapsed.as_secs_f64(),
                stats_bytes as f64 / frames / 1024.0,
                stats_capture_time.as_secs_f64() * 1000.0 / frames,
                stats_encode_time.as_secs_f64() * 1000.0 / frames,
                stats_send_time.as_secs_f64() * 1000.0 / frames,
            );
            stats_started = Instant::now();
            stats_frames = 0;
            stats_bytes = 0;
            stats_capture_time = Duration::ZERO;
            stats_encode_time = Duration::ZERO;
            stats_send_time = Duration::ZERO;
        }

        let cycle_elapsed = cycle_started.elapsed();
        if cycle_elapsed < SCREEN_FRAME_INTERVAL {
            tokio::time::sleep(SCREEN_FRAME_INTERVAL - cycle_elapsed).await;
        }
    }
}

fn capture_screen_rgb(screen: &Screen) -> Result<(Vec<u8>, usize, usize)> {
    let screenshot = screen.capture().context("capture display")?;
    let (original_width, original_height) = screenshot.dimensions();
    if original_width == 0 || original_height == 0 {
        return Err(anyhow!("captured display has zero dimensions"));
    }

    let scale = (MAX_SCREEN_WIDTH as f32 / original_width as f32)
        .min(MAX_SCREEN_HEIGHT as f32 / original_height as f32)
        .min(1.0);
    // H.264 4:2:0 input requires even dimensions.
    let width = (((original_width as f32 * scale).round() as u32).max(2)) & !1;
    let height = (((original_height as f32 * scale).round() as u32).max(2)) & !1;
    let resized = imageops::resize(&screenshot, width, height, FilterType::Triangle);
    let rgb = DynamicImage::ImageRgba8(resized).to_rgb8().into_raw();
    Ok((rgb, width as usize, height as usize))
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
