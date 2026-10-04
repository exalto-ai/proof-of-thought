# Reviewable chat suggestions

Built-in chat changes the note only through three edit tools offered to the model:
`replace_block`, `insert_blocks`, and `delete_block`. The note is sent as numbered blocks (`b1`,
`b2`, …), and the tools address those numbers. The native side resolves each call to a block
index and the block's Markdown as sent. A call it cannot read is dropped. There is one model turn
per message: tool calls are the answer, and no results are sent back.

The window waits for current editor changes to save, maps each index to the block's stable id,
and sends each edit to the daemon as its own pending suggestion. Edits to an existing block carry
that block's Markdown as the model saw it. If the block has changed or gone since, the daemon
refuses that one edit, and the others still land. The reply lists each suggestion it made, and
clicking one shows it in the note with Accept and Reject. Current wording does not change until
the person accepts. Provider and model labels remain reported claims.

## Edit mode

The composer's mode menu switches a note between **Suggest** (the default) and **Edit**. In Edit,
the same edits, with the same freshness check, apply directly through
`/editor/documents/{id}/edits/pro-chat` and are attributed to the reported chat actor with `api`
ingress. The reply links to each edited block. The mode is remembered per note in that device's
window storage and never synced. Every note starts in Suggest. See AD-24 in
[`architecture.md`](architecture.md).

This reuses the editor API, daemon bearer, suggestion store, and review UI. It adds no provider
credential, native transcript, or second capability system. Only the edits
cross into the suggestion request. Requested thinking, attached files, filenames, and local chat
history do not enter the daemon or proof. If an edit quotes or transforms a file, accepted
wording remains reported AI output rather than a claim about authorship or provenance for that
file.
