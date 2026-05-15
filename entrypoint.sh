#!/bin/sh
set -e

DATA_DIR="${FP_DATA_DIR:-/app}"

# Bootstrap config.json from the example if not present
if [ ! -f "${DATA_DIR}/config.json" ]; then
  echo "  ℹ No config.json found in ${DATA_DIR} — copying from config.example.json"
  cp /app/config.example.json "${DATA_DIR}/config.json"
fi

# Bootstrap data.json from the example if not present
if [ ! -f "${DATA_DIR}/data.json" ]; then
  echo "  ℹ No data.json found in ${DATA_DIR} — copying from data.example.json"
  cp /app/data.example.json "${DATA_DIR}/data.json"
fi

exec node /app/server.js
