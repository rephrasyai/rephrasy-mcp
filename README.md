# Rephrasy MCP Server

[![npm](https://img.shields.io/npm/v/@rephrasy/mcp)](https://www.npmjs.com/package/@rephrasy/mcp)

Use [Rephrasy](https://rephrasy.ai) from Claude, Cursor, or any MCP client: humanize AI-generated text and images, and check AI-detection scores, without leaving your editor or agent workflow.

Four tools, one API key:

| Tool | What it does |
|---|---|
| `humanize` | Rewrites AI-generated text in a natural, human style while preserving meaning |
| `detect` | Scores how likely a text is to be flagged as AI-written (overall + optional per-sentence) |
| `humanize_image` | Humanizes a local or remote image and saves the result next to the original |
| `get_image_result` | Collects an image that was still processing (free) |

## Setup

**1. Get an API key** — sign in at [rephrasy.ai](https://rephrasy.ai) → Account → API. Both tools bill against your Rephrasy plan.

**2. Add the server to your client:**

### Claude Code

```bash
claude mcp add rephrasy -e REPHRASY_API_KEY=<your-key> -- npx -y @rephrasy/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "rephrasy": {
      "command": "npx",
      "args": ["-y", "@rephrasy/mcp"],
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
      "args": ["-y", "@rephrasy/mcp"],
      "env": { "REPHRASY_API_KEY": "<your-key>" }
    }
  }
}
```

> Until the package is on npm you can run it straight from GitHub: replace `"args": ["-y", "@rephrasy/mcp"]` with `"args": ["-y", "github:rephrasyai/rephrasy-mcp"]`.

### Hosted server (no install)

Rephrasy also runs a hosted MCP server, so clients that speak streamable HTTP need
nothing installed locally:

```bash
claude mcp add rephrasy https://v2-humanizer.rephrasy.ai/mcp -t http \
  -H "Authorization: Bearer <your-key>"
```

It supports OAuth as well — ChatGPT and other clients that require it discover it
from the server and send you through a one-time consent page, so the key never
reaches the client. The hosted server carries a wider tool set (engine
recommendations, readability, bring-your-own-key detectors). Full docs:
<https://rephrasy.ai/mcp>.

## Tools

### `humanize`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The text to humanize |
| `model` | string | no | Rephrasy model, default `"v4"` (recommended). See [Models](#models) |
| `style` | string | no | Writing-style ID from your account to mimic a specific voice |
| `language` | string | no | Output language hint (e.g. `"en"`, `"de"`); defaults to input language |

Returns the rewritten text plus the number of words charged.

#### Models

| `model` | When to use it |
|---|---|
| `v4` | **Default and recommended.** Natural rhythm and sentence variety, length close to the source. |
| `ft_clean-v3` | Highest meaning retention and near-identical length — technical writing and anything with figures. |
| `v3` | Voice-driven rewrite; pass `style` for a specific voice. |
| `SEO Model` | Simple, informal phrasing built around keywords. |
| `Undetectable Model v2` | Previous-generation model. |

### `detect`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The text to score (max 15,000 characters) |
| `per_sentence` | boolean | no | If `true`, also returns a score per sentence |

Returns JSON with `scores.overall` (lower = more human-like) and, in per-sentence mode, `sentences`.

### `humanize_image`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | one of | Local image file (PNG, JPEG or WEBP, max 4 MB) |
| `url` | string | one of | Or an http(s) link to the image |
| `quality` | string | no | `"standard"` (default, usually under a minute) or `"hq"` (about 4 minutes) |
| `output_path` | string | no | Where to save the result; defaults to `<name>-humanized.<ext>` next to the input |

A diffusion pass removes invisible AI watermarks such as SynthID while subject,
composition and resolution stay the same. Costs 10 credits on `standard` and 20
on `hq`; a failed image is refunded. Standard images are usually saved within the
call. If a job is still running, the tool returns a `job_id` instead.

### `get_image_result`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `job_id` | string | yes | The `job_id` from `humanize_image` |
| `output_path` | string | no | Where to save the result |

Waits up to about 50 seconds per call and saves the image once it is done. Results
stay available for 72 hours and also show up in your image history on rephrasy.ai.

## Example prompts

- *"Humanize this paragraph, then run detect on the result to verify it."*
- *"Rewrite my draft with the humanize tool using my writing style `<style-id>`."*
- *"Check which sentences of this post read as AI-written."*
- *"Humanize ~/Desktop/hero.png in hq and tell me where you saved it."*

## Development

```bash
npm install
npm run build
REPHRASY_API_KEY=<key> node dist/index.js   # runs on stdio
```

## License

MIT © Rephrasy
