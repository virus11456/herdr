#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
herdr_bundle_dir="$(cd "$(dirname "$0")" && pwd)"
herdr_project="${1:-}"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf '此快速部署目前支援 Apple Silicon Mac；其他平台請交給 agent 依 README 調整。\n' >&2
  exit 1
fi
if [[ -n "$herdr_project" && ! -d "$herdr_project" ]]; then
  printf '找不到專案資料夾：%s\n' "$herdr_project" >&2
  exit 1
fi
herdr_stage="$(mktemp -d "${TMPDIR:-/tmp}/herdr-deploy.XXXXXXXX")"
trap 'rm -rf "$herdr_stage"' EXIT
official_installer() {
  local herdr_name="$1" herdr_url="$2" herdr_shell="$3"
  printf '安裝缺少的工具：%s\n' "$herdr_name"
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$herdr_url" -o "$herdr_stage/$herdr_name.sh"
  "$herdr_shell" "$herdr_stage/$herdr_name.sh"
}
if [[ ! -d /Applications/Herdr.app || ! -x "$HOME/.local/bin/herdr-app" || ! -x "$HOME/.local/bin/hc" ]]; then
  official_installer herdr https://releases.herdr.dev/app/install.sh /bin/sh
fi
if [[ ! -x "$HOME/.local/bin/claude" ]]; then
  official_installer claude https://claude.ai/install.sh /bin/bash
fi
if ! command -v codex >/dev/null 2>&1 && [[ ! -x /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex ]]; then
  official_installer codex https://chatgpt.com/codex/install.sh /bin/sh
fi
if [[ ! -x "$HOME/.minimax-code/bin/mcode" ]]; then
  official_installer minimax https://filecdn.minimax.chat/public/install.sh /bin/bash
fi
herdr_node="${HERDR_TEAM_NODE:-}"
if [[ -z "$herdr_node" ]]; then herdr_node="$(command -v node || true)"; fi
if [[ -z "$herdr_node" ]]; then herdr_node="$HOME/.minimax-code/runtime/node/bin/node"; fi
[[ -x "$herdr_node" ]] || { printf '找不到 Node.js，請由 agent 檢查 MiniMax 安裝結果。\n' >&2; exit 1; }
export HERDR_TEAM_NODE="$herdr_node"
printf '驗證部署包…\n'
"$herdr_node" --test "$herdr_bundle_dir/team-runtime.test.mjs"
/usr/bin/open /Applications/Herdr.app
herdr_ready=0
for herdr_attempt in {1..30}; do
  if [[ -f "$HOME/.config/herdr-app/AGENTS.md" ]] && "$HOME/.local/bin/herdr-app" status >/dev/null 2>&1; then herdr_ready=1; break; fi
  sleep 1
done
[[ "$herdr_ready" == 1 ]] || { printf '請完成 Herdr 首次啟動後，重新執行本檔；已安裝工具會沿用。\n' >&2; exit 1; }
if [[ -n "$herdr_project" ]]; then
  /usr/bin/perl "$herdr_bundle_dir/install-panel.pl" "$herdr_project"
else
  /usr/bin/perl "$herdr_bundle_dir/install-panel.pl"
fi
printf '\n設定與面板已安裝。Claude 預設 Opus 5.5，可在面板切換 Fable 5.2。\n'
printf '請在面板選專案後送出需求。新機仍需完成自己的 Claude、ChatGPT、MiniMax CN 登入與資料夾信任。\n'
printf '給協助設定的 agent：登入指令與驗收流程見 README.md；不要複製來源電腦的認證檔。\n'
