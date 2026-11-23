import { readdir, readFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { createWriteStream } from "fs";

export interface Episode {
  id: string; // unique key (guests can have several episodes)
  guest: string;
  content: string;
  path: string;
  title?: string;
  date?: string;
  kind?: "podcast" | "newsletter";
}

// GitHub repository URL for transcripts
const GITHUB_URL =
  "https://github.com/ChatPRD/lennys-podcast-transcripts/archive/refs/heads/main.zip";

// Default paths
const DEFAULT_LOCAL_PATH =
  process.env.LENNY_TRANSCRIPTS_PATH || "./transcripts";

const HOSTED_TRANSCRIPTS_PATH = "./transcripts";

// Determine which path to use
function getTranscriptsPath(): string {
  if (process.env.MCP_MODE === "sse") {
    return HOSTED_TRANSCRIPTS_PATH;
  }
  return DEFAULT_LOCAL_PATH;
}

// Strip YAML frontmatter from markdown content
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 3).trim();
}

// Extract guest name from YAML frontmatter
function extractGuestFromFrontmatter(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return null;
  const match = content.slice(0, endIdx).match(/^guest:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

// Convert folder name to guest name as fallback
// e.g., "elena-verna-20" → "Elena Verna"
function folderToGuest(folder: string): string {
  return folder
    .replace(/[-_]\d+$/, "") // Remove trailing numbers like "-20"
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Download transcripts from GitHub (for hosted mode)
export async function downloadTranscripts(): Promise<void> {
  const targetPath = HOSTED_TRANSCRIPTS_PATH;

  // Check if transcripts already exist
  try {
    await access(targetPath);
    const entries = await readdir(targetPath, { withFileTypes: true });
    const episodeDirs = entries.filter((e) => e.isDirectory());
    if (episodeDirs.length > 100) {
      console.error(
        `Transcripts already exist at ${targetPath} (${episodeDirs.length} episodes)`
      );
      return;
    }
  } catch {
    // Directory doesn't exist, we need to download
  }

  console.error("Downloading transcripts from GitHub...");

  try {
    // Create target directory
    await mkdir(targetPath, { recursive: true });

    // Download the zip file
    const response = await fetch(GITHUB_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "lenny-mcp/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const zipPath = "/tmp/lenny-transcripts.zip";
    const fileStream = createWriteStream(zipPath);

    // Write response to file
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      receivedBytes += value.length;
      if (receivedBytes % (1024 * 1024) === 0) {
        console.error(`Downloaded ${Math.round(receivedBytes / 1024 / 1024)}MB...`);
      }
    }
    fileStream.end();

    console.error(`Download complete (${Math.round(receivedBytes / 1024 / 1024)}MB)`);

    // Extract the zip file using unzip command (simpler and more reliable)
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    console.error("Extracting transcripts...");
    const tempExtractPath = "/tmp/lenny-extract";

    // Clean up any previous extraction attempt
    try {
      await execAsync(`rm -rf "${tempExtractPath}"`);
    } catch {
      // Ignore if doesn't exist
    }

    // Extract to temp directory (preserves folder structure)
    await execAsync(`unzip -o "${zipPath}" -d "${tempExtractPath}"`);

    // GitHub zips extract to: lennys-podcast-transcripts-main/episodes/{guest}/transcript.md
    const extractedEpisodesPath = `${tempExtractPath}/lennys-podcast-transcripts-main/episodes`;

    // Move episode folders to target path
    await execAsync(`cp -r "${extractedEpisodesPath}"/* "${targetPath}/"`);

    // Clean up temp files
    try {
      await execAsync(`rm -rf "${tempExtractPath}" "${zipPath}"`);
    } catch {
      // Ignore cleanup errors
    }

    // Verify extraction by counting episode directories
    const entries = await readdir(targetPath, { withFileTypes: true });
    const episodeDirs = entries.filter((e) => e.isDirectory());
    if (episodeDirs.length < 50) {
      throw new Error(`Only found ${episodeDirs.length} episodes, expected 300+`);
    }
    console.error(`Extracted ${episodeDirs.length} episode transcripts`);
  } catch (error) {
    console.error("Error downloading transcripts:", error);
    throw error;
  }
}

function frontmatterField(content: string, field: string): string | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return null;
  const m = content.slice(0, endIdx).match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// One root may use either layout:
//  - ChatPRD archive:  <root>/episodes/<guest>/transcript.md  (or <root>/<guest>/transcript.md)
//  - Lenny's official data: <root>/podcasts/*.md and <root>/newsletters/*.md
async function loadRoot(root: string): Promise<Episode[]> {
  const out: Episode[] = [];
  const flatDirs: Array<["podcast" | "newsletter", string]> = [
    ["podcast", join(root, "podcasts")],
    ["newsletter", join(root, "newsletters")],
  ];
  if (await exists(flatDirs[0][1])) {
    for (const [kind, dir] of flatDirs) {
      if (!(await exists(dir))) continue;
      for (const f of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
        const path = join(dir, f);
        const raw = await readFile(path, "utf-8");
        const title = frontmatterField(raw, "title") || f.replace(/\.md$/, "");
        const guest = kind === "podcast"
          ? frontmatterField(raw, "guest") || folderToGuest(f.replace(/\.md$/, ""))
          : `Newsletter: ${title}`;
        out.push({ id: `${kind}:${f}`, guest, title, date: frontmatterField(raw, "date") || undefined,
          kind, content: stripFrontmatter(raw), path });
      }
    }
    return out;
  }
  const base = (await exists(join(root, "episodes"))) ? join(root, "episodes") : root;
  for (const d of (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const path = join(base, d.name, "transcript.md");
    try {
      const raw = await readFile(path, "utf-8");
      out.push({ id: `podcast:${d.name}`, guest: extractGuestFromFrontmatter(raw) || folderToGuest(d.name),
        title: frontmatterField(raw, "title") || undefined,
        date: frontmatterField(raw, "publish_date") || frontmatterField(raw, "date") || undefined,
        kind: "podcast", content: stripFrontmatter(raw), path });
    } catch { /* not an episode folder */ }
  }
  return out;
}

// LENNY_TRANSCRIPTS_PATH may list several roots separated by ":".
// Later roots win on duplicates (same guest + same opening text), so put the freshest source last.
export async function loadTranscripts(): Promise<Episode[]> {
  const roots = getTranscriptsPath().split(":").filter(Boolean);
  const byKey = new Map<string, Episode>();
  for (const root of roots) {
    const eps = await loadRoot(root);
    console.error(`Loaded ${eps.length} items from ${root}`);
    for (const e of eps) {
      const key = e.kind === "newsletter"
        ? e.id
        : e.guest.toLowerCase().replace(/[^a-z]/g, "") + "|" +
          e.content.slice(0, 400).toLowerCase().replace(/[^a-z]/g, "").slice(0, 120);
      byKey.set(key, e);
    }
  }
  // Disambiguate guests with several episodes so get_episode can reach each one.
  const all = [...byKey.values()];
  const counts = new Map<string, number>();
  for (const e of all) counts.set(e.guest, (counts.get(e.guest) || 0) + 1);
  for (const e of all) {
    if ((counts.get(e.guest) || 0) > 1 && e.date) e.guest = `${e.guest} (${e.date.slice(0, 10)})`;
  }
  console.error(`Loaded ${all.length} unique items in total.`);
  return all;
}

// Extract a snippet around a match position
export function extractSnippet(
  content: string,
  searchTerms: string[],
  snippetLength: number = 500
): string {
  const lowerContent = content.toLowerCase();

  // Find the first occurrence of any search term
  let bestPosition = -1;
  for (const term of searchTerms) {
    const pos = lowerContent.indexOf(term.toLowerCase());
    if (pos !== -1 && (bestPosition === -1 || pos < bestPosition)) {
      bestPosition = pos;
    }
  }

  if (bestPosition === -1) {
    // No match found, return the beginning (skip first ~2000 chars which are usually ads)
    const startAfterAds = Math.min(2000, content.length);
    return content.slice(startAfterAds, startAfterAds + snippetLength) + "...";
  }

  // Extract snippet centered around the match
  const halfLength = Math.floor(snippetLength / 2);
  const start = Math.max(0, bestPosition - halfLength);
  const end = Math.min(content.length, bestPosition + halfLength);

  let snippet = content.slice(start, end);

  // Try to start at a sentence/paragraph boundary
  if (start > 0) {
    const newlinePos = snippet.indexOf("\n");
    if (newlinePos !== -1 && newlinePos < 100) {
      snippet = snippet.slice(newlinePos + 1);
    }
    snippet = "..." + snippet;
  }

  if (end < content.length) {
    snippet = snippet + "...";
  }

  return snippet.trim();
}

// Parse timestamp from transcript line (e.g., "Lenny (00:03:42):" -> "00:03:42")
export function extractTimestamp(text: string): string | null {
  const match = text.match(/\((\d{2}:\d{2}:\d{2})\)/);
  return match ? match[1] : null;
}
