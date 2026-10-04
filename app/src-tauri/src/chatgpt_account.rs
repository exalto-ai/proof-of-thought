//! Sign in with ChatGPT, so built-in chat can run on the user's ChatGPT plan.
//!
//! This follows OpenAI's flow for open-source, locally hosted apps
//! (developers.openai.com/siwc/token-sharing-open-source): a browser sign-in
//! that returns to a one-shot loopback callback, PKCE, dynamic client
//! registration, and a stable per-install host identifier. The resulting
//! tokens authorise Responses API requests against the user's plan; they grant
//! no access to ChatGPT conversations. They live only in the login Keychain
//! and are never logged.

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize as _, Zeroizing};

use crate::secret_store;

const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const ISSUER: &str = "https://auth.openai.com";
pub const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// Registers a new client for this user on first sign-in.
const NEW_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "Proof of Thought";
const CALLBACK_PATH: &str = "/auth/callback";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before the access token would expire.
const REFRESH_MARGIN_SECS: u64 = 120;
const MAX_CALLBACK_BYTES: usize = 16 * 1024;
const MAX_TOKEN_RESPONSE_BYTES: u64 = 64 * 1024;

static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    sub: String,
    email: Option<String>,
    access_token: String,
    refresh_token: String,
    /// Unix seconds.
    expires_at: u64,
}

impl Drop for Credentials {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignIn {
    SignedIn,
    Cancelled,
}

// ---------------------------------------------------------------- storage

/// Names in the app's single Keychain item (see `secret_store`).
const CREDENTIALS: &str = "chatgpt:credentials";
const HOST_ID: &str = "chatgpt:host-id";

fn load() -> Result<Option<Credentials>, String> {
    let Some(bytes) = secret_store::get(CREDENTIALS)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "The saved ChatGPT sign-in is invalid. Sign in again in Settings.".into())
}

fn save(credentials: &Credentials) -> Result<(), String> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(credentials)
            .map_err(|_| "Could not save the ChatGPT sign-in.".to_string())?,
    );
    secret_store::set(CREDENTIALS, &bytes)
}

// ---------------------------------------------------------------- identifiers

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buffer = [0u8; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut buffer))
        .map_err(|_| "Could not generate a secure random value.".to_string())?;
    Ok(buffer)
}

fn random_token() -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

/// A UUIDv4 `urn:uuid:` host identifier, one of the formats OpenAI accepts.
pub fn format_host_id(bytes: [u8; 16]) -> String {
    let mut bytes = bytes;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The stable, opaque identifier for this install. Chosen once, before the
/// first sign-in, and kept across sign-outs as OpenAI requires.
fn host_id() -> Result<String, String> {
    if let Some(bytes) = secret_store::get(HOST_ID)?
        && let Ok(value) = std::str::from_utf8(&bytes)
        && value.starts_with("urn:uuid:")
    {
        return Ok(value.to_string());
    }
    let value = format_host_id(random_bytes::<16>()?);
    secret_store::set(HOST_ID, value.as_bytes())?;
    Ok(value)
}

/// The PKCE S256 challenge for `verifier`.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// The parameters of a callback request line such as `GET /auth/callback?code=…`.
pub fn callback_query(request_line: &str) -> Option<Vec<(String, String)>> {
    let target = request_line.strip_prefix("GET ")?.split(' ').next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return None;
    }
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(key)?, percent_decode(value)?))
        })
        .collect()
}

pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
    host_id: &str,
) -> String {
    let mut parameters = vec![
        ("client_id", client_id),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPE),
        ("resource", RESOURCE),
        ("state", state),
        ("nonce", nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge),
        ("ext_agent_host_id", host_id),
    ];
    if client_id == NEW_CLIENT {
        parameters.push(("agent_name_hint", AGENT_NAME));
    }
    let query = parameters
        .into_iter()
        .map(|(key, value)| format!("{key}={}", percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{AUTHORIZE_URL}?{query}")
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

/// The identity claims of an ID token received directly from the token
/// endpoint over TLS. OpenID Connect allows TLS to stand in for the signature
/// check in that case (Core §3.1.3.7); issuer, audience, nonce, and expiry
/// are still checked.
pub fn id_token_identity(
    id_token: &str,
    client_id: &str,
    nonce: &str,
    now: u64,
) -> Result<(String, Option<String>), String> {
    let invalid = || "ChatGPT returned an invalid sign-in. Try again.".to_string();
    let payload = id_token.split('.').nth(1).ok_or_else(invalid)?;
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let audience_ok = match claims.get("aud") {
        Some(Value::String(audience)) => audience == client_id,
        Some(Value::Array(audiences)) => audiences.iter().any(|a| a.as_str() == Some(client_id)),
        _ => false,
    };
    let fresh = claims
        .get("exp")
        .and_then(Value::as_u64)
        .is_some_and(|exp| exp > now);
    if claims.get("iss").and_then(Value::as_str) != Some(ISSUER)
        || !audience_ok
        || claims.get("nonce").and_then(Value::as_str) != Some(nonce)
        || !fresh
    {
        return Err(invalid());
    }
    let sub = claims
        .get("sub")
        .and_then(Value::as_str)
        .filter(|sub| !sub.is_empty())
        .ok_or_else(invalid)?;
    let email = claims
        .get("email")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    Ok((sub.to_string(), email))
}

// ---------------------------------------------------------------- network

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(true)
        .timeout_global(Some(Duration::from_secs(30)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

fn token_request(form: &[(&str, &str)]) -> Result<Value, String> {
    let mut response = agent()
        .post(TOKEN_URL)
        .header("accept", "application/json")
        .send_form(form.iter().copied())
        .map_err(|_| "Could not reach ChatGPT. Check your connection.".to_string())?;
    let status = response.status().as_u16();
    let mut body = response
        .body_mut()
        .with_config()
        .limit(MAX_TOKEN_RESPONSE_BYTES)
        .read_to_vec()
        .map_err(|_| "ChatGPT returned an unreadable response.".to_string())?;
    let parsed = serde_json::from_slice::<Value>(&body);
    body.zeroize();
    match (status, parsed) {
        (200, Ok(value)) => Ok(value),
        (400 | 401, _) => Err("ChatGPT sign-in expired. Sign in again in Settings.".into()),
        _ => Err("ChatGPT could not complete sign-in. Try again.".into()),
    }
}

fn token_field(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "ChatGPT returned an incomplete sign-in. Try again.".to_string())
}

fn expires_at(value: &Value) -> u64 {
    now()
        + value
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600)
}

/// Answer the browser and report what the callback carried.
fn read_callback(mut stream: TcpStream) -> Option<Vec<(String, String)>> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buffer = vec![0u8; MAX_CALLBACK_BYTES];
    let mut read = 0;
    while read < buffer.len() {
        let count = stream.read(&mut buffer[read..]).ok()?;
        if count == 0 {
            break;
        }
        read += count;
        if buffer[..read]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = std::str::from_utf8(&buffer[..read]).ok()?;
    let query = callback_query(request.lines().next()?);
    let page = if query.is_some() {
        "<!doctype html><title>Proof of Thought</title><body style=\"font:15px -apple-system,sans-serif;text-align:center;margin-top:20vh\">You can close this tab and return to Proof of Thought.</body>"
    } else {
        "<!doctype html><title>Not found</title>"
    };
    let status = if query.is_some() {
        "200 OK"
    } else {
        "404 Not Found"
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
        page.len()
    );
    buffer.zeroize();
    query
}

/// Stop a sign-in that is waiting for the browser.
pub fn cancel_sign_in() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Run the browser sign-in and save the result. Blocks until the browser
/// returns, the user cancels, or five minutes pass.
pub fn sign_in(open_browser: impl FnOnce(&str) -> Result<(), String>) -> Result<SignIn, String> {
    CANCEL.store(false, Ordering::SeqCst);
    let host_id = host_id()?;
    // Loopback only, on a port the system picks for this one attempt.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Could not start the ChatGPT sign-in.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not start the ChatGPT sign-in.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not start the ChatGPT sign-in.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = Zeroizing::new(random_token()?);
    let state = random_token()?;
    let nonce = random_token()?;
    let url = authorize_url(
        NEW_CLIENT,
        &redirect_uri,
        &state,
        &nonce,
        &pkce_challenge(&verifier),
        &host_id,
    );
    open_browser(&url)?;

    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    let parameters = loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Ok(SignIn::Cancelled);
        }
        if Instant::now() > deadline {
            return Err("ChatGPT sign-in timed out. Try again.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                if let Some(parameters) = read_callback(stream) {
                    break parameters;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => return Err("The ChatGPT sign-in was interrupted. Try again.".into()),
        }
    };
    let get = |key: &str| {
        parameters
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    if get("state") != Some(state.as_str()) {
        return Err("The ChatGPT sign-in could not be verified. Try again.".into());
    }
    if get("error").is_some() {
        return Ok(SignIn::Cancelled);
    }
    let code = get("code").ok_or("ChatGPT did not complete sign-in. Try again.")?;
    let client_id = get("client_id")
        .filter(|id| !id.is_empty() && *id != NEW_CLIENT)
        .ok_or("ChatGPT did not register Proof of Thought. Try again.")?
        .to_string();
    let tokens = token_request(&[
        ("grant_type", "authorization_code"),
        ("client_id", &client_id),
        ("code", code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect_uri),
        ("resource", RESOURCE),
    ])?;
    let (sub, email) = id_token_identity(
        &token_field(&tokens, "id_token")?,
        &client_id,
        &nonce,
        now(),
    )?;
    save(&Credentials {
        client_id,
        sub,
        email,
        access_token: token_field(&tokens, "access_token")?,
        refresh_token: token_field(&tokens, "refresh_token")?,
        expires_at: expires_at(&tokens),
    })?;
    Ok(SignIn::SignedIn)
}

/// The signed-in account's email, or `None` when signed out.
pub fn account() -> Result<Option<String>, String> {
    Ok(load()?.map(|credentials| credentials.email.clone().unwrap_or_default()))
}

/// Forget the sign-in. The host identifier stays, as OpenAI requires.
pub fn sign_out() -> Result<(), String> {
    secret_store::delete(CREDENTIALS)
}

/// A current access token for Responses API requests, refreshed when close
/// to expiry.
pub fn access_token() -> Result<Zeroizing<Vec<u8>>, String> {
    let mut credentials =
        load()?.ok_or("Sign in with ChatGPT in Settings to use your ChatGPT plan.")?;
    if credentials.expires_at > now() + REFRESH_MARGIN_SECS {
        return Ok(Zeroizing::new(credentials.access_token.as_bytes().to_vec()));
    }
    let tokens = token_request(&[
        ("grant_type", "refresh_token"),
        ("client_id", &credentials.client_id.clone()),
        ("refresh_token", &credentials.refresh_token.clone()),
        ("resource", RESOURCE),
    ])?;
    credentials.access_token = token_field(&tokens, "access_token")?;
    // Each refresh returns a replacement refresh token.
    if let Ok(refresh_token) = token_field(&tokens, "refresh_token") {
        credentials.refresh_token = refresh_token;
    }
    credentials.expires_at = expires_at(&tokens);
    save(&credentials)?;
    Ok(Zeroizing::new(credentials.access_token.as_bytes().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_ids_are_version_four_uuids() {
        let id = format_host_id([0xff; 16]);
        assert_eq!(id, "urn:uuid:ffffffff-ffff-4fff-bfff-ffffffffffff");
    }

    #[test]
    fn pkce_challenge_matches_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_carries_every_required_parameter() {
        let url = authorize_url(
            NEW_CLIENT,
            "http://127.0.0.1:1455/auth/callback",
            "s",
            "n",
            "c",
            "urn:uuid:x",
        );
        assert!(url.starts_with(AUTHORIZE_URL));
        for part in [
            "client_id=dynamic_agent_client",
            "response_type=code",
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback",
            "scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct",
            "resource=https%3A%2F%2Fapi.openai.com%2Fv1",
            "code_challenge_method=S256",
            "ext_agent_host_id=urn%3Auuid%3Ax",
            "agent_name_hint=Proof%20of%20Thought",
        ] {
            assert!(url.contains(part), "{part} missing from {url}");
        }
    }

    #[test]
    fn callback_query_reads_only_the_callback_path() {
        assert_eq!(
            callback_query("GET /auth/callback?code=a%2Bb&state=x&client_id=c HTTP/1.1"),
            Some(vec![
                ("code".into(), "a+b".into()),
                ("state".into(), "x".into()),
                ("client_id".into(), "c".into()),
            ])
        );
        assert_eq!(callback_query("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(callback_query("POST /auth/callback HTTP/1.1"), None);
    }

    fn id_token(claims: Value) -> String {
        format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    #[test]
    fn id_tokens_must_match_issuer_audience_nonce_and_expiry() {
        let good = json_claims("client", "nonce", 2_000);
        assert_eq!(
            id_token_identity(&id_token(good), "client", "nonce", 1_000).unwrap(),
            ("user".to_string(), Some("a@example.com".to_string()))
        );
        for (claims, client, nonce, now) in [
            (
                json_claims("other", "nonce", 2_000),
                "client",
                "nonce",
                1_000,
            ),
            (
                json_claims("client", "replayed", 2_000),
                "client",
                "nonce",
                1_000,
            ),
            (
                json_claims("client", "nonce", 500),
                "client",
                "nonce",
                1_000,
            ),
        ] {
            assert!(id_token_identity(&id_token(claims), client, nonce, now).is_err());
        }
    }

    fn json_claims(audience: &str, nonce: &str, exp: u64) -> Value {
        serde_json::json!({
            "iss": ISSUER, "aud": audience, "nonce": nonce, "exp": exp,
            "sub": "user", "email": "a@example.com",
        })
    }
}
