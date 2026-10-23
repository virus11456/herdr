#!/usr/bin/env python3
"""Install Google's Gemini CLI on a machine without Node.js.

Gemini CLI is a Node.js program (npm package @google/gemini-cli, Node >= 20).
When no suitable Node.js is on PATH, this script downloads the current LTS
release from nodejs.org, checks it against the published SHA-256 sums and
unpacks it into a private folder. It then installs Gemini CLI with that
Node's npm into another private folder and writes ~/.local/bin/gemini, a small
launcher that puts the private Node.js first on PATH. Nothing else on the
system is changed. Only the Python standard library is needed.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

NODE_DIST = "https://nodejs.org/dist"
PLATFORMS = {
    ("Darwin", "arm64"): "darwin-arm64",
    ("Darwin", "x86_64"): "darwin-x64",
    ("Linux", "x86_64"): "linux-x64",
    ("Linux", "aarch64"): "linux-arm64",
}
MIN_NODE_MAJOR = 20


def say(message: str) -> None:
    print(message, flush=True)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def node_major(node: str) -> int:
    try:
        done = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=20, check=False)
        return int(done.stdout.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def download(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=60) as response, open(target, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        last = -1
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total and (done * 100 // total) // 20 != last:
                last = (done * 100 // total) // 20
                say(f"  下載中 {done * 100 // total}%")


def install_node(share: Path, suffix: str) -> Path:
    """Download the current Node.js LTS into share/node and return its bin folder."""
    releases = json.loads(fetch(f"{NODE_DIST}/index.json"))
    release = next(item for item in releases if item.get("lts"))
    version = release["version"]
    name = f"node-{version}-{suffix}.tar.gz"
    say(f"下載 Node.js {version}（Gemini CLI 需要它，只裝在私人資料夾，不影響其他程式）…")
    sums = fetch(f"{NODE_DIST}/{version}/SHASUMS256.txt").decode()
    expected = next((line.split()[0] for line in sums.splitlines() if line.endswith(f"  {name}")), None)
    if not expected:
        raise SystemExit(f"找不到 {name} 的檢查碼，停止安裝。")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / name
        download(f"{NODE_DIST}/{version}/{name}", archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit("Node.js 下載檔驗證失敗（checksum 不符），已停止安裝。")
        say("  解壓縮 Node.js…")
        with tarfile.open(archive, "r:gz") as tar:
            if hasattr(tarfile, "data_filter"):  # Python 3.12+: refuse unsafe members
                tar.extractall(tmp, filter="data")
            else:
                tar.extractall(tmp)
        target = share / "node" / version
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(Path(tmp) / name[: -len(".tar.gz")]), str(target))
    current = share / "node" / "current"
    if current.is_symlink() or current.exists():
        current.unlink()
    current.symlink_to(target)
    for old in (share / "node").iterdir():
        if old.is_dir() and not old.is_symlink() and old.name != version:
            shutil.rmtree(old, ignore_errors=True)
    return current / "bin"


def main() -> int:
    key = (platform.system(), platform.machine())
    if key not in PLATFORMS:
        say(f"不支援這台電腦（{key[0]} {key[1]}）。")
        return 1
    home = Path.home()
    share = home / ".local" / "share" / "herdr-web"
    bin_dir = home / ".local" / "bin"

    system_node = shutil.which("node")
    if system_node and node_major(system_node) >= MIN_NODE_MAJOR:
        node_bin = Path(system_node).resolve().parent
        say(f"使用這台電腦已經有的 Node.js（{system_node}）。")
    else:
        node_bin = install_node(share, PLATFORMS[key])

    prefix = share / "gemini-cli"
    say("用 npm 安裝 Gemini CLI（大約一分鐘）…")
    env = dict(os.environ, PATH=f"{node_bin}{os.pathsep}{os.environ.get('PATH', '')}", NPM_CONFIG_UPDATE_NOTIFIER="false")
    npm = node_bin / "npm"
    done = subprocess.run(
        [str(npm), "install", "--global", "--prefix", str(prefix), "--no-fund", "--no-audit", "@google/gemini-cli@latest"],
        env=env,
        check=False,
    )
    gemini = prefix / "bin" / "gemini"
    if done.returncode != 0 or not gemini.exists():
        say("Gemini CLI 安裝失敗，請把上面的訊息截圖給協助你的人。")
        return 1

    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / "gemini"
    if launcher.is_symlink() or launcher.exists():
        launcher.unlink()
    launcher.write_text(
        "#!/bin/sh\n"
        "# Installed by herdr-web: runs Gemini CLI with its own Node.js.\n"
        f'PATH="{node_bin}:$PATH" exec "{gemini}" "$@"\n'
    )
    launcher.chmod(0o755)
    version = subprocess.run([str(launcher), "--version"], capture_output=True, text=True, timeout=60, check=False)

    say("")
    say(f"✅ Gemini CLI {version.stdout.strip()} 安裝完成：{launcher}")
    say("回到 herdr 控制台按「← 返回」，Gemini 卡片就會變成「可以開始」。第一次使用時要用 Google 帳號登入。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
