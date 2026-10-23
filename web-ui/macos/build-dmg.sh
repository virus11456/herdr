#!/bin/sh
# Build "Herdr Web.app" and package it as a DMG.
#
# On macOS this uses hdiutil. On Linux it needs mkfs.hfsplus (hfsprogs) plus the
# hfsplus and dmg tools from libdmg-hfsplus, given as HFSPLUS_TOOL and DMG_TOOL.
#
# Usage: web-ui/macos/build-dmg.sh [output-dir]   (VERSION defaults to herdr_web.py's __version__)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
web_ui=$(cd "$here/.." && pwd)
out_dir=$(mkdir -p "${1:-$web_ui/dist}" && cd "${1:-$web_ui/dist}" && pwd)
version="${VERSION:-$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$web_ui/herdr_web.py")}"
app_name="Herdr Web"
volume_name="Herdr Web"
dmg_path="$out_dir/HerdrWeb-$version.dmg"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
app="$stage/$app_name.app"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/web-ui"
sed "s/@VERSION@/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp "$here/herdr-web" "$app/Contents/MacOS/herdr-web"
chmod 755 "$app/Contents/MacOS/herdr-web"
cp "$here/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cp "$web_ui/herdr_web.py" "$app/Contents/Resources/web-ui/"
cp -R "$web_ui/static" "$app/Contents/Resources/web-ui/static"
cp "$here/README.txt" "$stage/README.txt"

rm -f "$dmg_path"
if command -v hdiutil >/dev/null 2>&1; then
    ln -s /Applications "$stage/Applications"
    hdiutil create -quiet -volname "$volume_name" -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg_path"
else
    : "${HFSPLUS_TOOL:?set HFSPLUS_TOOL to the libdmg-hfsplus hfsplus binary}"
    : "${DMG_TOOL:?set DMG_TOOL to the libdmg-hfsplus dmg binary}"
    image="$stage.img"
    trap 'rm -rf "$stage" "$image"' EXIT
    dd if=/dev/zero of="$image" bs=1M count=16 2>/dev/null
    mkfs.hfsplus -v "$volume_name" "$image" >/dev/null
    "$HFSPLUS_TOOL" "$image" addall "$stage" >/dev/null
    "$HFSPLUS_TOOL" "$image" chmod 755 "/$app_name.app/Contents/MacOS/herdr-web" >/dev/null
    "$HFSPLUS_TOOL" "$image" symlink /Applications /Applications >/dev/null
    "$DMG_TOOL" "$image" "$dmg_path" >/dev/null
fi
echo "$dmg_path"
