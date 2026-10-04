mod harness;

use harness::Daemon;

#[test]
fn window_lifecycle_operations_do_not_self_assert_over_mcp() {
    let daemon = Daemon::start();
    let created = daemon.editor_post(
        "/editor/documents",
        serde_json::json!({ "title": "Import", "markdown": "Imported text" }),
    );
    let doc_id = created["doc_id"].as_str().unwrap();

    let lineage = daemon
        .connect()
        .call("document_lineage", serde_json::json!({ "doc_id": doc_id }));
    let source = &lineage["summary"]["contributions"][0]["source"];
    assert_eq!(source["ingress"], "imported");
    assert_eq!(source["assurance"], "observed");
    assert_eq!(source["alignment"], "exact");

    daemon.editor_post(
        &format!("/editor/documents/{doc_id}/deletion"),
        serde_json::json!({ "deleted": true }),
    );
    let trashed = daemon.call(
        "list_documents",
        serde_json::json!({ "trashed": true, "limit": 10 }),
    );
    assert_eq!(trashed["documents"][0]["doc_id"], doc_id);
}

fn chat_edit(
    daemon: &Daemon,
    doc_id: &str,
    request_id: &str,
    provider: &str,
    change: serde_json::Value,
) -> serde_json::Value {
    daemon.editor_post(
        &format!("/editor/documents/{doc_id}/suggestions/pro-chat"),
        serde_json::json!({
            "request_id": request_id,
            "provider": provider,
            "requested_model": "gpt-test",
            "reported_model": "gpt-test-2026",
            "change": change,
        }),
    )
}

#[test]
fn provider_chat_can_create_only_pending_reported_suggestions() {
    let daemon = Daemon::start();
    let created = daemon.editor_post(
        "/editor/documents",
        serde_json::json!({ "title": "Draft", "markdown": "# Title\n\nOriginal text" }),
    );
    let doc_id = created["doc_id"].as_str().unwrap();
    let block_id = daemon.connect().read_document(doc_id)["blocks"][1]["block_id"]
        .as_str()
        .unwrap()
        .to_string();

    let inserted = chat_edit(
        &daemon,
        doc_id,
        "chat-request-1.0",
        "openai",
        serde_json::json!({
            "kind": "insert_blocks",
            "after": { "kind": "end" },
            "markdown": "Suggested ending"
        }),
    );
    assert_eq!(inserted["suggestion"]["state"], "pending");
    assert_eq!(inserted["suggestion"]["patch"]["kind"], "insert_blocks");
    assert_eq!(
        inserted["suggestion"]["proposer"]["label"],
        "OpenAI chat (reported)"
    );

    let replaced = chat_edit(
        &daemon,
        doc_id,
        "chat-request-1.1",
        "chatgpt",
        serde_json::json!({
            "kind": "replace_block",
            "block_id": block_id,
            "markdown": "Better text",
            "original": "Original text"
        }),
    );
    assert_eq!(replaced["suggestion"]["patch"]["kind"], "replace_block");
    assert_eq!(
        replaced["suggestion"]["proposer"]["label"],
        "ChatGPT chat (reported)"
    );
    assert_eq!(
        daemon.read_document(doc_id)["markdown"],
        "# Title\n\nOriginal text"
    );

    // An edit written against wording the block no longer has is refused.
    let stale = daemon.editor_post_status(
        &format!("/editor/documents/{doc_id}/suggestions/pro-chat"),
        serde_json::json!({
            "request_id": "chat-request-1.2",
            "provider": "anthropic",
            "requested_model": "claude-test",
            "change": {
                "kind": "delete_block",
                "block_id": block_id,
                "original": "Different text"
            }
        }),
    );
    assert_eq!(stale, 409);
}

#[test]
fn edit_mode_applies_chat_edits_directly_with_reported_attribution() {
    let daemon = Daemon::start();
    let created = daemon.editor_post(
        "/editor/documents",
        serde_json::json!({ "title": "Draft", "markdown": "# Title\n\nOriginal text" }),
    );
    let doc_id = created["doc_id"].as_str().unwrap();
    let block_id = daemon.connect().read_document(doc_id)["blocks"][1]["block_id"]
        .as_str()
        .unwrap()
        .to_string();

    let edited = daemon.editor_post(
        &format!("/editor/documents/{doc_id}/edits/pro-chat"),
        serde_json::json!({
            "request_id": "chat-request-2.0",
            "provider": "chatgpt",
            "requested_model": "gpt-plan",
            "change": {
                "kind": "replace_block",
                "block_id": block_id,
                "markdown": "Better text",
                "original": "Original text"
            }
        }),
    );
    assert!(edited["block_id"].is_string());
    assert_eq!(
        daemon.read_document(doc_id)["markdown"],
        "# Title\n\nBetter text"
    );
    let suggestions = daemon.call("list_suggestions", serde_json::json!({ "doc_id": doc_id }));
    assert_eq!(suggestions["suggestions"], serde_json::json!([]));

    let lineage = daemon.call("document_lineage", serde_json::json!({ "doc_id": doc_id }));
    let sources = lineage["summary"]["contributions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|contribution| contribution["source"].clone())
        .collect::<Vec<_>>();
    assert!(sources.iter().any(|source| source["ingress"] == "api"
        && source["assurance"] == "reported"
        && source["label"] == "ChatGPT chat (reported)"));

    // The same freshness check as suggestions: the edit is refused, not merged.
    let stale = daemon.editor_post_status(
        &format!("/editor/documents/{doc_id}/edits/pro-chat"),
        serde_json::json!({
            "request_id": "chat-request-2.1",
            "provider": "chatgpt",
            "requested_model": "gpt-plan",
            "change": { "kind": "delete_block", "block_id": block_id, "original": "Original text" }
        }),
    );
    assert_eq!(stale, 409);
}
