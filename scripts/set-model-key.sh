#!/usr/bin/env bash
# Securely configure MODEL_API_KEY for MetaOps AI.
# - Reads the key from the terminal with echo disabled (never from argv,
#   never from a file argument, never printed back).
# - Writes it to the repo-root .env (gitignored), chmod 600.
# - Also generates METAOPS_SECRET if missing.
# - Prints only a masked confirmation (whether set + length), never the key.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

# Safety: .env must be gitignored before we write any secret into it.
if ! grep -qx '.env' "$REPO_ROOT/.gitignore"; then
  echo "ABORT: .env is not listed in .gitignore — refusing to write a secret." >&2
  exit 1
fi
if git -C "$REPO_ROOT" ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "ABORT: .env is tracked by git — remove it from the index first." >&2
  exit 1
fi

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Generate the app secret if absent (used for session tokens + token encryption).
if ! grep -q '^METAOPS_SECRET=' "$ENV_FILE"; then
  SECRET="$(openssl rand -hex 32)"
  printf 'METAOPS_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
  echo "METAOPS_SECRET generated and stored in .env (value not shown)."
fi

printf 'Paste your Meta Model API key (input hidden), then Enter: ' > /dev/tty
stty -echo < /dev/tty
IFS= read -r KEY < /dev/tty
stty echo < /dev/tty
printf '\n' > /dev/tty

if [ -z "${KEY:-}" ]; then
  echo "No key entered — nothing changed." >&2
  exit 1
fi

# Replace or append the MODEL_API_KEY line without ever echoing the value.
TMP="$(mktemp)"
grep -v '^MODEL_API_KEY=' "$ENV_FILE" > "$TMP" || true
printf 'MODEL_API_KEY=%s\n' "$KEY" >> "$TMP"
mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset KEY

LEN="$(grep '^MODEL_API_KEY=' "$ENV_FILE" | sed 's/^MODEL_API_KEY=//' | tr -d '\n' | wc -c)"
echo "MODEL_API_KEY configured in .env (length: ${LEN} chars; value never displayed or logged)."
echo "Verify with:  npm run build -w @metaops/server && node apps/server/dist/index.js  then  curl localhost:8790/health  -> aiConfigured:true"
