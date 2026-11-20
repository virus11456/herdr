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
/usr/bin/open /Applications/Herdr.app
export HERDR_TEAM_FOLDER="$herdr_team_folder"
herdr_team_bundle="$(cd "$(dirname "$0")" && pwd)"
for attempt in {1..10}; do
  if "$HOME/.local/bin/herdr-app" status >/dev/null 2>&1; then
    if [[ -f "$herdr_team_bundle/install-panel.pl" ]]; then
      exec /usr/bin/perl "$herdr_team_bundle/install-panel.pl" "$herdr_team_folder"
    fi
    /usr/bin/perl -MJSON::PP -e '
      my $file="$ENV{HOME}/.config/herdr-app/team-chat.json";
      open my $out, ">", "$file.tmp-$$" or die $!;
      print {$out} encode_json({folder=>$ENV{HERDR_TEAM_FOLDER}, requestId=>time."-$$"});
      close $out or die $!; rename("$file.tmp-$$",$file) or die $!;
    '
    exec "$HOME/.local/bin/herdr-app" do layout.switch '{"name":"team-work"}'
  fi
  sleep 1
done
printf 'Herdr 尚未就緒，請開啟 App 後再試一次。\n' >&2
exit 1
