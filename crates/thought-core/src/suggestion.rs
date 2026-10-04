//! Replicated reviewer proposals.
//!
//! A proposal is one JSON value in a Y.Map. The daemon is the only writer: MCP
//! reviewers can propose, and the bundled editor can accept or reject. That
//! single authority makes a mutable state field sufficient for the MVP.

use crate::{Document, SUGGESTIONS};
use serde::{Deserialize, Serialize};
use thought_schema::Node;
use yrs::{Any, Map, Out, ReadTxn, Transact};

pub const SUGGESTION_RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionProposer {
    pub actor_id: String,
    pub connection_id: String,
    pub label: String,
    pub source_label: String,
    pub reported_model: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SuggestionPatch {
    ReplaceBlock {
        block_id: String,
        nodes: Vec<Node>,
    },
    InsertBlocks {
        after: SuggestionBlockPosition,
        nodes: Vec<Node>,
    },
    ReplaceText {
        block_id: String,
        nodes: Vec<Node>,
    },
    DeleteBlock {
        block_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SuggestionBlockPosition {
    Start,
    End,
    Block { block_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionState {
    Pending,
    Accepted,
    Rejected,
    /// Derived while the blocks the proposal targets differ from its base.
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestionDecision {
    pub actor_id: String,
    pub actor_label: String,
    pub decided_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuggestionRecord {
    pub version: u32,
    pub suggestion_id: String,
    pub document_id: String,
    pub request_id: String,
    pub proposer: SuggestionProposer,
    pub base_content_revision: String,
    /// A digest of just the blocks the patch addresses. When present, edits
    /// elsewhere in the document leave the proposal current. Records written
    /// before it existed fall back to `base_content_revision`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_target_revision: Option<String>,
    pub patch: SuggestionPatch,
    pub explanation: Option<String>,
    pub state: SuggestionState,
    pub decision: Option<SuggestionDecision>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SuggestionRecordError {
    Invalid(String),
}

impl std::fmt::Display for SuggestionRecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => write!(f, "invalid suggestion record: {message}"),
        }
    }
}

impl std::error::Error for SuggestionRecordError {}

impl Document {
    pub fn suggestion(
        &self,
        suggestion_id: &str,
    ) -> Result<Option<SuggestionRecord>, SuggestionRecordError> {
        let txn = self.doc.transact();
        let Some(map) = txn.get_map(SUGGESTIONS) else {
            return Ok(None);
        };
        let Some(value) = map.get(&txn, suggestion_id) else {
            return Ok(None);
        };
        decode_record(suggestion_id, value)
    }

    pub fn suggestions(&self) -> Result<Vec<SuggestionRecord>, SuggestionRecordError> {
        let txn = self.doc.transact();
        let Some(map) = txn.get_map(SUGGESTIONS) else {
            return Ok(vec![]);
        };
        let mut records = map
            .iter(&txn)
            .map(|(id, value)| decode_record(id, value).map(Option::unwrap))
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.suggestion_id.cmp(&right.suggestion_id))
        });
        Ok(records)
    }

    pub fn put_suggestion(&self, record: &SuggestionRecord) -> Result<(), SuggestionRecordError> {
        validate_record(record)?;
        let json = serde_json::to_string(record)
            .map_err(|error| SuggestionRecordError::Invalid(error.to_string()))?;
        let map = self.doc.get_or_insert_map(SUGGESTIONS);
        map.insert(
            &mut self.doc.transact_mut(),
            record.suggestion_id.as_str(),
            json,
        );
        Ok(())
    }
}

fn decode_record(key: &str, value: Out) -> Result<Option<SuggestionRecord>, SuggestionRecordError> {
    let Out::Any(Any::String(json)) = value else {
        return Err(SuggestionRecordError::Invalid(format!(
            "`{key}` is not a JSON string"
        )));
    };
    let record: SuggestionRecord = serde_json::from_str(&json).map_err(|error| {
        SuggestionRecordError::Invalid(format!("`{key}` is not valid JSON: {error}"))
    })?;
    if record.suggestion_id != key {
        return Err(SuggestionRecordError::Invalid(format!(
            "map key `{key}` does not match embedded id `{}`",
            record.suggestion_id
        )));
    }
    validate_record(&record)?;
    Ok(Some(record))
}

fn validate_record(record: &SuggestionRecord) -> Result<(), SuggestionRecordError> {
    if record.version != SUGGESTION_RECORD_VERSION {
        return Err(SuggestionRecordError::Invalid(format!(
            "unsupported version {}",
            record.version
        )));
    }
    if record.suggestion_id.trim().is_empty() {
        return Err(SuggestionRecordError::Invalid("id is empty".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> SuggestionRecord {
        SuggestionRecord {
            version: SUGGESTION_RECORD_VERSION,
            suggestion_id: "reviewer:request".into(),
            document_id: "doc".into(),
            request_id: "request".into(),
            proposer: SuggestionProposer {
                actor_id: "reviewer:one".into(),
                connection_id: "one".into(),
                label: "Reviewer".into(),
                source_label: "Configured reviewer (reported)".into(),
                reported_model: Some("model".into()),
                session_id: None,
            },
            base_content_revision: "revision".into(),
            base_target_revision: Some("target".into()),
            patch: SuggestionPatch::DeleteBlock {
                block_id: "1:0".into(),
            },
            explanation: Some("Tighter wording".into()),
            state: SuggestionState::Pending,
            decision: None,
            created_at: 1,
        }
    }

    #[test]
    fn records_replicate_and_decisions_replace_the_same_entry() {
        let first = Document::new();
        let second = Document::new();
        let mut suggestion = record();
        first.put_suggestion(&suggestion).unwrap();
        second.apply_update(&first.encode_state()).unwrap();
        assert_eq!(second.suggestions().unwrap(), vec![suggestion.clone()]);

        suggestion.state = SuggestionState::Rejected;
        suggestion.decision = Some(SuggestionDecision {
            actor_id: "human:editor".into(),
            actor_label: "editor".into(),
            decided_at: 2,
        });
        first.put_suggestion(&suggestion).unwrap();
        second.apply_update(&first.encode_state()).unwrap();
        assert_eq!(
            second.suggestion(&suggestion.suggestion_id).unwrap(),
            Some(suggestion)
        );
    }

    #[test]
    fn records_written_before_target_revisions_still_decode() {
        let mut json = serde_json::to_value(record()).unwrap();
        json.as_object_mut().unwrap().remove("base_target_revision");
        let decoded: SuggestionRecord = serde_json::from_value(json).unwrap();
        assert_eq!(decoded.base_target_revision, None);
    }
}
