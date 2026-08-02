//! Local HTTP transport for MCP JSON-RPC (Streamable HTTP-style single endpoint).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::host::McpHost;
use super::protocol::JsonRpcRequest;
use super::{handle_rpc, McpServerConfig, MAX_MCP_BODY_BYTES};

/// Spawn a background HTTP listener. Returns the accept-loop join handle once bound.
pub fn spawn_http(
    host: McpHost,
    config: McpServerConfig,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    validate_bind_config(&config)?;
    let addr = super::socket_addr(&config.host, config.port);
    let listener = TcpListener::bind(&addr)
        .map_err(|error| format!("failed to bind MCP HTTP listener on {addr}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;

    let auth_token = config.auth_token.clone();
    thread::Builder::new()
        .name("codex-corp-mcp-http".into())
        .spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let host = host.clone();
                        let stop = stop.clone();
                        let auth_token = auth_token.clone();
                        let _ = thread::Builder::new()
                            .name("codex-corp-mcp-conn".into())
                            .spawn(move || {
                                if stop.load(Ordering::SeqCst) {
                                    return;
                                }
                                if let Err(error) = handle_connection(stream, &host, &auth_token) {
                                    eprintln!("[codex-corp-mcp] connection error: {error}");
                                }
                            });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(error) => {
                        if !stop.load(Ordering::SeqCst) {
                            eprintln!("[codex-corp-mcp] accept error: {error}");
                            thread::sleep(Duration::from_millis(200));
                        }
                    }
                }
            }
        })
        .map_err(|error| error.to_string())
}

fn validate_bind_config(config: &McpServerConfig) -> Result<(), String> {
    let allow_non_loopback = std::env::var("CODEX_CORP_MCP_ALLOW_NON_LOOPBACK")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    validate_bind_config_with_opt_in(config, allow_non_loopback)
}

fn validate_bind_config_with_opt_in(
    config: &McpServerConfig,
    allow_non_loopback: bool,
) -> Result<(), String> {
    validate_bind_host_with_opt_in(&config.host, allow_non_loopback)?;
    if !is_loopback_host(&config.host) && config.auth_token.len() < 32 {
        return Err(
            "refusing non-loopback MCP bind with a bearer token shorter than 32 bytes".into(),
        );
    }
    Ok(())
}

fn validate_bind_host_with_opt_in(host: &str, allow_non_loopback: bool) -> Result<(), String> {
    let normalized = host.trim().to_ascii_lowercase();
    if !is_loopback_host(&normalized) && !allow_non_loopback {
        return Err(format!(
            "refusing to bind MCP on non-loopback host '{host}' (set CODEX_CORP_MCP_ALLOW_NON_LOOPBACK=1 to override)"
        ));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

/// One framed message extracted from a stdio MCP stream.
#[derive(Debug, PartialEq, Eq)]
enum StdioMessage {
    /// Raw JSON body (Content-Length or line-delimited).
    Json(String, StdioFraming),
    Eof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdioFraming {
    ContentLength,
    LineDelimited,
}

/// Read the next MCP stdio message from a buffered byte stream.
///
/// Supports:
/// - Content-Length headers followed by exactly N raw body bytes (no trailing newline required)
/// - Line-delimited JSON (a single non-empty line of JSON text)
fn read_stdio_message<R: Read>(reader: &mut std::io::BufReader<R>) -> Result<StdioMessage, String> {
    use std::io::BufRead;

    // Skip leading blank lines, then classify the first non-empty line.
    let first = loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        if n == 0 {
            return Ok(StdioMessage::Eof);
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            break trimmed.to_string();
        }
    };

    if first.to_ascii_lowercase().starts_with("content-length:") {
        let len: usize = first
            .split(':')
            .nth(1)
            .and_then(|v| v.trim().parse().ok())
            .ok_or_else(|| format!("invalid Content-Length header: {first}"))?;
        if len > MAX_MCP_BODY_BYTES {
            return Err(format!(
                "stdio Content-Length {len} exceeds max {MAX_MCP_BODY_BYTES}"
            ));
        }
        // Drain remaining headers until blank line.
        loop {
            let mut header_line = String::new();
            let read = reader
                .read_line(&mut header_line)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                return Err("stdio Content-Length headers truncated".into());
            }
            if header_line.trim().is_empty() {
                break;
            }
        }
        // Exact N body bytes — must NOT use read_line (bodies often have no trailing newline).
        let mut body = vec![0_u8; len];
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("stdio Content-Length body incomplete: {error}"))?;
        let text = String::from_utf8(body).map_err(|error| error.to_string())?;
        return Ok(StdioMessage::Json(text, StdioFraming::ContentLength));
    }

    // Line-delimited JSON (one object/array per line).
    if first.len() > MAX_MCP_BODY_BYTES {
        return Err(format!(
            "stdio line exceeds max body size {MAX_MCP_BODY_BYTES}"
        ));
    }
    Ok(StdioMessage::Json(first, StdioFraming::LineDelimited))
}

/// Stdio JSON-RPC loop (line-delimited or Content-Length framing).
///
/// Reads stdin on a background thread so the stop flag is observed via
/// `recv_timeout` even when no client input arrives (SIGINT/SIGTERM/stop file).
pub fn serve_stdio(host: McpHost, stop: Arc<AtomicBool>) -> Result<(), String> {
    use std::io::BufReader;
    use std::sync::mpsc;

    enum StdinEvent {
        Message(String, StdioFraming),
        Eof,
        Error(String),
    }

    let (tx, rx) = mpsc::channel::<StdinEvent>();
    thread::Builder::new()
        .name("codex-corp-mcp-stdio-stdin".into())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                match read_stdio_message(&mut reader) {
                    Ok(StdioMessage::Eof) => {
                        let _ = tx.send(StdinEvent::Eof);
                        break;
                    }
                    Ok(StdioMessage::Json(body, framing)) => {
                        if tx.send(StdinEvent::Message(body, framing)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(StdinEvent::Error(error));
                        break;
                    }
                }
            }
        })
        .map_err(|error| error.to_string())?;

    let mut stdout = std::io::stdout();

    while !stop.load(Ordering::SeqCst) {
        let event = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        match event {
            StdinEvent::Eof => break,
            StdinEvent::Error(error) => return Err(error),
            StdinEvent::Message(body, framing) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(response_text) = process_json_body(&host, &body) {
                    let framed = frame_stdio_response(&response_text, framing);
                    stdout
                        .write_all(framed.as_bytes())
                        .map_err(|error| error.to_string())?;
                    stdout.flush().map_err(|error| error.to_string())?;
                }
            }
        }
    }
    Ok(())
}

fn frame_stdio_response(response: &str, framing: StdioFraming) -> String {
    match framing {
        StdioFraming::ContentLength => {
            format!("Content-Length: {}\r\n\r\n{}", response.len(), response)
        }
        StdioFraming::LineDelimited => format!("{response}\n"),
    }
}

fn process_json_body(host: &McpHost, body: &str) -> Option<String> {
    let request: JsonRpcRequest = serde_json::from_str(body).ok()?;
    let response = handle_rpc(host, request)?;
    serde_json::to_string(&response).ok()
}

fn handle_connection(
    mut stream: TcpStream,
    host: &McpHost,
    auth_token: &str,
) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(30))).ok();

    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if buffer.len() > MAX_MCP_BODY_BYTES + 16 * 1024 {
                    write_response(&mut stream, 413, "text/plain", "Payload Too Large", &[])?;
                    return Ok(());
                }
                if let Some(split) = find_header_end(&buffer) {
                    let headers = String::from_utf8_lossy(&buffer[..split]);
                    let content_length = parse_content_length(&headers).unwrap_or(0);
                    if content_length > MAX_MCP_BODY_BYTES {
                        write_response(&mut stream, 413, "text/plain", "Payload Too Large", &[])?;
                        return Ok(());
                    }
                    if buffer.len() >= split + content_length {
                        break;
                    }
                } else if buffer.len() > 64 * 1024 {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => break,
            Err(error) => return Err(error.to_string()),
        }
    }

    let Some(header_end) = find_header_end(&buffer) else {
        write_response(&mut stream, 400, "text/plain", "Malformed headers", &[])?;
        return Ok(());
    };
    let header_block = String::from_utf8_lossy(&buffer[..header_end]);
    let request_line = header_block.lines().next().unwrap_or("");
    let (method, path) = parse_request_line(request_line);
    let method_upper = method.to_ascii_uppercase();

    // No CORS headers: this is a local MCP service, not a browser API.
    if method_upper == "OPTIONS" {
        write_response(&mut stream, 204, "text/plain", "", &[])?;
        return Ok(());
    }

    if method_upper == "GET" {
        if !is_allowed_path(path) {
            write_response(&mut stream, 404, "text/plain", "Not Found", &[])?;
            return Ok(());
        }
        let payload = serde_json::json!({
            "name": "codex-corp",
            "version": env!("CARGO_PKG_VERSION"),
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "protocolVersion": super::protocol::PROTOCOL_VERSION,
            "authRequired": !auth_token.is_empty(),
        });
        write_response(
            &mut stream,
            200,
            "application/json",
            &payload.to_string(),
            &[],
        )?;
        return Ok(());
    }

    if method_upper != "POST" {
        write_response(&mut stream, 405, "text/plain", "Method Not Allowed", &[])?;
        return Ok(());
    }

    let Some(content_length) = parse_content_length(&header_block) else {
        write_response(
            &mut stream,
            411,
            "text/plain",
            "Content-Length Required",
            &[],
        )?;
        return Ok(());
    };
    let Some(body_end) = exact_http_body_end(header_end, content_length, buffer.len()) else {
        write_response(
            &mut stream,
            400,
            "text/plain",
            "Body length mismatch or trailing bytes",
            &[],
        )?;
        return Ok(());
    };

    if !is_allowed_path(path) {
        write_response(&mut stream, 404, "text/plain", "Not Found", &[])?;
        return Ok(());
    }

    if !auth_token.is_empty() && !authorize_request(&header_block, auth_token) {
        write_response(
            &mut stream,
            401,
            "application/json",
            r#"{"error":"unauthorized","message":"Bearer token required (see mcp-server.status.json authToken)"}"#,
            &[("WWW-Authenticate", "Bearer")],
        )?;
        return Ok(());
    }

    let body = match std::str::from_utf8(&buffer[header_end..body_end]) {
        Ok(body) => body.trim(),
        Err(_) => {
            write_response(&mut stream, 400, "text/plain", "Body must be UTF-8", &[])?;
            return Ok(());
        }
    };
    if body.is_empty() {
        write_response(&mut stream, 400, "text/plain", "Empty body", &[])?;
        return Ok(());
    }
    if body.len() > MAX_MCP_BODY_BYTES {
        write_response(&mut stream, 413, "text/plain", "Payload Too Large", &[])?;
        return Ok(());
    }

    if body.starts_with('[') {
        let requests: Vec<JsonRpcRequest> =
            serde_json::from_str(body).map_err(|error| error.to_string())?;
        let mut responses = Vec::new();
        for request in requests {
            if let Some(response) = handle_rpc(host, request) {
                responses.push(response);
            }
        }
        let payload = serde_json::to_string(&responses).map_err(|error| error.to_string())?;
        write_response(&mut stream, 200, "application/json", &payload, &[])?;
        return Ok(());
    }

    let request: JsonRpcRequest = serde_json::from_str(body).map_err(|error| error.to_string())?;
    match handle_rpc(host, request) {
        Some(response) => {
            let payload = serde_json::to_string(&response).map_err(|error| error.to_string())?;
            write_response(&mut stream, 200, "application/json", &payload, &[])?;
        }
        None => {
            write_response(&mut stream, 202, "application/json", "", &[])?;
        }
    }
    Ok(())
}

fn exact_http_body_end(header_end: usize, content_length: usize, received: usize) -> Option<usize> {
    let expected = header_end.checked_add(content_length)?;
    (received == expected).then_some(expected)
}

fn parse_request_line(line: &str) -> (&str, &str) {
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/").split('?').next().unwrap_or("/");
    (method, path)
}

fn is_allowed_path(path: &str) -> bool {
    matches!(path, "/mcp" | "/")
}

/// Constant-time string compare for bearer tokens (length still leaks when unequal).
fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorize_request(headers: &str, expected: &str) -> bool {
    for line in headers.lines().skip(1) {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("authorization:") {
            let value = line
                .split_once(':')
                .map(|(_, v)| v.trim())
                .unwrap_or(rest.trim());
            let mut parts = value.split_whitespace();
            if parts
                .next()
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
            {
                if let Some(token) = parts.next() {
                    return parts.next().is_none() && constant_time_eq(token, expected);
                }
            }
        }
        if let Some(rest) = lower.strip_prefix("x-codex-corp-token:") {
            let value = line
                .split_once(':')
                .map(|(_, v)| v.trim())
                .unwrap_or(rest.trim());
            return constant_time_eq(value, expected);
        }
    }
    false
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| index + 2)
        })
}

fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            return rest.trim().parse().ok();
        }
    }
    None
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
    extra_headers: &[(&str, &str)],
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "OK",
    };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (key, value) in extra_headers {
        response.push_str(key);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    response.push_str(body);
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn parses_content_length_header() {
        let headers = "POST /mcp HTTP/1.1\r\nContent-Length: 12\r\nHost: localhost\r\n\r\n";
        assert_eq!(parse_content_length(headers), Some(12));
    }

    #[test]
    fn http_post_body_must_match_content_length_without_trailing_bytes() {
        assert_eq!(exact_http_body_end(40, 2, 42), Some(42));
        assert_eq!(exact_http_body_end(40, 2, 41), None);
        assert_eq!(exact_http_body_end(40, 2, 43), None);
        assert_eq!(exact_http_body_end(usize::MAX, 1, usize::MAX), None);
    }

    #[test]
    fn finds_header_end_crlf() {
        let raw = b"POST /mcp HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(find_header_end(raw), Some(raw.len() - 2));
    }

    #[test]
    fn stdio_content_length_body_without_trailing_newline() {
        // Body is exact N bytes with no trailing \n — the old line-framed path hung here.
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let mut reader = BufReader::new(Cursor::new(framed.into_bytes()));
        match read_stdio_message(&mut reader).unwrap() {
            StdioMessage::Json(text, StdioFraming::ContentLength) => assert_eq!(text, body),
            other => panic!("unexpected: {other:?}"),
        }
        // Stream is exhausted after one message.
        assert_eq!(read_stdio_message(&mut reader).unwrap(), StdioMessage::Eof);
    }

    #[test]
    fn stdio_line_delimited_json() {
        let line = r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#;
        let mut reader = BufReader::new(Cursor::new(format!("{line}\n").into_bytes()));
        match read_stdio_message(&mut reader).unwrap() {
            StdioMessage::Json(text, StdioFraming::LineDelimited) => assert_eq!(text, line),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn stdio_response_preserves_the_request_framing() {
        let response = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        assert_eq!(
            frame_stdio_response(response, StdioFraming::LineDelimited),
            format!("{response}\n")
        );
        assert_eq!(
            frame_stdio_response(response, StdioFraming::ContentLength),
            format!("Content-Length: {}\r\n\r\n{response}", response.len())
        );
    }

    #[test]
    fn stdio_content_length_two_messages_back_to_back() {
        let a = r#"{"id":1}"#;
        let b = r#"{"id":2}"#;
        let framed = format!(
            "Content-Length: {}\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            a.len(),
            a,
            b.len(),
            b
        );
        let mut reader = BufReader::new(Cursor::new(framed.into_bytes()));
        assert_eq!(
            read_stdio_message(&mut reader).unwrap(),
            StdioMessage::Json(a.into(), StdioFraming::ContentLength)
        );
        assert_eq!(
            read_stdio_message(&mut reader).unwrap(),
            StdioMessage::Json(b.into(), StdioFraming::ContentLength)
        );
        assert_eq!(read_stdio_message(&mut reader).unwrap(), StdioMessage::Eof);
    }

    #[test]
    fn allowlist_paths() {
        assert!(is_allowed_path("/mcp"));
        assert!(is_allowed_path("/"));
        assert!(!is_allowed_path("/admin"));
    }

    #[test]
    fn authorize_bearer() {
        let headers = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer secret-token\r\n\r\n";
        assert!(authorize_request(headers, "secret-token"));
        assert!(authorize_request(
            "POST /mcp HTTP/1.1\r\nAuthorization: BEARER secret-token\r\n\r\n",
            "secret-token"
        ));
        assert!(!authorize_request(headers, "other"));
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(constant_time_eq("", ""));
        assert!(!constant_time_eq("", "x"));
        assert!(!constant_time_eq("x", ""));
        // Empty Bearer token never matches a non-empty server secret.
        let empty_bearer = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer \r\n\r\n";
        assert!(!authorize_request(empty_bearer, "secret"));
        let empty_header = "POST /mcp HTTP/1.1\r\nAuthorization: Bearer\r\n\r\n";
        assert!(!authorize_request(empty_header, "secret"));
    }

    #[test]
    fn rejects_non_loopback_by_default() {
        assert!(validate_bind_host_with_opt_in("127.0.0.1", false).is_ok());
        assert!(validate_bind_host_with_opt_in("0.0.0.0", false).is_err());
    }

    #[test]
    fn rejects_weak_token_for_opted_in_non_loopback_bind() {
        let config = McpServerConfig {
            host: "0.0.0.0".into(),
            port: 8742,
            stdio: false,
            auth_token: "weak".into(),
        };
        assert!(validate_bind_host_with_opt_in(&config.host, true).is_ok());
        assert!(validate_bind_config_with_opt_in(&config, true).is_err());
    }
}
