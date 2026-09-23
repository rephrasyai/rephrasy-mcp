#!/usr/bin/env node
/**
 * Rephrasy MCP server.
 *
 * Exposes these tools against Rephrasy's public APIs:
 *   - humanize:         rewrite AI-generated text in a natural, human style
 *   - detect:           score how likely a text is to be flagged as AI-written
 *   - humanize_image:   humanize a local or remote image, saved next to the original
 *   - get_image_result: collect an image that was still processing
 *
 * All endpoints authenticate with the same per-user API key
 * (rephrasy.ai → Account → API), passed via REPHRASY_API_KEY.
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HUMANIZER_URL = "https://v2-humanizer.rephrasy.ai/api/";
const DETECTOR_URL = "https://detector.rephrasy.ai/detect_api";
const TIMEOUT_MS = 110_000;
/** The detector backend truncates beyond this anyway; cap client-side for a clear error. */
const MAX_DETECT_CHARS = 15_000;
/**
 * Images go through the website's image API, the same one the web app uses:
 * it bills the tier, refunds a failed job and keeps the result for 72 hours.
 */
const IMAGE_API = (process.env.REPHRASY_WEB_URL ?? "https://www.rephrasy.ai") + "/api/image/humanize-job";
/** The image API sits behind Vercel, which refuses request bodies over ~4.5 MB. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** How long one call waits for a job; a standard image usually finishes inside this. */
const IMAGE_WAIT_MS = 50_000;

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

/** Whitespace-delimited word count, matching how the app reports words in/out. */
function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function errorResult(e: unknown) {
  return {
    content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
    isError: true,
  };
}

// --- images -------------------------------------------------------------------

/** File extension from the magic bytes, or null if it is not an image the API takes. */
function sniffImage(b: Uint8Array): ".png" | ".jpg" | ".webp" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  return null;
}

function expandPath(p: string): string {
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}

const TOO_LARGE = "The image is larger than 4 MB. Export it as JPEG or reduce the resolution.";

async function loadImage(path?: string, url?: string): Promise<{ bytes: Uint8Array; ext: string }> {
  if (!path === !url) throw new Error("Pass exactly one of path or url.");
  let bytes: Uint8Array;
  if (path) {
    try {
      bytes = await readFile(expandPath(path));
    } catch (e: any) {
      throw new Error(`Could not read ${path}: ${e?.code ?? e?.message ?? e}`);
    }
  } else {
    const res = await fetch(url!, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
      throw new Error(`Could not download ${url}: ${e?.message ?? e}`);
    });
    if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}).`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(TOO_LARGE);
  const ext = sniffImage(bytes);
  if (!ext) throw new Error("Only PNG, JPEG and WEBP images are supported.");
  return { bytes, ext };
}

/** A call to the website's image API, with its errors turned into plain sentences. */
async function imageApi(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(IMAGE_API + path, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new Error(`Could not reach Rephrasy (${e?.message ?? e}). Check your network.`);
  }
  if (res.ok) return res;
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(
      "Rephrasy rejected the API key. " +
        "Check REPHRASY_API_KEY in your MCP config — keys are managed at https://rephrasy.ai (Account → API)."
    );
  }
  if (res.status === 402) {
    throw new Error(
      `Not enough credits: this image needs ${body.needed}, the account has ${body.balance}. ` +
        "Top up at https://rephrasy.ai."
    );
  }
  if (res.status === 404) throw new Error("Unknown job_id for this account.");
  if (res.status === 413) throw new Error(TOO_LARGE);
  throw new Error(body.message || `Rephrasy image API error (HTTP ${res.status}).`);
}

type ImageJob = { status: string; tier?: string; queue_position?: number | null; refunded?: boolean };

async function imageStatus(jobId: string): Promise<ImageJob> {
  return (await imageApi(`/${encodeURIComponent(jobId)}`)).json() as Promise<ImageJob>;
}

async function waitForImage(jobId: string, ms: number): Promise<ImageJob> {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = await imageStatus(jobId);
    if (["done", "failed", "expired"].includes(job.status) || Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(0, deadline - Date.now()))));
  }
}

const RESULT_EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/webp": ".webp" };

/** Where each job's result goes, remembered for get_image_result within this session. */
const imageTargets = new Map<string, string>();

function defaultTarget(jobId: string, path?: string): string {
  if (path) {
    const src = expandPath(path);
    return join(dirname(src), `${basename(src, extname(src))}-humanized`);
  }
  return join(process.cwd(), `humanized-${jobId.slice(0, 8)}`);
}

/** Download a finished job and write it to disk; returns the path written. */
async function saveImage(jobId: string, target: string): Promise<string> {
  const res = await imageApi(`/${encodeURIComponent(jobId)}/image`);
  const type = (res.headers.get("content-type") ?? "image/png").split(";")[0];
  const ext = RESULT_EXT[type] ?? ".png";
  const out = extname(target) ? target : target + ext;
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/** The tool answer for a job in any state. */
async function imageAnswer(jobId: string, job: ImageJob) {
  let text: string;
  if (job.status === "done") {
    const out = await saveImage(jobId, imageTargets.get(jobId) ?? defaultTarget(jobId));
    text = `Done. Humanized image saved to ${out}`;
  } else if (job.status === "failed") {
    text = `The image could not be processed.${job.refunded ? " The credits were refunded." : ""}`;
  } else if (job.status === "expired") {
    text = "This result is no longer available (results are kept for 72 hours).";
  } else {
    const queue = job.queue_position != null ? `, queue position ${job.queue_position}` : "";
    text = `Still ${job.status}${queue}. Call get_image_result with job_id "${jobId}" to collect it.`;
  }
  return { content: [{ type: "text" as const, text: `${text}\n\n[rephrasy] job_id ${jobId}` }] };
}

const server = new McpServer({ name: "rephrasy", version: "0.3.0" });

server.registerTool(
  "humanize",
  {
    title: "Humanize text",
    description:
      "Rewrite AI-generated text with Rephrasy so it reads in a natural, human style — " +
      "varying sentence rhythm, structure and word choice while preserving meaning. " +
      "Returns the rewritten text. Costs words/credits on the connected Rephrasy plan.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      text: z.string().min(1).describe("The text to humanize."),
      model: z
        .string()
        .default("v4")
        .describe(
          'Rephrasy model to use. Default "v4" (recommended). ' +
            '"ft_clean-v3" retains meaning best and keeps the length almost identical — ' +
            'prefer it for technical text and anything with figures. ' +
            'Also available: "v3", "SEO Model", "Undetectable Model v2".'
        ),
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
      // Mirror the app's "words in / words out" readout, plus words charged.
      const wordsIn = countWords(text);
      const wordsOut = countWords(output);
      const charged =
        data?.costs?.total != null ? `, ${data.costs.total} words charged` : "";
      const meta = `\n\n[rephrasy] ${wordsIn} words in / ${wordsOut} words out${charged}`;
      return { content: [{ type: "text" as const, text: output + meta }] };
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

server.registerTool(
  "humanize_image",
  {
    title: "Humanize image",
    description:
      "Re-render an image with Rephrasy so it reads like an ordinary camera photo: a light " +
      "diffusion pass with natural photographic texture. Subject, composition and resolution " +
      "stay the same. Takes a local file or a URL (PNG, JPEG or WEBP, max 4 MB) and saves the " +
      "result next to the original as <name>-humanized.<ext>. Costs 10 credits on \"standard\", " +
      "20 on \"hq\"; a failed image is refunded.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().optional().describe("Local image file to humanize."),
      url: z.string().url().optional().describe("Or: an http(s) link to the image."),
      quality: z
        .enum(["standard", "hq"])
        .default("standard")
        .describe('"standard" usually finishes in under a minute; "hq" is higher fidelity and takes about 4 minutes.'),
      output_path: z
        .string()
        .optional()
        .describe("Where to save the result. Defaults to <name>-humanized.<ext> next to the input, or the working directory for a URL."),
    },
  },
  async ({ path, url, quality, output_path }) => {
    try {
      const { bytes, ext } = await loadImage(path, url);
      const form = new FormData();
      form.append("file", new Blob([bytes as BlobPart]), `image${ext}`);
      const res = await imageApi(`?tier=${quality}`, {
        method: "POST",
        headers: { "x-file-name": path ? basename(path) : `image${ext}` },
        body: form,
      });
      const { job_id: jobId } = (await res.json()) as { job_id?: string };
      if (!jobId) throw new Error("Rephrasy returned no job id.");
      imageTargets.set(jobId, output_path ? expandPath(output_path) : defaultTarget(jobId, path));
      const job = await waitForImage(jobId, quality === "standard" ? IMAGE_WAIT_MS : 5_000);
      return await imageAnswer(jobId, job);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "get_image_result",
  {
    title: "Get image result",
    description:
      "Collect an image from humanize_image that was still processing, and save it once it is " +
      "done. Waits up to about 50 seconds per call, so calling it again right away is fine. Free.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id that humanize_image returned."),
      output_path: z
        .string()
        .optional()
        .describe("Where to save the result; defaults to what humanize_image chose."),
    },
  },
  async ({ job_id, output_path }) => {
    try {
      if (output_path) imageTargets.set(job_id, expandPath(output_path));
      return await imageAnswer(job_id, await waitForImage(job_id, IMAGE_WAIT_MS));
    } catch (e) {
      return errorResult(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("rephrasy-mcp running on stdio");
