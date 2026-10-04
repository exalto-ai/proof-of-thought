//! Minimal built-in provider configuration.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{chatgpt_account, provider_credentials};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Openai,
    Anthropic,
    /// The user's ChatGPT plan, through Sign in with ChatGPT.
    Chatgpt,
}

impl Provider {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Chatgpt => "chatgpt",
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Chatgpt => "ChatGPT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderConfiguration {
    provider: Provider,
    configured: bool,
    /// The signed-in ChatGPT account's email, for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderActionOutcome {
    Saved,
    Removed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderActionResult {
    outcome: ProviderActionOutcome,
    configuration: ProviderConfiguration,
}

fn configuration(provider: Provider) -> Result<ProviderConfiguration, String> {
    if provider == Provider::Chatgpt {
        let account = chatgpt_account::account()?;
        return Ok(ProviderConfiguration {
            provider,
            configured: account.is_some(),
            account,
        });
    }
    Ok(ProviderConfiguration {
        provider,
        configured: provider_credentials::contains(provider.id())?,
        account: None,
    })
}

/// The bearer credential for `provider`: its API key, or for ChatGPT a
/// current access token from the signed-in account.
pub(crate) fn credential(provider: Provider) -> Result<Zeroizing<Vec<u8>>, String> {
    match provider {
        Provider::Chatgpt => chatgpt_account::access_token(),
        _ => provider_credentials::get(provider.id()),
    }
}

#[tauri::command]
pub async fn provider_configurations() -> Result<Vec<ProviderConfiguration>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        [Provider::Chatgpt, Provider::Openai, Provider::Anthropic]
            .into_iter()
            .map(configuration)
            .collect()
    })
    .await
    .map_err(|_| "Could not read provider configuration.".to_string())?
}

#[tauri::command]
pub async fn configure_provider_key(
    app: tauri::AppHandle,
    provider: Provider,
) -> Result<ProviderActionResult, String> {
    if provider == Provider::Chatgpt {
        return sign_in_with_chatgpt(app).await;
    }
    #[cfg(target_os = "macos")]
    let key = crate::macos_secure_input::prompt_key(
        app,
        provider.name(),
        configuration(provider)?.configured,
    )
    .await?;
    #[cfg(not(target_os = "macos"))]
    let key: Option<Zeroizing<Vec<u8>>> = {
        let _ = app;
        return Err("Provider keys are available only in the macOS app.".into());
    };

    let outcome = if let Some(key) = key {
        tauri::async_runtime::spawn_blocking(move || {
            provider_credentials::set(provider.id(), &key)
        })
        .await
        .map_err(|_| "Could not save the provider key.".to_string())??;
        ProviderActionOutcome::Saved
    } else {
        ProviderActionOutcome::Cancelled
    };
    Ok(ProviderActionResult {
        outcome,
        configuration: configuration(provider)?,
    })
}

#[tauri::command]
pub async fn remove_provider_key(
    app: tauri::AppHandle,
    provider: Provider,
) -> Result<ProviderActionResult, String> {
    if provider == Provider::Chatgpt {
        // Signing out is undone by signing in again, so it needs no prompt.
        tauri::async_runtime::spawn_blocking(chatgpt_account::sign_out)
            .await
            .map_err(|_| "Could not sign out of ChatGPT.".to_string())??;
        return Ok(ProviderActionResult {
            outcome: ProviderActionOutcome::Removed,
            configuration: configuration(provider)?,
        });
    }
    #[cfg(target_os = "macos")]
    let confirmed = crate::macos_secure_input::confirm_remove(app, provider.name()).await?;
    #[cfg(not(target_os = "macos"))]
    let confirmed = {
        let _ = app;
        return Err("Provider keys are available only in the macOS app.".into());
    };

    let outcome = if confirmed {
        tauri::async_runtime::spawn_blocking(move || provider_credentials::delete(provider.id()))
            .await
            .map_err(|_| "Could not remove the provider key.".to_string())??;
        ProviderActionOutcome::Removed
    } else {
        ProviderActionOutcome::Cancelled
    };
    Ok(ProviderActionResult {
        outcome,
        configuration: configuration(provider)?,
    })
}

/// Browser sign-in with ChatGPT; waits until the browser returns or it is
/// cancelled.
async fn sign_in_with_chatgpt(app: tauri::AppHandle) -> Result<ProviderActionResult, String> {
    use tauri_plugin_opener::OpenerExt as _;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        chatgpt_account::sign_in(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "Could not open the browser to sign in.".to_string())
        })
    })
    .await
    .map_err(|_| "The ChatGPT sign-in stopped unexpectedly.".to_string())??;
    Ok(ProviderActionResult {
        outcome: match outcome {
            chatgpt_account::SignIn::SignedIn => ProviderActionOutcome::Saved,
            chatgpt_account::SignIn::Cancelled => ProviderActionOutcome::Cancelled,
        },
        configuration: configuration(Provider::Chatgpt)?,
    })
}

/// Stop a ChatGPT sign-in that is waiting for the browser.
#[tauri::command]
pub fn cancel_chatgpt_sign_in() {
    chatgpt_account::cancel_sign_in();
}
