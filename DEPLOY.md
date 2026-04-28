# Deploying to Vercel

## Prerequisites
- vercel CLI: `npm i -g vercel`
- Upstash Redis account: https://console.upstash.com → create a Redis database → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
- Anthropic API key: https://console.anthropic.com/settings/keys

## One-time setup
```bash
cd <repo>
vercel login            # interactive
vercel link             # interactive: pick the github repo
```

## Set env vars
```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
```

## Deploy
```bash
vercel --prod
```

Capture the deployment URL. Update `mcp-from-spec/bin/cli.js` to use it as the default for `MCP_CURATOR_URL`.

## Smoke-test the deploy
```bash
curl -sN -X POST https://<your-deploy>.vercel.app/api/generate \
  -H "Content-Type: application/json" \
  -d '{"source":{"kind":"url","value":"https://petstore3.swagger.io/api/v3/openapi.json"},"apiKeyEnv":"API_KEY"}' \
  | head -20
```

You should see SSE `event: progress` lines, then `event: result`.
