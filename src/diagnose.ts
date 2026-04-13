#!/usr/bin/env node
/**
 * diagnose.ts — 扫描转换后的 Markdown 目录，输出质量问题报告
 *
 * 用法:
 *   npx tsx src/diagnose.ts <output-dir> [--verbose]
 *
 * 检测项:
 *   [BLANK]   连续空行超过2行（div堆叠噪音）
 *   [ESCAPE]  残留反斜杠转义 \# \* \[ 等
 *   [HR]      连续下划线/等号分割线（未被转换的 <hr> 替代物）
 *   [NBSP]    残留 &nbsp; 实体
 *   [ZWSP]    零宽字符残留
 *   [MISSING] missing attachment 占位符
 *   [ENCRYPT] encrypted content 占位符
 *   [MATH]    LaTeX 数学公式（提示，非错误）
 *   [EMPTY]   正文内容为空（只有 frontmatter）
 *   [YAML]    frontmatter 疑似格式问题（未闭合 ---）
 *   [RAWHTML] 残留 HTML 标签
 *   [DUPBLANK] 文件中空行占比超过40%（整体噪音过多）
 */

import fs from "fs";
import * as path from "path";

interface Issue {
  type: string;
  line?: number;
  detail: string;
}

interface FileReport {
  file: string;
  issues: Issue[];
}

const CHECKS: Array<{
  type: string;
  test: (line: string, idx: number, lines: string[]) => Issue | null;
}> = [
  {
    type: "ESCAPE",
    test: (line, idx) => {
      // \[ 和 \] 是 Markdown 合法转义（防止被解析为链接），不报
      // 只报 \# \* \_ \` \> 这类通常不必要的转义
      const m = line.match(/\\([#*_`>])/);
      if (m) return { type: "ESCAPE", line: idx + 1, detail: `残留转义: ${m[0]}` };
      return null;
    },
  },
  {
    type: "HR",
    test: (line, idx) => {
      if (/^[_=]{4,}\s*$/.test(line.trim()))
        return { type: "HR", line: idx + 1, detail: "未转换的分割线: " + line.trim().slice(0, 20) };
      return null;
    },
  },
  {
    type: "NBSP",
    test: (line, idx) => {
      if (line.includes("&nbsp;"))
        return { type: "NBSP", line: idx + 1, detail: "&nbsp; 实体残留" };
      return null;
    },
  },
  {
    type: "ZWSP",
    test: (line, idx) => {
      if (/[\u200b\u200c\u200d\u00ad\ufeff]/.test(line))
        return { type: "ZWSP", line: idx + 1, detail: "零宽/不可见字符残留" };
      return null;
    },
  },
  {
    type: "MISSING",
    test: (line, idx) => {
      if (line.includes("[missing attachment:"))
        return { type: "MISSING", line: idx + 1, detail: line.trim().slice(0, 60) };
      return null;
    },
  },
  {
    type: "ENCRYPT",
    test: (line, idx) => {
      if (line.includes("[encrypted content]"))
        return { type: "ENCRYPT", line: idx + 1, detail: "加密内容占位符" };
      return null;
    },
  },
  {
    type: "RAWHTML",
    test: (line, idx) => {
      // 排除代码块、图片、链接
      const stripped = line.replace(/`[^`]+`/g, "").replace(/!\[.*?\]\(.*?\)/g, "");
      const m = stripped.match(/<\/?(?!img|a\s|br|hr)[a-zA-Z][^>]{0,40}>/);
      if (m) return { type: "RAWHTML", line: idx + 1, detail: `残留HTML: ${m[0]}` };
      return null;
    },
  },
];

function diagnoseFile(filePath: string): FileReport {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const issues: Issue[] = [];

  // YAML frontmatter 检查
  if (lines[0]?.trim() === "---") {
    const closeIdx = lines.slice(1).findIndex((l) => l.trim() === "---");
    if (closeIdx === -1) {
      issues.push({ type: "YAML", detail: "frontmatter 未找到闭合 ---" });
    }
  }

  // 正文内容为空检查
  const fmEnd = lines.slice(1).findIndex((l) => l.trim() === "---");
  const bodyStart = fmEnd >= 0 ? fmEnd + 2 : 0;
  const body = lines.slice(bodyStart).join("\n").trim();
  if (body.length === 0) {
    issues.push({ type: "EMPTY", detail: "正文内容为空" });
  }

  // 连续空行检查（超过2行）
  let blankRun = 0;
  let blankReported = false;
  let totalBlank = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      blankRun++;
      totalBlank++;
      if (blankRun > 3 && !blankReported) {
        issues.push({ type: "BLANK", line: i + 1, detail: `连续空行 ${blankRun}+ 行` });
        blankReported = true;
      }
    } else {
      blankRun = 0;
      blankReported = false;
    }
  }

  // 空行占比
  const bodyLines = lines.length - bodyStart;
  if (bodyLines > 10 && totalBlank / bodyLines > 0.4) {
    issues.push({
      type: "DUPBLANK",
      detail: `空行占比 ${Math.round((totalBlank / bodyLines) * 100)}%，内容噪音较多`,
    });
  }

  // 逐行检查（跳过代码块）
  let inCodeBlock = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    for (const check of CHECKS) {
      const issue = check.test(line, i, lines);
      if (issue) {
        issues.push(issue);
        break; // 每行只报一个问题，避免刷屏
      }
    }
  }

  return { file: filePath, issues };
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const dir = args.find((a) => !a.startsWith("-"));

  if (!dir) {
    console.error("Usage: npx tsx src/diagnose.ts <output-dir> [--verbose]");
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));

  console.log(`扫描 ${files.length} 个文件...\n`);

  const reports: FileReport[] = [];
  for (const f of files) {
    const r = diagnoseFile(f);
    if (r.issues.length > 0) reports.push(r);
  }

  // 汇总统计
  const counts: Record<string, number> = {};
  for (const r of reports) {
    for (const issue of r.issues) {
      counts[issue.type] = (counts[issue.type] ?? 0) + 1;
    }
  }

  console.log("=== 问题类型汇总 ===");
  for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const desc: Record<string, string> = {
      BLANK:   "连续多余空行（div噪音）",
      DUPBLANK:"空行占比过高",
      ESCAPE:  "残留反斜杠转义",
      HR:      "未转换的分割线",
      NBSP:    "&nbsp; 实体残留",
      ZWSP:    "零宽字符残留",
      MISSING: "附件丢失占位符",
      ENCRYPT: "加密内容占位符",
      RAWHTML: "残留HTML标签",
      EMPTY:   "正文为空",
      YAML:    "YAML格式问题",
    };
    console.log(`  [${type}] ${count} 处  —  ${desc[type] ?? ""}`);
  }

  console.log(`\n共 ${reports.length}/${files.length} 个文件有问题\n`);

  if (verbose) {
    console.log("=== 详细报告 ===");
    for (const r of reports) {
      console.log(`\n📄 ${path.basename(r.file)}`);
      for (const issue of r.issues) {
        const loc = issue.line ? `:${issue.line}` : "";
        console.log(`   [${issue.type}]${loc} ${issue.detail}`);
      }
    }
  } else {
    console.log("加 --verbose 查看每个文件的详细问题");
  }
}

main();
