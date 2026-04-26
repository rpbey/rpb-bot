#!/bin/sh
set -e

echo ">>> RPB Bot starting (Bun runtime)..."

# Handle Google Credentials from Env Var
if [ -n "$GOOGLE_SERVICE_ACCOUNT_JSON" ]; then
  echo "$GOOGLE_SERVICE_ACCOUNT_JSON" > /app/google-credentials.json
  export GOOGLE_APPLICATION_CREDENTIALS="/app/google-credentials.json"
fi

# Run database migrations
echo ">>> Running database migrations..."
./node_modules/.bin/prisma migrate deploy || echo ">>> WARNING: Migrations failed or not needed."

echo ">>> Starting Discord bot with Bun..."
exec bun bot/src/index.ts
