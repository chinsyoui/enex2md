import * as cheerio from "cheerio/slim";
import type { DataNode, Element, Node, NodeWithChildren } from "domhandler";
import { cleanEnmlString } from "./clean.js";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const PRE_TAGS = new Set(["pre", "textarea", "code"]);

function extractCdataContent($: cheerio.CheerioAPI, node: Node): string | undefined {
  let cdataContent: string | undefined;

  if (node.type === "cdata") {
    const textNode = (node as NodeWithChildren).firstChild!;
    cdataContent = (textNode as DataNode).data;
  } else if (node.type === "text" && (node as DataNode).data.startsWith("<![CDATA[")) {
    const m = (node as DataNode).data.match(/^<!\[CDATA\[(.*)]]>$/s);
    if (m) cdataContent = m[1];
  } else if (node.type === "comment" && (node as DataNode).data.startsWith("[CDATA[")) {
    const m = (node as DataNode).data.match(/^\[CDATA\[(.*)]]$/s);
    if (m) cdataContent = m[1];
  }

  if (cdataContent) {
    const looksLikeHTML = /<[^>]+>/.test(cdataContent.trim());
    if (looksLikeHTML) {
      const cleaned = cleanEnmlString(cdataContent);
      const final = prettyHtmlString(cleaned, "  ");
      return `<![CDATA[\n${final}]]>`;
    }
    return (node as DataNode).data;
  }
  return undefined;
}

function formatNode($: cheerio.CheerioAPI, node: Node, indent: string, depth: number): string {
  const cdataResult = extractCdataContent($, node);
  if (cdataResult !== undefined) return cdataResult;

  if (node.type === "text") {
    // 只折叠换行符及其周围的空白（HTML 源码排版缩进），保留行内空格序列
    // 这样 &nbsp; 转成的普通空格不会被吃掉
    const collapsed = (node as DataNode).data
      ?.replace(/[ \t]*\n[ \t]*/g, " ")  // 跨行空白 → 单空格
      .replace(/^\n+|\n+$/g, "")          // 首尾换行去掉
      .trimEnd();                          // 只 trim 尾部，保留行首空格
    return collapsed ? indent.repeat(depth) + collapsed + "\n" : "";
  }

  if (node.type === "comment") {
    return indent.repeat(depth) + `<!-- ${(node as DataNode).data?.trim()} -->\n`;
  }

  if (node.type === "tag") {
    const tag = (node as Element).name.toLowerCase();
    let htmlStr = indent.repeat(depth) + `<${tag}`;
    for (const [k, v] of Object.entries((node as Element).attribs || {})) {
      htmlStr += ` ${k}="${v}"`;
    }

    if (VOID_ELEMENTS.has(tag)) {
      return htmlStr + "/>\n";
    }

    htmlStr += ">\n";

    if (PRE_TAGS.has(tag)) {
      // pre/code 内容原样保留，不加缩进，避免破坏换行和空白语义
      const content = $((node as Element)).html() || "";
      htmlStr += content + "\n";
    } else {
      for (const child of (node as Element).children || []) {
        htmlStr += formatNode($, child, indent, depth + 1);
      }
    }

    htmlStr += indent.repeat(depth) + `</${tag}>\n`;
    return htmlStr;
  }

  return "";
}

export function prettyHtmlString(html: string, indent = "  "): string {
  const $ = cheerio.load(html, { xmlMode: true });
  let result = "";
  for (const child of $.root().children())
    result += formatNode($, child, indent, 0);
  return result;
}
