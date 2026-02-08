#!/usr/bin/env sh
# Idempotent: ensure each entry in scripts/bin-symlinks.txt is symlinked from
# ~/.local/bin to this repo. Used by .githooks/post-merge and make install-dotfiles.

set -e
SCRIPT_DIR="${0%/*}"
REPO_ROOT="${REPO_ROOT:-$(git -C "${SCRIPT_DIR}/.." rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
fi
LIST="$REPO_ROOT/scripts/bin-symlinks.txt"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$BIN_DIR"
if [ ! -f "$LIST" ]; then
  echo "ensure-bin-symlinks: $LIST not found, skipping" >&2
  exit 0
fi

grep -v '^[[:space:]]*$' "$LIST" | grep -v '^[[:space:]]*#' | while IFS= read -r name; do
  name=$(echo "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$name" ] && continue
  source="$REPO_ROOT/$name"
  link="$BIN_DIR/$name"
  if [ ! -f "$source" ]; then
    echo "ensure-bin-symlinks: $source not found, skipping" >&2
    continue
  fi
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$source" ]; then
    continue
  fi
  ln -sf "$source" "$link"
  echo "Linked $link -> $source"
done
