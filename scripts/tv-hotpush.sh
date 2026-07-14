#!/bin/zsh
# Hot-push files to the installed webOS app WITHOUT ares-install --remove
# (which wipes login/localStorage). Claude-session pattern:
# existing files are not overwritable by scp → rm then scp (or scp .new && mv).
set -e
KEY="${TV_KEY:-$HOME/.ssh/tv_key}"
HOST="${TV_HOST:-prisoner@192.168.1.9}"
PORT="${TV_PORT:-9922}"
D=/media/developer/apps/usr/palm/services/io.stremio.patched.server
SSH=(ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa)
SCP=(scp -P "$PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa)

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <local-file> <remote-relpath-under-service>"
  echo "  e.g. $0 service/index.html www/index.html"
  exit 1
fi
LOCAL=$1
REMOTE_REL=$2
REMOTE="$D/$REMOTE_REL"
"${SSH[@]}" "$HOST" "rm -f '$REMOTE'"
"${SCP[@]}" "$LOCAL" "$HOST:$REMOTE"
echo "pushed $LOCAL -> $REMOTE"
