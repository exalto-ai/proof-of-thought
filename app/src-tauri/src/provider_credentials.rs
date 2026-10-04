//! The one native boundary for built-in provider keys, kept in the app's
//! single Keychain item (see `secret_store`).

use zeroize::{Zeroize as _, Zeroizing};

use crate::secret_store;

const MAX_KEY_BYTES: usize = 4096;

fn valid(key: &[u8]) -> bool {
    !key.is_empty() && key.len() <= MAX_KEY_BYTES && !key.contains(&0)
}

fn name(provider: &str) -> String {
    format!("provider:{provider}")
}

pub fn contains(provider: &str) -> Result<bool, String> {
    Ok(secret_store::get(&name(provider))?.is_some_and(|mut key| {
        let configured = valid(&key);
        key.zeroize();
        configured
    }))
}

pub fn get(provider: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = secret_store::get(&name(provider))?
        .ok_or_else(|| "The provider key is missing. Add it in Settings → Chat.".to_string())?;
    if !valid(&key) {
        return Err("The saved provider key is invalid. Replace it in Settings → Chat.".into());
    }
    Ok(key)
}

pub fn set(provider: &str, key: &[u8]) -> Result<(), String> {
    if !valid(key) {
        return Err("Enter a non-empty API key smaller than 4 KiB.".into());
    }
    secret_store::set(&name(provider), key)
}

pub fn delete(provider: &str) -> Result<(), String> {
    secret_store::delete(&name(provider))
}
