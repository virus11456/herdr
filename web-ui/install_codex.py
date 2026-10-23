#!/usr/bin/env python3
"""Install OpenAI's Codex CLI without Node.js.

The @openai/codex npm package ships its native binary in per-platform packages
(for example @openai/codex@<version>-darwin-arm64). This script downloads that
package straight from the npm registry, checks its published SHA-512 integrity,
unpacks the vendored binary under ~/.local/share/codex-cli and links
~/.local/bin/codex to it. It needs only the Python standard library.
"""

from __future__ import annotations

import base64
import hashlib
import json
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REGISTRY = "https://registry.npmjs.org/@openai/codex"
PLATFORMS = {
    ("Darwin", "arm64"): ("darwin-arm64", "aarch64-apple-darwin"),
    ("Darwin", "x86_64"): ("darwin-x64", "x86_64-apple-darwin"),
    ("Linux", "x86_64"): ("linux-x64", "x86_64-unknown-linux-musl"),
    ("Linux", "aarch64"): ("linux-arm64", "aarch64-unknown-linux-musl"),
}


def say(message: str) -> None:
    print(message, flush=True)


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


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
            if total:
                percent = done * 100 // total
                if percent // 10 != last:
                    last = percent // 10
                    say(f"  下載中 {percent}%（{done >> 20} / {total >> 20} MB）")


def check_integrity(path: Path, integrity: str) -> None:
    algorithm, _, expected = integrity.partition("-")
    if algorithm != "sha512" or not expected:
        raise SystemExit(f"unexpected integrity format: {integrity}")
    digest = hashlib.sha512()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    if base64.b64encode(digest.digest()).decode() != expected:
        raise SystemExit("下載的檔案驗證失敗（checksum 不符），已停止安裝。")


def extract_vendor(archive: Path, triple: str, destination: Path) -> None:
    prefix = f"package/vendor/{triple}/"
    with tarfile.open(archive, "r:gz") as tar:
        members = []
        for member in tar.getmembers():
            if not member.name.startswith(prefix) or not (member.isfile() or member.isdir()):
                continue
            relative = member.name[len(prefix) :]
            parts = Path(relative).parts
            if not relative or relative.startswith("/") or ".." in parts:
                continue
            member.name = relative
            members.append(member)
        if not members:
            raise SystemExit(f"這個版本沒有 {triple} 的執行檔。")
        destination.mkdir(parents=True, exist_ok=True)
        for member in members:
            if hasattr(tarfile, "data_filter"):  # Python 3.12+: refuse unsafe members
                tar.extract(member, destination, filter="data")
            else:
                tar.extract(member, destination)


def main() -> int:
    key = (platform.system(), platform.machine())
    if key not in PLATFORMS:
        say(f"不支援這台電腦（{key[0]} {key[1]}）。")
        return 1
    suffix, triple = PLATFORMS[key]
    home = Path.home()
    share = home / ".local" / "share" / "codex-cli"
    bin_dir = home / ".local" / "bin"

    say("正在查詢 Codex 最新版本…")
    version = fetch_json(f"{REGISTRY}/latest")["version"]
    meta = fetch_json(f"{REGISTRY}/{version}-{suffix}")
    tarball, integrity = meta["dist"]["tarball"], meta["dist"]["integrity"]
    say(f"安裝 Codex {version}（{suffix}）")

    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "codex.tgz"
        download(tarball, archive)
        say("  驗證檔案…")
        check_integrity(archive, integrity)
        say("  解壓縮…")
        staging = Path(tmp) / "staging"
        extract_vendor(archive, triple, staging)
        target = share / version
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(target))

    binary = target / "bin" / "codex"
    if not binary.is_file():
        say("安裝失敗：找不到 codex 執行檔。")
        return 1
    binary.chmod(0o755)
    bin_dir.mkdir(parents=True, exist_ok=True)
    link = bin_dir / "codex"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(binary)
    for old in share.iterdir():
        if old.is_dir() and old.name != version:
            shutil.rmtree(old, ignore_errors=True)

    say("")
    say(f"✅ Codex {version} 安裝完成：{link}")
    say("回到 herdr 控制台按「← 返回」，ChatGPT 卡片就會變成「可以開始」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
