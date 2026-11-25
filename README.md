# aso-keyword-gap-audit

Compare your tracked iOS app's stored US English App Store search footprint against one or more rivals using the [PeekPanda](https://peekpanda.com) keyword gap API (`GET /v1/aso/apps/{appId}/gap/{rivalStoreId}` and `GET /v1/aso/apps`).

- **Multi-rival consensus gaps**: find App Store searches where 2+ rivals already rank while your app is absent, ranked by rival count and best observed position.
- **Striking-distance head-to-heads**: highlight shared keywords where a top-20 rival beats you by 10 spots or fewer.
- **Your moat**: isolate queries observed only for your app across every compared rival.
- **Weekly diff**: compare against a saved snapshot (`--save` / `--prev`) to spot newly closed gaps, new rival entries, and rank swings.
- **Zero dependencies**: Node 18+ CLI + [interactive browser page](https://fdarkaou.github.io/aso-keyword-gap-audit/) running entirely client-side.

## Live browser tool

Open **[https://fdarkaou.github.io/aso-keyword-gap-audit/](https://fdarkaou.github.io/aso-keyword-gap-audit/)** and click **Load example data**, or paste one or more JSON answers from `GET /v1/aso/apps/{appId}/gap/{rivalStoreId}`. Nothing leaves your browser.

## Quick start (CLI)

### 1. Run against your PeekPanda tracked apps

```bash
export PEEKPANDA_TOKEN="your_api_token"

# Auto-detect your 'mine' app and all tracked competitor rivals from GET /v1/aso/apps
node cli.js --auto --max-rank 25 --save state/latest.json

# Or specify an app UUID and rival App Store IDs explicitly
node cli.js \
  --app 11111111-1111-4111-8111-111111111111 \
  --rivals 0000000001,0000000002 \
  --max-rank 25 \
  --min-rivals 2 \
  --ascii-only \
  --save state/latest.json
```

### 2. Weekly diff, CSV export, and Slack/Discord alerts

```bash
node cli.js \
  --auto \
  --max-rank 25 \
  --prev state/last-week.json \
  --save state/this-week.json \
  --webhook "$SLACK_OR_DISCORD_WEBHOOK_URL"

# Export CSV for spreadsheets
node cli.js --input state/this-week.json --max-rank 25 --format csv > gap.csv
```

### 3. Try offline with the bundled example data

```bash
node cli.js --input examples/run.json --prev examples/previous-run.json --max-rank 25
```

## Notes on the data

- iOS / App Store only, US English storefront.
- Both sides come from stored search snapshots (`GET /v1/aso/apps/{appId}/gap/{rivalStoreId}` never calls Apple).
- Positions are observed store search positions, never native App Store ranks or search volume.
- An empty bucket means those searches were not in the collected set for that app, not zero.
- API calls require a PeekPanda account (`context:read`) and count toward your plan's daily API and MCP allowance. See [Keyword gap](https://peekpanda.com/docs/keyword-gap), [Get ASO keyword gap](https://peekpanda.com/docs/get-aso-keyword-gap), and [Plans and refreshes](https://peekpanda.com/docs/plans-and-refreshes).

## Tests

```bash
npm test
```

## License

MIT
