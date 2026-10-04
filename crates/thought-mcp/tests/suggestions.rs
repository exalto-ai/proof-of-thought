use thought_core::SuggestionState;
use thought_mcp::{
    ActorRef, MutationContext, SuggestedChange, SuggestionError, Workspace, WorkspaceError,
};

fn reviewer() -> (ActorRef, MutationContext) {
    (
        ActorRef::reviewer(
            "reviewer-one",
            "Review bot",
            Some("reported-model"),
            Some("run-1"),
        ),
        MutationContext::mcp_connection("Configured for Codex (reported)", "reviewer-one"),
    )
}

fn propose_replace(
    workspace: &Workspace,
    doc_id: &str,
    block_id: &str,
    revision: &str,
) -> thought_mcp::SuggestionOutcome {
    let (actor, context) = reviewer();
    workspace
        .propose_suggestion(
            doc_id,
            "request-one",
            revision,
            &SuggestedChange::ReplaceText {
                block_id: block_id.to_string(),
                find: "Draft".into(),
                replace: "Final".into(),
                occurrence: Some(1),
            },
            Some("Use firmer wording"),
            Some("reported-model"),
            "reviewer-one",
            &actor,
            &context,
            None,
        )
        .unwrap()
}

#[test]
fn proposals_are_replicated_metadata_and_retry_by_request_id() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "# Draft\n\nBody", &ActorRef::editor())
        .unwrap();
    let before_version = document.version.clone();
    let proposal = propose_replace(
        &workspace,
        &document.doc_id,
        &document.blocks[0].block_id,
        &document.content_revision,
    );
    assert!(!proposal.replayed);
    assert_eq!(proposal.suggestion.state, SuggestionState::Pending);
    assert_eq!(proposal.content_revision, document.content_revision);

    let after = workspace.read_document(&document.doc_id).unwrap();
    assert_eq!(after.markdown, document.markdown);
    assert_eq!(after.content_revision, document.content_revision);
    assert_ne!(after.version, before_version);

    let retry = propose_replace(
        &workspace,
        &document.doc_id,
        &document.blocks[0].block_id,
        &document.content_revision,
    );
    assert!(retry.replayed);
    assert_eq!(
        retry.suggestion.suggestion_id,
        proposal.suggestion.suggestion_id
    );
    assert_eq!(
        workspace
            .list_suggestions(&document.doc_id)
            .unwrap()
            .suggestions
            .len(),
        1
    );
}

#[test]
fn acceptance_applies_the_normalized_patch_and_attributes_the_reviewer() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "# Draft\n\nBody", &ActorRef::editor())
        .unwrap();
    let proposal = propose_replace(
        &workspace,
        &document.doc_id,
        &document.blocks[0].block_id,
        &document.content_revision,
    );

    let accepted = workspace
        .accept_suggestion(
            &document.doc_id,
            &proposal.suggestion.suggestion_id,
            &ActorRef::editor(),
        )
        .unwrap();
    assert_eq!(accepted.suggestion.state, SuggestionState::Accepted);
    assert_eq!(
        workspace.read_document(&document.doc_id).unwrap().markdown,
        "# Final\n\nBody"
    );
    let attribution = workspace.block_provenance(&document.doc_id).unwrap();
    let heading = attribution
        .iter()
        .find(|block| block.block_id == document.blocks[0].block_id)
        .unwrap();
    assert_eq!(heading.touched_by, "reviewer:reviewer-one");

    assert!(matches!(
        workspace.reject_suggestion(
            &document.doc_id,
            &proposal.suggestion.suggestion_id,
            &ActorRef::editor(),
        ),
        Err(WorkspaceError::Suggestion(SuggestionError::AlreadyDecided(
            _
        )))
    ));
}

#[test]
fn edits_elsewhere_leave_a_proposal_acceptable() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "# Draft\n\nBody", &ActorRef::editor())
        .unwrap();
    let proposal = propose_replace(
        &workspace,
        &document.doc_id,
        &document.blocks[0].block_id,
        &document.content_revision,
    );
    workspace
        .replace_block(
            &document.doc_id,
            &document.blocks[1].block_id,
            "Changed elsewhere",
            None,
            &ActorRef::editor(),
        )
        .unwrap();

    let listed = workspace.list_suggestions(&document.doc_id).unwrap();
    assert_eq!(listed.suggestions[0].state, SuggestionState::Pending);
    workspace
        .accept_suggestion(
            &document.doc_id,
            &proposal.suggestion.suggestion_id,
            &ActorRef::editor(),
        )
        .unwrap();
    let markdown = workspace.read_document(&document.doc_id).unwrap().markdown;
    assert!(markdown.contains("# Final"));
    assert!(markdown.contains("Changed elsewhere"));
}

#[test]
fn edits_to_the_target_block_make_a_proposal_stale_without_a_merge_engine() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "# Draft\n\nBody", &ActorRef::editor())
        .unwrap();
    let proposal = propose_replace(
        &workspace,
        &document.doc_id,
        &document.blocks[0].block_id,
        &document.content_revision,
    );
    workspace
        .replace_block(
            &document.doc_id,
            &document.blocks[0].block_id,
            "# Draft two",
            None,
            &ActorRef::editor(),
        )
        .unwrap();

    let listed = workspace.list_suggestions(&document.doc_id).unwrap();
    assert_eq!(listed.suggestions[0].state, SuggestionState::Stale);
    assert!(matches!(
        workspace.accept_suggestion(
            &document.doc_id,
            &proposal.suggestion.suggestion_id,
            &ActorRef::editor(),
        ),
        Err(WorkspaceError::Suggestion(
            SuggestionError::BaseRevisionMismatch { .. }
        ))
    ));
    assert!(
        workspace
            .read_document(&document.doc_id)
            .unwrap()
            .markdown
            .contains("Draft two")
    );
}

#[test]
fn rejection_and_proposals_survive_a_cold_start() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("workspace.sqlite");
    let (doc_id, suggestion_id) = {
        let workspace = Workspace::open(&database).unwrap();
        let document = workspace
            .create_document_from_markdown("", "# Draft", &ActorRef::editor())
            .unwrap();
        let proposal = propose_replace(
            &workspace,
            &document.doc_id,
            &document.blocks[0].block_id,
            &document.content_revision,
        );
        workspace
            .reject_suggestion(
                &document.doc_id,
                &proposal.suggestion.suggestion_id,
                &ActorRef::editor(),
            )
            .unwrap();
        (document.doc_id, proposal.suggestion.suggestion_id)
    };

    let reopened = Workspace::open(&database).unwrap();
    let suggestions = reopened.list_suggestions(&doc_id).unwrap().suggestions;
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].suggestion_id, suggestion_id);
    assert_eq!(suggestions[0].state, SuggestionState::Rejected);
}

fn propose_in_group(
    workspace: &Workspace,
    doc_id: &str,
    request_id: &str,
    change: SuggestedChange,
) -> thought_mcp::SuggestionOutcome {
    let (actor, context) = reviewer();
    let revision = workspace.read_document(doc_id).unwrap().content_revision;
    workspace
        .propose_suggestion(
            doc_id,
            request_id,
            &revision,
            &change,
            None,
            None,
            "reviewer-one",
            &actor,
            &context,
            Some(thought_core::SuggestionGroup {
                id: "rewrite-1".into(),
                label: "Tighten the draft".into(),
            }),
        )
        .unwrap()
}

#[test]
fn a_group_is_accepted_as_one_change_even_when_a_block_changes_type() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "First\n\nSecond", &ActorRef::editor())
        .unwrap();
    let first = document.blocks[0].block_id.clone();
    let second = document.blocks[1].block_id.clone();
    // A paragraph becomes a heading (a new block id), then content goes after it.
    propose_in_group(
        &workspace,
        &document.doc_id,
        "r1",
        SuggestedChange::ReplaceBlock {
            block_id: first.clone(),
            markdown: "# Title".into(),
        },
    );
    propose_in_group(
        &workspace,
        &document.doc_id,
        "r2",
        SuggestedChange::InsertBlocks {
            after: Some(first),
            markdown: "Intro".into(),
        },
    );
    propose_in_group(
        &workspace,
        &document.doc_id,
        "r3",
        SuggestedChange::DeleteBlock { block_id: second },
    );

    let accepted = workspace
        .accept_suggestion_group(&document.doc_id, "rewrite-1", &ActorRef::editor())
        .unwrap();
    assert_eq!(accepted.len(), 3);
    assert!(
        accepted
            .iter()
            .all(|s| s.state == SuggestionState::Accepted)
    );
    assert_eq!(
        workspace.read_document(&document.doc_id).unwrap().markdown,
        "# Title\n\nIntro"
    );
}

#[test]
fn a_stale_member_blocks_the_group_but_rejection_still_works() {
    let workspace = Workspace::open_in_memory().unwrap();
    let document = workspace
        .create_document_from_markdown("", "First\n\nSecond", &ActorRef::editor())
        .unwrap();
    let first = document.blocks[0].block_id.clone();
    let second = document.blocks[1].block_id.clone();
    propose_in_group(
        &workspace,
        &document.doc_id,
        "r1",
        SuggestedChange::ReplaceBlock {
            block_id: first,
            markdown: "One".into(),
        },
    );
    propose_in_group(
        &workspace,
        &document.doc_id,
        "r2",
        SuggestedChange::ReplaceBlock {
            block_id: second.clone(),
            markdown: "Two".into(),
        },
    );
    workspace
        .replace_block(
            &document.doc_id,
            &second,
            "Edited by hand",
            None,
            &ActorRef::editor(),
        )
        .unwrap();

    assert!(matches!(
        workspace.accept_suggestion_group(&document.doc_id, "rewrite-1", &ActorRef::editor()),
        Err(WorkspaceError::Suggestion(
            SuggestionError::BaseRevisionMismatch { .. }
        ))
    ));
    assert_eq!(
        workspace.read_document(&document.doc_id).unwrap().markdown,
        "First\n\nEdited by hand"
    );
    let rejected = workspace
        .reject_suggestion_group(&document.doc_id, "rewrite-1", &ActorRef::editor())
        .unwrap();
    assert_eq!(rejected.len(), 2);
    assert!(matches!(
        workspace.accept_suggestion_group(&document.doc_id, "rewrite-1", &ActorRef::editor()),
        Err(WorkspaceError::Suggestion(SuggestionError::NotFound(_)))
    ));
}
