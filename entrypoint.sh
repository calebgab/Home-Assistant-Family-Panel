#!/bin/sh
set -e

# Bootstrap config.json from the example if no file has been mounted
if [ ! -f /app/config.json ]; then
  echo "  ℹ No config.json found — copying from config.example.json"
  cp /app/config.example.json /app/config.json
fi

# Bootstrap data.json from the example if no file has been mounted
if [ ! -f /app/data.json ]; then
  echo "  ℹ No data.json found — copying from data.example.json"
  cp /app/data.example.json /app/data.json
fi

exec node server.js
