#!/bin/sh
set -eu

export PORT=3001
export HOST=0.0.0.0
export STATIC_DIR=.
export DATA_DIR="${TMPDIR:-/tmp}/knowledge-space-data"

exec node server.mjs
