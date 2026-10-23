#!/bin/sh
# Start the herdr web dashboard on this computer and open it in the browser.
# Usage: ./web-ui/start.sh [extra herdr_web.py options, e.g. --port 9000]
set -eu

dir=$(cd "$(dirname "$0")" && pwd)

herdr_bin=$(command -v herdr 2>/dev/null || true)
if [ -z "$herdr_bin" ] && [ -x "$HOME/.local/bin/herdr" ]; then
    herdr_bin="$HOME/.local/bin/herdr"
fi
if [ -z "$herdr_bin" ]; then
    echo "找不到 herdr。請先安裝：curl -fsSL https://herdr.dev/install.sh | sh" >&2
    exit 1
fi

python_bin=$(command -v python3 2>/dev/null || true)
if [ -z "$python_bin" ]; then
    echo "找不到 python3。macOS 可執行 xcode-select --install，Linux 請用套件管理員安裝 python3。" >&2
    exit 1
fi

echo "herdr 控制台啟動中，按 Ctrl+C 結束（herdr 和裡面的 agent 會繼續執行）。"
exec "$python_bin" "$dir/herdr_web.py" --herdr-bin "$herdr_bin" --start-server --open "$@"
