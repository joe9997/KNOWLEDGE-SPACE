#!/bin/sh
set -eu

export NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'

npm ci --registry='https://registry.npmjs.org/'
npm run build

# 把 Express 服务端打成单文件，产物里不必再携带 node_modules
node_modules/.bin/esbuild server/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --outfile=dist/server.mjs \
  --banner:js="import{createRequire as __bannerRequire}from'node:module';const require=__bannerRequire(import.meta.url);"

cp run.sh dist/run.sh
chmod 755 dist/run.sh
