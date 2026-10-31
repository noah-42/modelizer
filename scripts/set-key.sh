#!/usr/bin/env bash
# MOD005 protocol: agent-blind keys.
#
# Usage:   scripts/set-key.sh <KEY_NAME>   e.g.  scripts/set-key.sh ZAI_API_KEY
#
# The key is read with a hidden prompt (never a CLI argument, never shell
# history, never an agent transcript) and validated against its provider
# BEFORE it is stored. Output is PASS/FAIL only — the key itself is never
# echoed. Agents must never run this script's internals or read the keychain
# back; verification of a stored key happens through the dashboard API.
set -euo pipefail

NAME="${1:?usage: set-key.sh <KEY_NAME> (e.g. ZAI_API_KEY)}"
SERVICE="modelizer"

# Hidden prompt — no echo, no argument passing.
read -rsp "Paste value for ${NAME} (input hidden): " VALUE
echo
[ -n "$VALUE" ] || { echo "FAIL: empty input"; exit 1; }

# The MOD004 incident: placeholder brackets and whitespace pasted verbatim.
# Reject them loudly instead of storing a broken credential.
if [[ "$VALUE" == \<* ]] || [[ "$VALUE" == *\> ]] || [[ "$VALUE" =~ [[:space:]] ]]; then
  echo "FAIL: value contains <, > or whitespace — paste the bare key only"
  exit 1
fi

# Optional per-key validators: emit nothing on success, text on failure.
# Add new providers here; keep output key-free.
validate() {
  case "$NAME" in
    ZAI_API_KEY)
      local code
      code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VALUE" \
        -H "Accept: application/json" "https://api.z.ai/api/monitor/usage/quota/limit")
      [ "$code" = "200" ] || { echo "FAIL: z.ai answered HTTP $code (want 200)"; return 1; }
      ;;
    OPENROUTER_API_KEY)
      local code
      code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $VALUE" \
        "https://openrouter.ai/api/v1/key")
      [ "$code" = "200" ] || { echo "FAIL: openrouter answered HTTP $code (want 200)"; return 1; }
      ;;
    *) echo "note: no validator for ${NAME} — storing unvalidated" ;;
  esac
}

validate

security add-generic-password -s "$SERVICE" -a "$NAME" -w "$VALUE" -U
echo "PASS: ${NAME} stored in keychain '${SERVICE}' (validated, agent-blind)"
