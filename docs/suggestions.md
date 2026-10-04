# Reviewer suggestions

Configured reviewers can propose a change. They cannot edit document content directly.

## Flow

1. The reviewer calls `read_document` and receives `content_revision` plus stable block ids.
2. It calls `suggest_change` with one block-addressed operation and a unique `request_id`.
3. The daemon validates and normalizes the patch once, then stores it in the document's
   `suggestions` Y.Map. The existing CRDT op log persists and replicates it.
4. Any editor window can accept or reject through the editor-only API. The window shows a
   pending proposal in the text itself, as tracked changes: proposed words in the accent,
   removed words struck through. Clicking one opens a small card with Accept and Reject.
5. Acceptance applies the stored patch and marks it accepted in one CRDT update. Accepted
   text is attributed to the reviewer with `suggestion` ingress.

There is no second suggestion table or replay ledger. Reusing a reviewer's `request_id` for
the same document returns the first proposal.

## Connecting a reviewer

Connections in Settings creates a separately scoped reviewer credential, then shows setup for
the selected client:

- ChatGPT desktop: add a STDIO server under Settings → MCP servers, then restart and check `/mcp`.
- Codex: run the generated `codex mcp add` command, then check `/mcp`.
- Claude Desktop: merge the generated JSON entry into `claude_desktop_config.json`, fully quit,
  reopen, then click + in a chat → Connectors or inspect Developer settings.
- Claude Code: run the generated `claude mcp add --transport stdio --scope user` command, then
  check `/mcp`.

The copied value contains a stable connection ID, never its credential. ChatGPT on the web does
not read the local desktop configuration. ChatGPT desktop and Codex share local MCP configuration
on the same Mac. Claude Desktop and Claude Code have separate setup paths.

`Not used yet` means the credential has not authenticated a request since it was created or reset.
`Last used` is historical local activity, not live presence. A displayed model is explicitly
reported by the client and is not provider-verified.

## Patch shapes

`suggest_change` accepts one of:

- `replace_block`
- `insert_blocks`
- `replace_text`
- `delete_block`

Markdown and find/replace input are converted to normalized ProseMirror nodes at proposal
time. Acceptance does not parse or search again.

## Groups

A proposal may carry a group (`{ id, label }`) naming the change it belongs to, so a rewrite made
of several edits is decided once. `/editor/documents/{id}/suggestion-groups/{group}/accept`
applies every pending member, in the order proposed, as one CRDT update. A member whose
replacement changed a block's type, and so its id, is followed by later members that name the
old id. If any member is stale, nothing is applied: a group is one decision, and accepting part
of it could leave the note half rewritten. `/reject` rejects every pending member. Built-in chat
sets groups; MCP reviewers do not yet.

## Stale proposals

A proposal records a digest of the blocks it addresses: the replaced or deleted block's id and
content, or the id of the block an insertion follows. Insertions at the start or end address no
block. Edits elsewhere leave the proposal pending and acceptable, so a person can keep writing
while suggestions wait.

If a targeted block changes or disappears, the proposal is shown as `stale` and cannot be
accepted. The reviewer must read the current document and submit a new proposal. Rejection
still works. Records written before target digests existed fall back to the whole-document
`content_revision`, which covers normalized content, structure, block identity, and block order.

This is still conservative. It avoids relative-anchor rebasing, overlap graphs, and automatic
conflict resolution. The cost of scoping staleness to target blocks is semantic: a proposal can
be accepted after an edit elsewhere that changes what it should say, such as a rewritten
definition it relies on. The person accepting it sees the current note and is the check. Multiple windows do not race the state:
all decisions pass through the one daemon authority and are serialized by the workspace.
