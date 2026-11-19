#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
herdr_team_folder="${1:-}"
if [[ -z "$herdr_team_folder" ]]; then
  herdr_team_folder=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "選擇要讓 Claude、Codex、MiniMax CN 協作的專案資料夾")')
fi
if [[ ! -d "$herdr_team_folder" ]]; then
  printf '找不到專案資料夾：%s\n' "$herdr_team_folder" >&2
  exit 1
fi
/usr/bin/open -a Herdr
export HERDR_TEAM_FOLDER="$herdr_team_folder"
herdr_team_json=$(/usr/bin/perl -MJSON::PP -e 'print encode_json({name=>"AI Team", tab=>"Claude - Team Lead", folder=>$ENV{HERDR_TEAM_FOLDER}, argv=>["$ENV{HOME}/.local/bin/herdr-team-lead"]})')
for attempt in {1..10}; do
  if "$HOME/.local/bin/herdr-app" status >/dev/null 2>&1; then
    exec "$HOME/.local/bin/herdr-app" do space.new "$herdr_team_json"
  fi
  sleep 1
done
printf 'Herdr 尚未就緒，請開啟 App 後再試一次。\n' >&2
exit 1
