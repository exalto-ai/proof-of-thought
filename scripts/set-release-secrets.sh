#!/bin/bash
# Fill the new repo's protected `release` environment from 1Password.
# Values go straight from `op` into `gh secret set`; nothing is printed,
# written to disk, or put on the clipboard. Only secret names are shown.
set -euo pipefail

REPO=exalto-ai/proof-of-thought
SIGN_VAULT="Exalto - Apple Signing"
SIGN_ITEM="Apple Developer ID - Exalto (3FGNZ9DY9Y)"
NOTARY_VAULT="Exalto - LLM Notary"
NOTARY_ITEM="App Store Connect API - LLM Notary Notarization (2RTKQ2H2FW)"

put() { gh secret set --env release -R "$REPO" "$1"; }

# Pick one value out of an item's JSON on stdin, without echoing anything
# else. `field <label regex>` prints that field's value; `file <name regex>`
# prints an attached file's name. On a miss it lists labels only.
pick() {
  python3 -c '
import json, re, sys
mode, pattern = sys.argv[1], sys.argv[2]
item = json.load(sys.stdin)
if mode == "field":
    for f in item.get("fields", []):
        if re.search(pattern, f.get("label", ""), re.I) and f.get("value"):
            sys.stdout.write(f["value"]); sys.exit(0)
    labels = [f.get("label", "") for f in item.get("fields", [])]
    sys.exit("No field matching %r. Labels: %s" % (pattern, labels))
for f in item.get("files", []):
    if re.search(pattern, f.get("name", ""), re.I):
        sys.stdout.write(f["name"]); sys.exit(0)
sys.exit("No file matching %r. Files: %s" % (pattern, [f.get("name") for f in item.get("files", [])]))
' "$@"
}

echo "Reading the signing item…"
sign_json=$(op item get "$SIGN_ITEM" --vault "$SIGN_VAULT" --format json --reveal)
notary_json=$(op item get "$NOTARY_ITEM" --vault "$NOTARY_VAULT" --format json --reveal)
sign_id=$(printf %s "$sign_json" | python3 -c 'import json,sys; i=json.load(sys.stdin); print(i["vault"]["id"] + "/" + i["id"])')

# Public identifiers, as recorded in docs/releasing.md.
printf %s "Developer ID Application: Exalto, Inc. (3FGNZ9DY9Y)" | put APPLE_SIGNING_IDENTITY
printf %s "3FGNZ9DY9Y" | put APPLE_TEAM_ID

# The Developer ID certificate (.p12, base64) and its export password.
p12=$(printf %s "$sign_json" | pick file '^pkcs12$|\.p12$')
op read "op://$sign_id/$p12" | base64 | put APPLE_CERTIFICATE
printf %s "$sign_json" | pick field '^password$' | put APPLE_CERTIFICATE_PASSWORD

# The App Store Connect notarization key: PEM (base64), key ID, issuer ID.
printf %s "$notary_json" | pick field '^credential$' | base64 | put APPLE_NOTARIZATION_KEY_BASE64
printf %s "$notary_json" | pick field 'key.?id' | put APPLE_NOTARIZATION_KEY_ID
printf %s "$notary_json" | pick field 'issuer' | put APPLE_NOTARIZATION_ISSUER_ID
unset sign_json notary_json

echo
echo "Now the Claude Code token for the review workflows."
echo "In another terminal tab, run:  claude setup-token"
echo "then paste the token at the prompt below (it is not shown)."
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$REPO"

echo
echo "release environment secrets:"
gh secret list --env release -R "$REPO"
echo "repository secrets:"
gh secret list -R "$REPO"
