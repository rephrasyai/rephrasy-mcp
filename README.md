# Rephrasy MCP Server

Use [Rephrasy](https://rephrasy.ai) from Claude, Cursor, or any MCP client: humanize AI-generated text and check AI-detection scores without leaving your editor or agent workflow.

Two tools, one API key:

| Tool | What it does |
|---|---|
| `humanize` | Rewrites AI-generated text in a natural, human style while preserving meaning |
| `detect` | Scores how likely a text is to be flagged as AI-written (overall + optional per-sentence) |

## Setup

**1. Get an API key** — sign in at [rephrasy.ai](https://rephrasy.ai) → Account → API. Both tools bill against your Rephrasy plan.

**2. Add the server to your client:**

### Claude Code

```bash
claude mcp add rephrasy -e REPHRASY_API_KEY=<your-key> -- npx -y rephrasy-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "rephrasy": {
      "command": "npx",
      "args": ["-y", "rephrasy-mcp"],
      "env": { "REPHRASY_API_KEY": "<your-key>" }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "rephrasy": {
      "command": "npx",
      "args": ["-y", "rephrasy-mcp"],
      "env": { "REPHRASY_API_KEY": "<your-key>" }
    }
  }
}
```

> Until the package is on npm you can run it straight from GitHub: replace `"args": ["-y", "rephrasy-mcp"]` with `"args": ["-y", "github:grumpyp/rephrasy-mcp"]`.

## Tools

### `humanize`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The text to humanize |
| `model` | string | no | Rephrasy model, default `"v3"` |
| `style` | string | no | Writing-style ID from your account to mimic a specific voice |
| `language` | string | no | Output language hint (e.g. `"en"`, `"de"`); defaults to input language |

Returns the rewritten text plus the number of words charged.

### `detect`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The text to score (max 15,000 characters) |
| `per_sentence` | boolean | no | If `true`, also returns a score per sentence |

Returns JSON with `scores.overall` (lower = more human-like) and, in per-sentence mode, `sentences`.

## Example prompts

- *"Humanize this paragraph, then run detect on the result to verify it."*
- *"Rewrite my draft with the humanize tool using my writing style `<style-id>`."*
- *"Check which sentences of this post read as AI-written."*

## Development

```bash
npm install
npm run build
REPHRASY_API_KEY=<key> node dist/index.js   # runs on stdio
```

## License

MIT © Rephrasy
