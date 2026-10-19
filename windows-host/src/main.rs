use anyhow::{Context, Result, anyhow};
use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    net::SocketAddr,
    sync::mpsc::{self, Receiver},
    time::Duration,
};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const SIGNAL_POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    app: &'static str,
    status: &'static str,
    version: &'static str,
    capabilities: [&'static str; 3],
    remote_control_enabled: bool,
}

async fn health() -> impl IntoResponse {
    Json(HealthResponse {
        app: "RemoteDesk Host",
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        capabilities: ["health-check", "temporary-pairing", "remote-input-websocket"],
        remote_control_enabled: true,
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
            println!("Remote control pairing disabled. Set REMOTEDESK_API_URL to the HTTPS Cloudflare Worker URL.");
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
        Err(error) => { eprintln!("Pairing client initialization failed: {error}"); return; }
    };

    let (session_id, host_secret, pair_code) = make_pairing_values();
    let start = StartPairingRequest {
        session_id: &session_id,
        host_secret: &host_secret,
        pair_code: &pair_code,
    };
    match post_json(&client, &format!("{api_base}/api/pairing/start"), &start).await {
        Ok(response) if response.status().is_success() => {
            println!("\nRemoteDesk Host v{}", env!("CARGO_PKG_VERSION"));
            println!("Temporary pairing is ready (expires in 5 minutes).\nEnter this code on your RemoteDesk website:\n  {}", format_pair_code(&pair_code));
            println!("Approve every pairing request only if you initiated it. After approval, the Host will accept mouse and keyboard commands through an authenticated outbound WebSocket.");
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            eprintln!("Could not start pairing (HTTP {status}): {body}");
            return;
        }
        Err(error) => { eprintln!("Could not reach RemoteDesk API: {error}"); return; }
    }

    loop {
        tokio::time::sleep(SIGNAL_POLL_INTERVAL).await;
        let response = match post_json(
            &client,
            &format!("{api_base}/api/pairing/host-status"),
            &HostAuthRequest { session_id: &session_id, host_secret: &host_secret },
        ).await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                let code = response.status();
                let body = response.text().await.unwrap_or_default();
                eprintln!("Pairing status request failed (HTTP {code}): {body}");
                return;
            }
            Err(error) => { eprintln!("Connection to RemoteDesk API failed: {error}"); return; }
        };
        let status: StatusResponse = match response.json().await {
            Ok(value) => value,
            Err(error) => { eprintln!("Invalid pairing status response: {error}"); return; }
        };

        match status.status.as_str() {
            "waiting" => {}
            "pending" => {
                println!("\nA device entered the pairing code.");
                let answer = tokio::task::spawn_blocking(|| -> io::Result<bool> {
                    print!("Approve this device pairing and enable remote input? [y/N]: ");
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
                            println!("Pairing approved. Connecting authenticated remote-control channel…");
                            if let Err(error) = run_control_socket(&api_base, &session_id, &host_secret).await {
                                eprintln!("Remote-control channel stopped: {error:#}");
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
                println!("Pairing is approved. Connecting remote-control channel…");
                if let Err(error) = run_control_socket(&api_base, &session_id, &host_secret).await {
                    eprintln!("Remote-control channel stopped: {error:#}");
                }
                return;
            }
            "rejected" => { println!("Pairing request was rejected."); return; }
            "expired" => { println!("Pairing code expired. Restart RemoteDesk Host to generate a new one."); return; }
            other => { eprintln!("Unknown pairing state: {other}"); return; }
        }
    }
}

fn control_socket_url(api_base: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(api_base).context("parse Worker URL")?;
    url.set_scheme("wss").map_err(|_| anyhow!("could not switch Worker URL to WSS"))?;
    url.set_path("/api/control/socket");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum ControlCommand {
    Move { dx: i32, dy: i32 },
    Click { button: String },
    ButtonDown { button: String },
    ButtonUp { button: String },
    Wheel { #[serde(rename = "deltaY")] delta_y: i32 },
    Key { key: String, phase: String },
    Text { text: String },
    ReleaseAll,
}

fn validate_command(command: ControlCommand) -> Result<ControlCommand> {
    match &command {
        ControlCommand::Move { dx, dy } if *dx < -180 || *dx > 180 || *dy < -180 || *dy > 180 => return Err(anyhow!("mouse movement exceeds per-message limit")),
        ControlCommand::Click { button } | ControlCommand::ButtonDown { button } | ControlCommand::ButtonUp { button }
            if !matches!(button.as_str(), "left" | "right" | "middle") => return Err(anyhow!("invalid mouse button")),
        ControlCommand::Wheel { delta_y } if *delta_y < -120 || *delta_y > 120 => return Err(anyhow!("scroll movement exceeds per-message limit")),
        ControlCommand::Key { key, phase } if key.len() > 16 || !matches!(phase.as_str(), "down" | "up" | "click") => return Err(anyhow!("invalid key command")),
        ControlCommand::Text { text } if text.chars().count() > 500 || text.contains('\0') => return Err(anyhow!("text length exceeds limit")),
        _ => {}
    }
    Ok(command)
}

async fn run_control_socket(api_base: &str, session_id: &str, host_secret: &str) -> Result<()> {
    let url = control_socket_url(api_base)?;
    println!("Opening outbound secure control connection to Cloudflare Worker…");
    let (mut socket, response) = connect_async(url.as_str()).await.context("connect WebSocket to Worker")?;
    println!("Control WebSocket handshake: HTTP {}", response.status());
    let auth = json!({
        "type": "auth",
        "role": "host",
        "sessionId": session_id,
        "hostSecret": host_secret
    });
    socket.send(Message::Text(auth.to_string().into())).await.context("send Host WebSocket authentication")?;

    let auth_deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let next = tokio::time::timeout_at(auth_deadline, socket.next()).await
            .context("timed out authenticating control WebSocket")?;
        match next {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(text.as_str()).context("parse control authentication response")?;
                match value.get("type").and_then(Value::as_str).unwrap_or("") {
                    "auth_ok" => break,
                    "error" => return Err(anyhow!("Worker rejected control authentication: {}", value.get("message").and_then(Value::as_str).unwrap_or("unknown error"))),
                    _ => {}
                }
            }
            Some(Ok(Message::Ping(payload))) => { socket.send(Message::Pong(payload)).await?; }
            Some(Ok(Message::Close(frame))) => return Err(anyhow!("Worker closed control socket during authentication: {frame:?}")),
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(anyhow!("control WebSocket authentication failed: {error}")),
            None => return Err(anyhow!("control WebSocket closed during authentication")),
        }
    }
    println!("Remote-control channel authenticated. Waiting for iPhone commands. Press Ctrl+C to stop Host.");

    let (input_tx, input_rx) = mpsc::channel::<(String, ControlCommand)>();
    let (input_event_tx, mut input_event_rx) = tokio::sync::mpsc::unbounded_channel::<InputWorkerEvent>();
    let input_thread = tokio::task::spawn_blocking(move || input_worker_loop(input_rx, input_event_tx));
    let (mut sink, mut stream) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.tick().await;
    let mut input_status: Option<(bool, String)> = None;
    let mut input_events_open = true;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                sink.send(Message::Text(json!({"type":"ping"}).to_string().into())).await
                    .context("send control heartbeat")?;
            }
            input_event = input_event_rx.recv(), if input_events_open => {
                if let Some(input_event) = input_event {
                    match input_event {
                        InputWorkerEvent::Ready { ok, message } => {
                            input_status = Some((ok, message.clone()));
                            println!("Windows input API ready={ok}: {message}");
                            sink.send(Message::Text(json!({"type":"inputStatus","ok":ok,"message":message}).to_string().into())).await
                                .context("send input status")?;
                        }
                        InputWorkerEvent::CommandResult { id, ok, message } => {
                            if !ok { eprintln!("Windows input command failed: {message}"); }
                            sink.send(Message::Text(json!({"type":"ack","id":id,"ok":ok,"message":message}).to_string().into())).await
                                .context("send control acknowledgement")?;
                        }
                    }
                } else {
                    // Do not leave a closed channel enabled in select!: that would busy-loop.
                    input_events_open = false;
                }
            }
            incoming = stream.next() => {
                let Some(incoming) = incoming else { break; };
                match incoming.context("read control WebSocket")? {
                    Message::Text(text) => {
                        let value: Value = match serde_json::from_str(text.as_str()) {
                            Ok(value) => value,
                            Err(_) => continue,
                        };
                        let message_type = value.get("type").and_then(Value::as_str).unwrap_or("");
                        if message_type == "pong" { continue; }
                        if message_type == "clientConnected" {
                            if let Some((ok, message)) = input_status.as_ref() {
                                sink.send(Message::Text(json!({"type":"inputStatus","ok":ok,"message":message}).to_string().into())).await
                                    .context("resend input status to newly connected client")?;
                            }
                            continue;
                        }
                        if message_type == "clientDisconnected" {
                            let _ = input_tx.send((String::new(), ControlCommand::ReleaseAll));
                            println!("iPhone controller disconnected; released held mouse/keyboard inputs.");
                            continue;
                        }
                        if message_type != "control" { continue; }
                        let id = value.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        let command_value = value.get("command").cloned().unwrap_or(Value::Null);
                        let parsed = serde_json::from_value::<ControlCommand>(command_value)
                            .map_err(|error| anyhow!("invalid control command: {error}"))
                            .and_then(validate_command);
                        match parsed {
                            Ok(command) => {
                                if input_tx.send((id.clone(), command)).is_err() {
                                    sink.send(Message::Text(json!({"type":"ack","id":id,"ok":false,"message":"Windows input worker unavailable. Check Host console."}).to_string().into())).await
                                        .context("send control acknowledgement")?;
                                }
                            }
                            Err(error) => {
                                sink.send(Message::Text(json!({"type":"ack","id":id,"ok":false,"message":error.to_string()}).to_string().into())).await
                                    .context("send rejected command acknowledgement")?;
                            }
                        }
                    }
                    Message::Ping(payload) => { sink.send(Message::Pong(payload)).await?; }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }

    let _ = input_tx.send((String::new(), ControlCommand::ReleaseAll));
    drop(input_tx);
    let _ = input_thread.await;
    println!("Control WebSocket closed; released held mouse/keyboard inputs.");
    Ok(())
}

enum InputWorkerEvent {
    Ready { ok: bool, message: String },
    CommandResult { id: String, ok: bool, message: String },
}

#[cfg(windows)]
fn input_worker_loop(
    receiver: Receiver<(String, ControlCommand)>,
    events: tokio::sync::mpsc::UnboundedSender<InputWorkerEvent>,
) {
    use enigo::{Direction, Enigo, Keyboard, Mouse, Settings};
    use std::collections::HashSet;

    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(value) => value,
        Err(error) => {
            let message = format!("Could not initialize Windows input injection: {error}");
            eprintln!("{message}");
            let _ = events.send(InputWorkerEvent::Ready { ok: false, message });
            return;
        }
    };
    let _ = events.send(InputWorkerEvent::Ready { ok: true, message: "Enigo initialized on Windows".to_string() });
    let mut held_keys: HashSet<String> = HashSet::new();
    let mut held_buttons: HashSet<String> = HashSet::new();
    while let Ok((id, command)) = receiver.recv() {
        let result = apply_input_command(&mut enigo, command, &mut held_keys, &mut held_buttons);
        match result {
            Ok(()) => { let _ = events.send(InputWorkerEvent::CommandResult { id, ok: true, message: "executed".to_string() }); }
            Err(error) => {
                let message = error.to_string();
                eprintln!("Input command failed: {message}");
                let _ = events.send(InputWorkerEvent::CommandResult { id, ok: false, message });
            }
        }
    }
    for button in held_buttons.drain() {
        if let Some(button) = parse_button(&button) { let _ = enigo.button(button, Direction::Release); }
    }
    for key in held_keys.drain() {
        if let Some(keycode) = parse_key(&key) { let _ = enigo.key(keycode, Direction::Release); }
    }
}

#[cfg(not(windows))]
fn input_worker_loop(
    _receiver: Receiver<(String, ControlCommand)>,
    events: tokio::sync::mpsc::UnboundedSender<InputWorkerEvent>,
) {
    let _ = events.send(InputWorkerEvent::Ready {
        ok: false,
        message: "Remote input injection is supported only on Windows in this build.".to_string(),
    });
}

#[cfg(windows)]
fn parse_button(value: &str) -> Option<enigo::Button> {
    match value.to_ascii_lowercase().as_str() {
        "left" => Some(enigo::Button::Left),
        "right" => Some(enigo::Button::Right),
        "middle" => Some(enigo::Button::Middle),
        _ => None,
    }
}

#[cfg(windows)]
fn parse_key(value: &str) -> Option<enigo::Key> {
    use enigo::Key;
    let normalized = value.to_ascii_lowercase();
    let key = match normalized.as_str() {
        "control" | "ctrl" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "meta" | "win" | "windows" => Key::Meta,
        "escape" | "esc" => Key::Escape,
        "enter" | "return" => Key::Return,
        "backspace" => Key::Backspace,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "delete" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "arrowup" | "up" => Key::UpArrow,
        "arrowdown" | "down" => Key::DownArrow,
        "arrowleft" | "left" => Key::LeftArrow,
        "arrowright" | "right" => Key::RightArrow,
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4,
        "f5" => Key::F5, "f6" => Key::F6, "f7" => Key::F7, "f8" => Key::F8,
        "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        _ => {
            if value.len() == 1 {
                let ch = value.chars().next()?;
                if ch.is_ascii_alphanumeric() {
                    return Some(Key::Other(ch.to_ascii_uppercase() as u32));
                }
            }
            return None;
        }
    };
    Some(key)
}

#[cfg(windows)]
fn apply_input_command(
    enigo: &mut enigo::Enigo,
    command: ControlCommand,
    held_keys: &mut std::collections::HashSet<String>,
    held_buttons: &mut std::collections::HashSet<String>,
) -> Result<()> {
    use enigo::{Axis, Coordinate, Direction, Keyboard, Mouse};
    match command {
        ControlCommand::Move { dx, dy } => {
            enigo.move_mouse(dx.clamp(-180, 180), dy.clamp(-180, 180), Coordinate::Rel)
                .map_err(|error| anyhow!(error.to_string()))?;
        }
        ControlCommand::Click { button } => {
            let button = parse_button(&button).ok_or_else(|| anyhow!("invalid mouse button"))?;
            enigo.button(button, Direction::Click).map_err(|error| anyhow!(error.to_string()))?;
        }
        ControlCommand::ButtonDown { button } => {
            let normalized = button.to_ascii_lowercase();
            let btn = parse_button(&normalized).ok_or_else(|| anyhow!("invalid mouse button"))?;
            if held_buttons.insert(normalized) {
                enigo.button(btn, Direction::Press).map_err(|error| anyhow!(error.to_string()))?;
            }
        }
        ControlCommand::ButtonUp { button } => {
            let normalized = button.to_ascii_lowercase();
            let btn = parse_button(&normalized).ok_or_else(|| anyhow!("invalid mouse button"))?;
            if held_buttons.remove(&normalized) {
                enigo.button(btn, Direction::Release).map_err(|error| anyhow!(error.to_string()))?;
            }
        }
        ControlCommand::Wheel { delta_y } => {
            let steps = (delta_y / 30).clamp(-4, 4);
            if steps != 0 { enigo.scroll(steps, Axis::Vertical).map_err(|error| anyhow!(error.to_string()))?; }
        }
        ControlCommand::Key { key, phase } => {
            let keycode = parse_key(&key).ok_or_else(|| anyhow!("unsupported key"))?;
            let canonical = key.to_ascii_lowercase();
            match phase.as_str() {
                "down" => {
                    if held_keys.insert(canonical) { enigo.key(keycode, Direction::Press).map_err(|error| anyhow!(error.to_string()))?; }
                }
                "up" => {
                    if held_keys.remove(&canonical) { enigo.key(keycode, Direction::Release).map_err(|error| anyhow!(error.to_string()))?; }
                }
                "click" => enigo.key(keycode, Direction::Click).map_err(|error| anyhow!(error.to_string()))?,
                _ => return Err(anyhow!("invalid key phase")),
            }
        }
        ControlCommand::Text { text } => {
            if text.chars().count() > 500 || text.contains('\0') { return Err(anyhow!("text length exceeds limit")); }
            enigo.text(&text).map_err(|error| anyhow!(error.to_string()))?;
        }
        ControlCommand::ReleaseAll => {
            for button in held_buttons.drain() {
                if let Some(button) = parse_button(&button) { let _ = enigo.button(button, Direction::Release); }
            }
            for key in held_keys.drain() {
                if let Some(keycode) = parse_key(&key) { let _ = enigo.key(keycode, Direction::Release); }
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
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
    println!("Control transport: outbound WSS via Cloudflare Worker; no inbound Windows port is opened.");
    println!("Mouse/keyboard are enabled only after you approve the temporary pairing prompt.");
    tokio::spawn(pairing_loop());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
        })
        .await?;
    Ok(())
}
