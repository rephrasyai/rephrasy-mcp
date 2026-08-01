#!/usr/bin/env node
/**
 * Rephrasy MCP server.
 *
 * Exposes two tools against Rephrasy's public API:
 *   - humanize: rewrite AI-generated text in a natural, human style
 *   - detect:   score how likely a text is to be flagged as AI-written
 *
 * Both endpoints authenticate with the same per-user API key
 * (rephrasy.ai → Account → API), passed via REPHRASY_API_KEY.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HUMANIZER_URL = "https://v2-humanizer.rephrasy.ai/api/";
const DETECTOR_URL = "https://detector.rephrasy.ai/detect_api";
const TIMEOUT_MS = 110_000;
/** The detector backend truncates beyond this anyway; cap client-side for a clear error. */
const MAX_DETECT_CHARS = 15_000;

const apiKey = process.env.REPHRASY_API_KEY;
if (!apiKey) {
  console.error(
    "REPHRASY_API_KEY is not set.\n" +
      "Get an API key at https://rephrasy.ai (Account → API) and add it to your MCP client config, e.g.\n" +
      '  "env": { "REPHRASY_API_KEY": "<your-key>" }'
  );
  process.exit(1);
}

async function callRephrasy(url: string, body: Record<string, unknown>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(
        "Rephrasy request timed out after 110s. Try again with a shorter text."
      );
    }
    throw new Error(`Could not reach Rephrasy (${e?.message ?? e}). Check your network.`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // The detector returns 400 with "Invalid API Key" rather than 401/403, so match the body too.
    const looksLikeAuth =
      res.status === 401 || res.status === 403 || /invalid api key/i.test(detail);
    if (looksLikeAuth) {
      throw new Error(
        "Rephrasy rejected the API key. " +
          "Check REPHRASY_API_KEY in your MCP config — keys are managed at https://rephrasy.ai (Account → API)."
      );
    }
    if (res.status === 402) {
      throw new Error(
        "Your Rephrasy plan is out of credits/words. Upgrade or top up at https://rephrasy.ai."
      );
    }
    throw new Error(`Rephrasy API error (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

function errorResult(e: unknown) {
  return {
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

const server = new McpServer({ name: "rephrasy", version: "0.1.0" });

server.registerTool(
  "humanize",
  {
    title: "Humanize text",
    description:
      "Rewrite AI-generated text with Rephrasy so it reads in a natural, human style — " +
      "varying sentence rhythm, structure and word choice while preserving meaning. " +
      "Returns the rewritten text. Costs words/credits on the connected Rephrasy plan.",
    inputSchema: {
      text: z.string().min(1).describe("The text to humanize."),
      model: z
        .string()
        .default("v3")
        .describe('Rephrasy model to use. Default "v3" (current best).'),
      style: z
        .string()
        .optional()
        .describe(
          "Optional writing-style ID from your Rephrasy account to mimic a specific voice."
        ),
      language: z
        .string()
        .optional()
        .describe("Optional output language hint, e.g. \"en\", \"de\". Defaults to input language."),
    },
  },
  async ({ text, model, style, language }) => {
    try {
      const data = await callRephrasy(HUMANIZER_URL, {
        text,
        model,
        ...(style ? { style } : {}),
        ...(language ? { language } : {}),
        words: true,
      });
      const output = data?.output;
      if (typeof output !== "string" || !output) {
        throw new Error(`Unexpected response from Rephrasy: ${JSON.stringify(data).slice(0, 300)}`);
      }
      const costs =
        data?.costs?.total != null ? `\n\n[rephrasy] words charged: ${data.costs.total}` : "";
      return { content: [{ type: "text" as const, text: output + costs }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "detect",
  {
    title: "Detect AI-written text",
    description:
      "Score a text with Rephrasy's AI detector. Returns an overall AI-likelihood score " +
      "(lower = more human-like) and, optionally, per-sentence scores. " +
      "Useful to verify a draft before publishing. Max 15,000 characters.",
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(MAX_DETECT_CHARS, `Detector accepts at most ${MAX_DETECT_CHARS} characters.`)
        .describe("The text to score."),
      per_sentence: z
        .boolean()
        .default(false)
        .describe("If true, also return a score per sentence (\"depth\" mode)."),
    },
  },
  async ({ text, per_sentence }) => {
    try {
      const data = await callRephrasy(DETECTOR_URL, {
        text,
        mode: per_sentence ? "depth" : "",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("rephrasy-mcp running on stdio");
