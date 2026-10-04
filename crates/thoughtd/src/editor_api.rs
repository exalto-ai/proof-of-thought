//! Editor-only lifecycle and reviewer-management endpoints.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use std::sync::Arc;
use thought_mcp::{
    ActorRef, MutationContext, ReviewerAccess, ReviewerClient, SuggestedChange, Workspace,
};
use thoughtd::connections::{ConnectionRegistry, now_ms};

#[derive(Clone)]
struct EditorState {
    workspace: Arc<Workspace>,
    reviewers: Arc<ConnectionRegistry>,
}

#[derive(serde::Deserialize)]
struct CreateDocument {
    title: String,
    #[serde(default)]
    markdown: Option<String>,
}

#[derive(serde::Deserialize)]
struct SetDeleted {
    deleted: bool,
}

/// Who answered in built-in chat: an API key's provider, or the user's
/// ChatGPT plan. Separate from `ReviewerProvider`, which belongs to saved
/// reviewer connections.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum ChatProvider {
    Openai,
    Anthropic,
    Chatgpt,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateChatSuggestion {
    request_id: String,
    provider: ChatProvider,
    requested_model: String,
    #[serde(default)]
    reported_model: Option<String>,
    change: ChatChange,
}

/// One edit a chat model made with its tools. Edits to an existing block
/// carry that block's Markdown as the model saw it.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ChatChange {
    InsertBlocks {
        after: ChatSuggestionPosition,
        markdown: String,
    },
    ReplaceBlock {
        block_id: String,
        markdown: String,
        original: String,
    },
    DeleteBlock {
        block_id: String,
        original: String,
    },
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ChatSuggestionPosition {
    Start,
    End,
    Block { block_id: String },
}

#[derive(serde::Deserialize)]
struct CreateReviewer {
    client: ReviewerClient,
    display_label: String,
    access: ReviewerAccess,
}

#[derive(serde::Deserialize)]
struct UpdateReviewer {
    expected_revision: i64,
    display_label: String,
    access: ReviewerAccess,
}

#[derive(serde::Deserialize)]
struct ReviewerRevision {
    expected_revision: i64,
}

type ApiError = (StatusCode, String);

fn failed(error: impl std::fmt::Display) -> ApiError {
    (StatusCode::BAD_REQUEST, error.to_string())
}

pub fn routes(workspace: Arc<Workspace>, reviewers: Arc<ConnectionRegistry>) -> Router {
    Router::new()
        .route("/editor/documents", post(create_document))
        .route(
            "/editor/documents/{doc_id}/deletion",
            post(set_document_deleted),
        )
        .route(
            "/editor/documents/{doc_id}/suggestions",
            get(list_suggestions),
        )
        .route(
            "/editor/documents/{doc_id}/suggestions/pro-chat",
            post(create_chat_suggestion),
        )
        .route(
            "/editor/documents/{doc_id}/suggestions/{suggestion_id}/accept",
            post(accept_suggestion),
        )
        .route(
            "/editor/documents/{doc_id}/suggestions/{suggestion_id}/reject",
            post(reject_suggestion),
        )
        .route(
            "/editor/reviewer-connections",
            get(list_reviewers).post(create_reviewer),
        )
        .route(
            "/editor/reviewer-connections/{connection_id}",
            patch(update_reviewer).delete(revoke_reviewer),
        )
        .route(
            "/editor/reviewer-connections/{connection_id}/reset",
            post(reset_reviewer),
        )
        .with_state(EditorState {
            workspace,
            reviewers,
        })
}

async fn create_document(
    State(state): State<EditorState>,
    Json(input): Json<CreateDocument>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let actor = ActorRef::editor();
    let document = match input.markdown {
        Some(markdown) => state.workspace.create_document_from_markdown_with_context(
            &input.title,
            &markdown,
            &actor,
            &MutationContext::imported(),
        ),
        None => state.workspace.create_document_with_context(
            &input.title,
            &actor,
            &MutationContext::entered(),
        ),
    }
    .map_err(failed)?;
    Ok(Json(serde_json::to_value(document).map_err(failed)?))
}

async fn set_document_deleted(
    State(state): State<EditorState>,
    Path(doc_id): Path<String>,
    Json(input): Json<SetDeleted>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let outcome = state
        .workspace
        .set_document_deleted_with_context(
            &doc_id,
            input.deleted,
            &ActorRef::editor(),
            &MutationContext::command(),
        )
        .map_err(failed)?;
    Ok(Json(serde_json::to_value(outcome).map_err(failed)?))
}

async fn list_suggestions(
    State(state): State<EditorState>,
    Path(doc_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let suggestions = state.workspace.list_suggestions(&doc_id).map_err(failed)?;
    Ok(Json(serde_json::to_value(suggestions).map_err(failed)?))
}

async fn create_chat_suggestion(
    State(state): State<EditorState>,
    Path(doc_id): Path<String>,
    Json(request): Json<CreateChatSuggestion>,
) -> Result<Json<serde_json::Value>, ApiError> {
    const MAX_MARKDOWN_BYTES: usize = 256 * 1024;
    let markdown = match &request.change {
        ChatChange::InsertBlocks { markdown, .. } | ChatChange::ReplaceBlock { markdown, .. } => {
            Some(markdown)
        }
        ChatChange::DeleteBlock { .. } => None,
    };
    if markdown.is_some_and(|markdown| {
        markdown.trim().is_empty() || markdown.len() > MAX_MARKDOWN_BYTES || markdown.contains('\0')
    }) {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "The chat edit is empty or too large to suggest.".into(),
        ));
    }
    for value in
        std::iter::once(request.requested_model.as_str()).chain(request.reported_model.as_deref())
    {
        if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
            return Err((
                StatusCode::BAD_REQUEST,
                "The chat suggestion contains invalid model metadata.".into(),
            ));
        }
    }

    // The model saw one version of the block it edits. If the block has since
    // changed or gone, the edit no longer means what it did.
    let changed = || {
        (
            StatusCode::CONFLICT,
            "That part of the note changed after this reply was written. Ask again.".to_string(),
        )
    };
    if let ChatChange::ReplaceBlock {
        block_id, original, ..
    }
    | ChatChange::DeleteBlock { block_id, original } = &request.change
    {
        let current = state
            .workspace
            .block_markdown(&doc_id, block_id)
            .map_err(|_| changed())?;
        if current.trim_end() != original.trim_end() {
            return Err(changed());
        }
    }
    let change = match request.change {
        ChatChange::InsertBlocks { after, markdown } => SuggestedChange::InsertBlocks {
            after: Some(match after {
                ChatSuggestionPosition::Start => "start".to_string(),
                ChatSuggestionPosition::End => "end".to_string(),
                ChatSuggestionPosition::Block { block_id } => block_id,
            }),
            markdown,
        },
        ChatChange::ReplaceBlock {
            block_id, markdown, ..
        } => SuggestedChange::ReplaceBlock { block_id, markdown },
        ChatChange::DeleteBlock { block_id, .. } => SuggestedChange::DeleteBlock { block_id },
    };

    let current = state.workspace.read_document(&doc_id).map_err(failed)?;
    let (provider_id, provider_label) = match request.provider {
        ChatProvider::Openai => ("openai", "OpenAI"),
        ChatProvider::Anthropic => ("anthropic", "Anthropic"),
        ChatProvider::Chatgpt => ("chatgpt", "ChatGPT"),
    };
    let connection_id = format!("pro-chat:{provider_id}");
    let model = request
        .reported_model
        .as_deref()
        .unwrap_or(&request.requested_model);
    let actor = ActorRef::reviewer(
        &connection_id,
        &format!("{provider_label} chat (reported)"),
        Some(model),
        Some(&request.request_id),
    );
    let context = MutationContext::mcp_connection(
        format!("{provider_label} chat (reported)"),
        &connection_id,
    );
    let outcome = state
        .workspace
        .propose_suggestion(
            &doc_id,
            &request.request_id,
            &current.content_revision,
            &change,
            None,
            Some(model),
            &connection_id,
            &actor,
            &context,
        )
        .map_err(|error| match error {
            thought_mcp::WorkspaceError::Block(_) => changed(),
            other => failed(other),
        })?;
    Ok(Json(serde_json::to_value(outcome).map_err(failed)?))
}

async fn accept_suggestion(
    State(state): State<EditorState>,
    Path((doc_id, suggestion_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let outcome = state
        .workspace
        .accept_suggestion(&doc_id, &suggestion_id, &ActorRef::editor())
        .map_err(failed)?;
    Ok(Json(serde_json::to_value(outcome).map_err(failed)?))
}

async fn reject_suggestion(
    State(state): State<EditorState>,
    Path((doc_id, suggestion_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let outcome = state
        .workspace
        .reject_suggestion(&doc_id, &suggestion_id, &ActorRef::editor())
        .map_err(failed)?;
    Ok(Json(serde_json::to_value(outcome).map_err(failed)?))
}

async fn list_reviewers(
    State(state): State<EditorState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(serde_json::json!({
        "connections": state.reviewers.list().map_err(failed)?
    })))
}

async fn create_reviewer(
    State(state): State<EditorState>,
    Json(input): Json<CreateReviewer>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let connection = state
        .reviewers
        .create(input.client, input.display_label, input.access, now_ms())
        .map_err(failed)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "connection": connection })),
    ))
}

async fn update_reviewer(
    State(state): State<EditorState>,
    Path(connection_id): Path<String>,
    Json(input): Json<UpdateReviewer>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let connection = state
        .reviewers
        .update(
            &connection_id,
            input.expected_revision,
            input.display_label,
            input.access,
            now_ms(),
        )
        .map_err(failed)?;
    Ok(Json(serde_json::json!({ "connection": connection })))
}

async fn reset_reviewer(
    State(state): State<EditorState>,
    Path(connection_id): Path<String>,
    Json(input): Json<ReviewerRevision>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let connection = state
        .reviewers
        .reset(&connection_id, input.expected_revision, now_ms())
        .map_err(failed)?;
    Ok(Json(serde_json::json!({ "connection": connection })))
}

async fn revoke_reviewer(
    State(state): State<EditorState>,
    Path(connection_id): Path<String>,
    Json(input): Json<ReviewerRevision>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let connection = state
        .reviewers
        .revoke(&connection_id, input.expected_revision, now_ms())
        .map_err(failed)?;
    Ok(Json(serde_json::json!({ "connection": connection })))
}
