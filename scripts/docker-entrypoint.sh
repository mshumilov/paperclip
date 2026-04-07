#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
  chown -R node:node /paperclip
fi

# Cursor Agent CLI installer puts the binary on the mounted volume; expose it as `agent` on PATH
# for adapter runs (symlink in the image layer is lost when the container is recreated).
if [ -x /paperclip/.local/bin/agent ] && [ ! -e /usr/local/bin/agent ]; then
  ln -sf /paperclip/.local/bin/agent /usr/local/bin/agent || true
fi

exec gosu node "$@"
