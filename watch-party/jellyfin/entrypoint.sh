#!/bin/sh
set -eu

plugin_dir="/config/plugins/Subtitle Extract_7.0.0.0"
configuration_dir="/config/plugins/configurations"

mkdir -p "$plugin_dir" "$configuration_dir"
cp -f /opt/subtitle-extract/Jellyfin.Plugin.SubtitleExtract.dll "$plugin_dir/"
cp -f /opt/subtitle-extract/meta.json "$plugin_dir/"
cp -f /opt/subtitle-extract/Jellyfin.Plugin.SubtitleExtract.xml "$configuration_dir/"

exec /jellyfin/jellyfin "$@"
