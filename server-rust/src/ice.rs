use std::env;

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha1::Sha1;

#[derive(Default)]
pub(crate) struct IceConfig {
    turn_urls: Vec<String>,
    turn_secret: String,
}

impl IceConfig {
    pub(crate) fn from_env() -> Self {
        let urls = env::var("WEBRTC_TURN_URLS").unwrap_or_default();
        let secret = env::var("WEBRTC_TURN_SECRET").unwrap_or_default();
        Self::new(&urls, secret)
    }

    fn new(urls: &str, turn_secret: String) -> Self {
        let turn_urls: Vec<_> = urls
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if turn_secret.is_empty()
            || turn_urls.len() > 8
            || turn_urls.iter().any(|url| !valid_turn_url(url))
        {
            return Self::default();
        }
        Self {
            turn_urls,
            turn_secret,
        }
    }

    pub(crate) fn turn_configured(&self) -> bool {
        !self.turn_urls.is_empty()
    }

    pub(crate) fn for_socket(&self, socket_id: &str) -> Value {
        self.value_at(socket_id, Utc::now().timestamp_millis())
    }

    fn value_at(&self, socket_id: &str, now: i64) -> Value {
        let mut servers = vec![json!({ "urls": "stun:stun.l.google.com:19302" })];
        if !self.turn_configured() {
            return json!({ "iceServers": servers, "expiresAt": now + 300_000 });
        }
        let expires_at_seconds = now.div_euclid(1000) + 3600;
        let socket_id: String = socket_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            .take(128)
            .collect();
        let username = format!("{expires_at_seconds}:{socket_id}");
        let mut signer = Hmac::<Sha1>::new_from_slice(self.turn_secret.as_bytes())
            .expect("HMAC accepts any key length");
        signer.update(username.as_bytes());
        let credential = STANDARD.encode(signer.finalize().into_bytes());
        servers.push(
            json!({ "urls": self.turn_urls, "username": username, "credential": credential }),
        );
        json!({ "iceServers": servers, "expiresAt": expires_at_seconds * 1000 })
    }
}

fn valid_turn_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let Some((scheme, target)) = lower.split_once(':') else {
        return false;
    };
    if !matches!(scheme, "turn" | "turns") {
        return false;
    }
    let host = match target.split_once('?') {
        Some((host, "transport=udp" | "transport=tcp")) => host,
        Some(_) => return false,
        None => target,
    };
    !host.is_empty()
        && host
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".[]:-".contains(&c))
}

#[cfg(test)]
mod tests {
    use super::IceConfig;

    #[test]
    fn issues_temporary_coturn_credentials() {
        let config = IceConfig::new("turn:turn.example.com:3478?transport=udp", "secret".into());
        let actual = config.value_at("x:/A-_1", 1000);
        assert_eq!(actual["expiresAt"], 3_601_000);
        assert_eq!(actual["iceServers"][1]["username"], "3601:xA-_1");
        assert_eq!(
            actual["iceServers"][1]["credential"]
                .as_str()
                .unwrap()
                .len(),
            28
        );
        assert!(!IceConfig::new("https://example.com", "secret".into()).turn_configured());
    }
}
