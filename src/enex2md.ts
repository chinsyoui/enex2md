import fs from "fs";
import * as path from "path";
import sax from "sax";
import { enml2md } from "./enml2md.js";
import { md5Buffer, unwrapString } from "./utils.js";
import { cleanEnmlString } from "./clean.js";
import { prettyHtmlString } from "./pretty.js";

type NoteMeta = {
  title: string;
  created?: string;
  updated?: string;
  author?: string;
  source?: string;
  source_url?: string;
  tags?: string[];
};

type ResourceMeta = {
  hash: string;
  mime?: string;
  width?: number;
  height?: number;
  filename?: string;
};

type Note = {
  meta: NoteMeta;
  content: string;
};

type Resource = {
  meta: ResourceMeta;
  base64Data?: string;
  rawData: Buffer;
};

type EnexFile = {
  notes: Note[];
  resources: Resource[];
};

export async function parseEnexFile(enexFilePath: string): Promise<EnexFile> {
  return new Promise<EnexFile>((resolve, reject) => {
    const ef: EnexFile = { notes: [], resources: [] };
    const parser = sax.createStream(true, { trim: false });

    let currentElement = "";
    let currentNote: Note | null = null;
    let currentResource: Resource | null = null;

    parser.on("opentag", (node) => {
      currentElement = node.name;
      if (node.name === "note") {
        currentNote = { meta: { title: "", tags: [] }, content: "" };
      } else if (node.name === "resource") {
        currentResource = { meta: { hash: "" }, base64Data: "", rawData: Buffer.alloc(0) };
      }
    });

    parser.on("cdata", (cdata) => {
      if (currentNote && currentElement === "content") {
        currentNote.content += cdata;
      }
    });

    parser.on("text", (text) => {
      text = unwrapString(text);
      if (text.length === 0) return;

      if (!currentNote) return;

      switch (currentElement) {
        case "title":         currentNote.meta.title += text; break;
        case "created":       currentNote.meta.created = text; break;
        case "subject-date":  if (!currentNote.meta.created) currentNote.meta.created = text; break;
        case "updated":       currentNote.meta.updated = text; break;
        case "tag":           currentNote.meta.tags!.push(text); break;
        case "author":        currentNote.meta.author = text; break;
        case "source":        currentNote.meta.source = text; break;
        case "source-url":    currentNote.meta.source_url = text; break;
        case "mime":          currentResource!.meta.mime = text; break;
        case "width":         currentResource!.meta.width = parseInt(text, 10); break;
        case "height":        currentResource!.meta.height = parseInt(text, 10); break;
        case "file-name":     currentResource!.meta.filename = text; break;
        case "data":
          if (currentResource) currentResource.base64Data += text;
          break;
        default: break;
      }
    });

    parser.on("closetag", (name) => {
      if (name === "resource" && currentResource) {
        const rawData = Buffer.from(currentResource.base64Data!.trim(), "base64");
        currentResource.rawData = rawData;
        currentResource.meta.hash = md5Buffer(rawData);
        ef.resources.push(currentResource);
        currentResource = null;
      } else if (name === "note" && currentNote) {
        ef.notes.push(currentNote);
        currentNote = null;
      }
      currentElement = "";
    });

    parser.on("error", reject);
    parser.on("end", () => resolve(ef));

    fs.createReadStream(enexFilePath).pipe(parser);
  });
}

function mimeToExt(mime: string, filename?: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/bmp": ".bmp",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/amr": ".amr",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "text/plain": ".txt",
    "text/html": ".html",
  };
  if (map[mime]) return map[mime];
  // fallback: try to extract extension from original filename
  if (filename) {
    const ext = path.extname(filename);
    if (ext) return ext;
  }
  return ".bin";
}

/** Parse Evernote date string like "20221205T180417Z" into a Date */
function parseEnexDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  // Format: YYYYMMDDTHHmmssZ
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return undefined;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/** Escape a string value for safe use in YAML frontmatter */
function yamlEscape(value: string): string {
  // If value contains special chars, wrap in double quotes and escape internals
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function noteMeta2Frontmatter(meta: NoteMeta): string {
  let str = "---\n";
  if (meta.title) str += `title: ${yamlEscape(meta.title)}\n`;
  if (meta.author) str += `author: ${yamlEscape(meta.author)}\n`;
  if (meta.source) str += `source: ${yamlEscape(meta.source)}\n`;
  if (meta.source_url) str += `source_url: ${yamlEscape(meta.source_url)}\n`;
  if (meta.created) str += `created: ${meta.created}\n`;
  if (meta.updated && meta.updated !== meta.created) str += `updated: ${meta.updated}\n`;
  if (meta.tags && meta.tags.length > 0) {
    str += `tags:\n${meta.tags.map((t) => `  - ${yamlEscape(t)}`).join("\n")}\n`;
  }
  str += "---\n\n";
  return str;
}

export async function convertEnexToMarkdown(
  enexFilePath: string,
  outputDir: string,
  options: { verbose?: boolean } = {}
): Promise<void> {
  const log = options.verbose ? console.log : () => {};

  const attachmentsDir = path.join(outputDir, "attachments");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  log(`Parsing ${enexFilePath}...`);
  const ef = await parseEnexFile(enexFilePath);
  log(`Found ${ef.notes.length} notes, ${ef.resources.length} resources`);

  // Save attachments
  const attachments = new Map<string, string>();
  for (const res of ef.resources) {
    if (res.rawData.length === 0) continue;
    const ext = mimeToExt(res.meta.mime ?? "", res.meta.filename);
    const fileName = res.meta.filename || `${res.meta.hash}${ext}`;
    const absPath = path.join(attachmentsDir, fileName);
    fs.writeFileSync(absPath, res.rawData);
    const relativePath = path.relative(outputDir, absPath).replace(/\\/g, "/");
    attachments.set(res.meta.hash, relativePath);
    log(`  Saved attachment: ${fileName}`);
  }

  // Convert notes
  let successCount = 0;
  const usedNames = new Set<string>();

  for (const note of ef.notes) {
    try {
      const safeTitle = note.meta.title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 120);
      let baseName = safeTitle || `note_${Date.now()}`;

      // Deduplicate: append _2, _3, ... if name already used
      if (usedNames.has(baseName)) {
        let i = 2;
        while (usedNames.has(`${baseName}_${i}`)) i++;
        baseName = `${baseName}_${i}`;
      }
      usedNames.add(baseName);

      let enml = note.content;
      enml = cleanEnmlString(enml);
      enml = prettyHtmlString(enml, "  ");

      const markdown = enml2md(enml, attachments);
      const fullContent = noteMeta2Frontmatter(note.meta) + markdown;

      const mdPath = path.join(outputDir, baseName + ".md");
      fs.writeFileSync(mdPath, fullContent, "utf-8");

      // Set file timestamps to match note metadata
      const mtime = parseEnexDate(note.meta.updated) ?? parseEnexDate(note.meta.created);
      const atime = parseEnexDate(note.meta.created) ?? mtime;
      if (mtime && atime) {
        fs.utimesSync(mdPath, atime, mtime);
      }

      log(`  Saved note: ${baseName}.md`);
      successCount++;
    } catch (err) {
      console.error(`  Error converting note "${note.meta.title}": ${(err as Error).message}`);
    }
  }

  console.log(`Done: ${successCount}/${ef.notes.length} notes → ${outputDir}`);
}
