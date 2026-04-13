#!/usr/bin/env node
import * as path from "path";
import { convertEnexToMarkdown } from "./enex2md.js";

function usage() {
  console.log(`
Usage: enex2md <input.enex> [output-dir] [options]

Arguments:
  input.enex    Path to the Evernote .enex export file
  output-dir    Output directory (default: <input-basename>/ next to the .enex file)

Options:
  -v, --verbose  Show detailed progress
  -h, --help     Show this help
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const verbose = args.includes("-v") || args.includes("--verbose");
const positional = args.filter((a) => !a.startsWith("-"));

const enexFile = positional[0];
if (!enexFile) {
  console.error("Error: input.enex is required");
  usage();
  process.exit(1);
}

const enexAbs = path.resolve(enexFile);
const defaultOut = path.join(path.dirname(enexAbs), path.basename(enexAbs, ".enex"));
const outputDir = positional[1] ? path.resolve(positional[1]) : defaultOut;

convertEnexToMarkdown(enexAbs, outputDir, { verbose }).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
