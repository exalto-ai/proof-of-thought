# Chat focus and attachments

Each message carries where the person is in the note. With text selected, it sends that text,
bounded to 32 KiB, and the top-level blocks it spans. With only a caret, it sends the caret's block.
The model reads these as `selected_focus` and `cursor`, so "rewrite this" or "add a line here"
resolve without quoting. The editor keeps drawing the selection, in grey, while focus is in the
chat, so it is clear what will go along.

A chip above the composer shows the selection. Its × leaves the selection, and where it is, out of
the next messages until the selection changes. The focus is a snapshot taken at Send, not a live
range, and carries no verified provenance.

The same composer may attach PDFs and UTF-8 text files for one request. The app sends their bytes
inline after validating them in both the WebView and native boundary. It never sends a filesystem
path, creates a temporary file, obtains a provider file ID, or stores the original attachment
payload in local chat history, the daemon, a proof, or provenance. A visible filename and size
summary may remain in the local conversation so the person can see what was sent. A provider may
quote or transform an attachment in its visible response, which persists as ordinary AI chat.

Files are not resent with later messages. Attach them again when a follow-up needs the exact source.
Provider processing and retention begin once Send succeeds, and larger context can increase token
use, latency, and cost.
