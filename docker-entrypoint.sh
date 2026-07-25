#!/bin/sh

set -eu

if [ ! -f /app/data/webssh_config.json ]; then
  cp /app/defaults/webssh_config.json /app/data/webssh_config.json
fi

exec "$@"
