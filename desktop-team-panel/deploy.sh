#!/bin/bash
set -euo pipefail
# Downloads only this repository's Desktop extension bundle. No credentials copied.
herdr_destination="${HERDR_DEPLOY_DIR:-$HOME/Documents/Herdr Team Panel}"
herdr_project="${1:-}"
herdr_download="$(mktemp -d "${TMPDIR:-/tmp}/herdr-bundle.XXXXXXXX")"
trap 'rm -rf "$herdr_download"' EXIT
/usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  'https://codeload.github.com/virus11456/herdr/zip/refs/heads/codex/desktop-team-panel' \
  -o "$herdr_download/bundle.zip"
/usr/bin/ditto -x -k "$herdr_download/bundle.zip" "$herdr_download/extracted"
herdr_source=''
for herdr_candidate in "$herdr_download"/extracted/*/desktop-team-panel; do
  if [[ -f "$herdr_candidate/快速部署.command" && -f "$herdr_candidate/team-runtime.test.mjs" ]]; then
    [[ -z "$herdr_source" ]] || { printf '壓縮包內有多個部署包，停止。\n' >&2; exit 1; }
    herdr_source="$herdr_candidate"
  fi
done
[[ -n "$herdr_source" ]] || { printf '下載內容不含部署包，停止。\n' >&2; exit 1; }
herdr_release="$herdr_destination/releases/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$herdr_release"
/usr/bin/ditto "$herdr_source" "$herdr_release"
printf '部署來源保存於：%s\n' "$herdr_release"
/bin/bash "$herdr_release/快速部署.command" "$herdr_project"
