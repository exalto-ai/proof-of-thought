//! The app's secrets in one login-Keychain item, read once per launch.
//!
//! Provider keys, the ChatGPT sign-in, and its host identifier used to be four
//! Keychain items, each re-read on every window focus. macOS asks again for
//! each item whenever the app's code signature changes, which every
//! development build does, so that meant a stream of access prompts. Now
//! there is one item, read on first use and kept in memory, and written only
//! when a secret changes. Items saved by earlier builds are folded into it the
//! first time it is missing.

use std::collections::BTreeMap;
use std::sync::Mutex;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use zeroize::Zeroizing;

type Entries = BTreeMap<String, Zeroizing<Vec<u8>>>;

static CACHE: Mutex<Option<Entries>> = Mutex::new(None);

#[cfg(target_os = "macos")]
mod keychain {
    use zeroize::Zeroizing;

    pub const SERVICE: &str = "ai.exalto.thought";
    pub const ACCOUNT: &str = "secrets";
    const ITEM_NOT_FOUND: i32 = -25_300;

    pub fn get(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match security_framework::passwords::get_generic_password(service, account) {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => Err("Could not access the Mac login Keychain.".into()),
        }
    }

    pub fn set(value: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, value)
            .map_err(|_| "Could not save to the Mac login Keychain.".to_string())
    }

    pub fn delete(service: &str, account: &str) {
        let _ = security_framework::passwords::delete_generic_password(service, account);
    }

    /// Where earlier builds kept each secret, by its name here.
    pub const LEGACY: [(&str, &str, &str); 4] = [
        ("ai.exalto.thought.provider", "openai", "provider:openai"),
        (
            "ai.exalto.thought.provider",
            "anthropic",
            "provider:anthropic",
        ),
        (
            "ai.exalto.thought.chatgpt",
            "credentials",
            "chatgpt:credentials",
        ),
        ("ai.exalto.thought.chatgpt", "host-id", "chatgpt:host-id"),
    ];
}

/// Serialise entries as a JSON object of base64 values.
pub fn encode(entries: &Entries) -> Zeroizing<Vec<u8>> {
    let object: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                serde_json::Value::String(STANDARD.encode(value)),
            )
        })
        .collect();
    Zeroizing::new(serde_json::to_vec(&object).unwrap_or_default())
}

pub fn decode(bytes: &[u8]) -> Result<Entries, String> {
    let object: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(bytes)
        .map_err(|_| "The saved app secrets are unreadable.".to_string())?;
    object
        .into_iter()
        .map(|(name, value)| {
            let encoded = value
                .as_str()
                .ok_or_else(|| "The saved app secrets are unreadable.".to_string())?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "The saved app secrets are unreadable.".to_string())?;
            Ok((name, Zeroizing::new(bytes)))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn load_from_keychain() -> Result<Entries, String> {
    if let Some(bytes) = keychain::get(keychain::SERVICE, keychain::ACCOUNT)? {
        return decode(&bytes);
    }
    // First launch of this build layout: fold in what earlier builds saved.
    let mut entries = Entries::new();
    for (service, account, name) in keychain::LEGACY {
        if let Some(value) = keychain::get(service, account)? {
            entries.insert(name.to_string(), value);
        }
    }
    if !entries.is_empty() {
        keychain::set(&encode(&entries))?;
        for (service, account, _) in keychain::LEGACY {
            keychain::delete(service, account);
        }
    }
    Ok(entries)
}

#[cfg(not(target_os = "macos"))]
fn load_from_keychain() -> Result<Entries, String> {
    Err("Saved secrets are available only in the macOS app.".into())
}

#[cfg(target_os = "macos")]
fn save_to_keychain(entries: &Entries) -> Result<(), String> {
    keychain::set(&encode(entries))
}

#[cfg(not(target_os = "macos"))]
fn save_to_keychain(_: &Entries) -> Result<(), String> {
    Err("Saved secrets are available only in the macOS app.".into())
}

fn with_entries<T>(apply: impl FnOnce(&mut Entries) -> Result<T, String>) -> Result<T, String> {
    let mut cache = CACHE
        .lock()
        .map_err(|_| "App secrets are unavailable.".to_string())?;
    if cache.is_none() {
        *cache = Some(load_from_keychain()?);
    }
    apply(cache.as_mut().expect("loaded above"))
}

/// The secret stored under `name`, if any.
pub fn get(name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    with_entries(|entries| Ok(entries.get(name).cloned()))
}

/// Store `value` under `name`, writing the one Keychain item.
pub fn set(name: &str, value: &[u8]) -> Result<(), String> {
    with_entries(|entries| {
        let mut next = entries.clone();
        next.insert(name.to_string(), Zeroizing::new(value.to_vec()));
        save_to_keychain(&next)?;
        *entries = next;
        Ok(())
    })
}

/// Forget `name`. Removing an absent secret is not an error.
pub fn delete(name: &str) -> Result<(), String> {
    with_entries(|entries| {
        if !entries.contains_key(name) {
            return Ok(());
        }
        let mut next = entries.clone();
        next.remove(name);
        save_to_keychain(&next)?;
        *entries = next;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_round_trip_through_the_stored_form() {
        let mut entries = Entries::new();
        entries.insert(
            "provider:openai".into(),
            Zeroizing::new(b"sk-test".to_vec()),
        );
        entries.insert(
            "chatgpt:host-id".into(),
            Zeroizing::new(b"urn:uuid:x".to_vec()),
        );
        let decoded = decode(&encode(&entries)).unwrap();
        assert_eq!(
            decoded.get("provider:openai").map(|v| v.as_slice()),
            Some(&b"sk-test"[..])
        );
        assert_eq!(decoded.len(), 2);
        assert!(decode(b"not json").is_err());
        assert!(decode(br#"{"a": 1}"#).is_err());
    }
}
