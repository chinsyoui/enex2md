import TurndownService from "turndown";
import * as gfmPlugin from "turndown-plugin-gfm";
import * as cheerio from "cheerio/slim";

function normalizeTables($: cheerio.CheerioAPI) {
  $("table").each((_, table) => {
    const $table = $(table);

    // 跳过嵌套表格（父节点是 td/th）
    if ($(table).parents("td, th").length > 0) return;

    // 跳过有 colspan/rowspan > 1 的复杂表格（Markdown 无法表达）
    const hasSpan = $table.find("td[colspan], th[colspan], td[rowspan], th[rowspan]").toArray()
      .some((el) => {
        const cs = parseInt($(el).attr("colspan") ?? "1", 10);
        const rs = parseInt($(el).attr("rowspan") ?? "1", 10);
        return cs > 1 || rs > 1;
      });
    if (hasSpan) return;

    if ($table.children("thead, tbody").length === 0) {
      $table.wrapInner("<tbody></tbody>");
    }

    $table.children("tr").each((_, tr) => {
      const $tbody = $table.children("tbody").first();
      if ($tbody.length) $tbody.append(tr);
    });

    $table.find("td, th").each((_, cell) => {
      const $cell = $(cell);
      if ($cell.parent().prop("tagName")?.toLowerCase() !== "tr") {
        const $tr = $("<tr></tr>");
        $cell.replaceWith($tr.append($cell));
        $table.children("tbody").append($tr);
      }
    });

    // 如果没有 thead，把第一行提升为 thead
    // GFM 表格插件需要 thead 才能生成分隔行
    if ($table.children("thead").length === 0) {
      const $tbody = $table.children("tbody").first();
      const $firstRow = $tbody.children("tr").first();
      if ($firstRow.length) {
        // 把 td 转成 th
        $firstRow.find("td").each((_, td) => {
          const $td = $(td);
          const $th = $("<th></th>").html($td.html() ?? "");
          $td.replaceWith($th);
        });
        const $thead = $("<thead></thead>").append($firstRow);
        $table.prepend($thead);
      }
    }
  });
}

function flattenTableCells($: cheerio.CheerioAPI) {
  // 只在单元格含块级元素时才 flatten，保留行内格式（<strong>、<a>、<code> 等）
  const BLOCK_TAGS = new Set(["div", "p", "ul", "ol", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"]);
  $("table td, table th").each((_, cell) => {
    const $cell = $(cell);
    const hasBlock = $cell.find("*").toArray().some(
      (el) => BLOCK_TAGS.has((el as any).name?.toLowerCase() ?? "")
    );
    if (hasBlock) {
      const text = $cell.text().trim();
      $cell.empty().text(text);
    }
  });
}

export function enml2md(rawEnml: string, attachments: Map<string, string>): string {
  const $ = cheerio.load(rawEnml, { xmlMode: false });
  flattenTableCells($);
  normalizeTables($);

  $("en-media").each((_, el) => {
    const hash = $(el).attr("hash")?.toLowerCase();
    const type = $(el).attr("type") || "";
    const filePath = hash ? attachments.get(hash) : undefined;

    if (!filePath) {
      $(el).replaceWith(`[missing attachment: ${hash}]`);
      return;
    }

    if (type.startsWith("image/")) {
      $(el).replaceWith(`<img src="${filePath}" alt="" />`);
    } else {
      $(el).replaceWith(`<a href="${filePath}">${filePath}</a>`);
    }
  });

  // en-todo → GFM task list checkbox
  $("en-todo").each((_, el) => {
    const checked = $(el).attr("checked") === "true";
    $(el).replaceWith(checked ? "☑ " : "☐ ");
  });

  // en-crypt → placeholder with warning
  $("en-crypt").each((_, el) => {
    $(el).replaceWith(`[encrypted content]`);
  });

  const turndownService = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    emDelimiter: "*",
    bulletListMarker: "-",
    linkStyle: "inlined",
    hr: "---",
  });

  turndownService.use(gfmPlugin.gfm);

  const originalEscape = turndownService.escape.bind(turndownService);
  turndownService.escape = (str: string) => {
    // 去掉 Turndown 对 * - + . [ ] # _ ` > 的不必要反斜杠转义
    return originalEscape(str).replace(/\\([*\-+.[\]#_`>])/g, "$1");
  };

  turndownService.addRule("singleLineDiv", {
    filter: "div",
    replacement: (content: string) => {
      // 空 div 或只含空白的 div 不产生额外换行
      const trimmed = content.trimEnd();
      if (!trimmed.trim()) return "";
      return trimmed + "\n";
    },
  });

  const htmlContent = ($("en-note").html() || "").trim();
  // 后处理：还原 &nbsp;、转换手打分割线、压缩过多空行
  // 代码块（围栏和行内）内的 &nbsp; 替换为普通空格
  const raw = turndownService.turndown(htmlContent)
    .replace(/\u00a0/g, " ")           // &nbsp; → 普通空格，行首缩进得以保留
    .replace(/^[_]{4,}\s*$/gm, "---")  // 手打下划线分割线 → 标准 hr
    // 围栏代码块内的 &nbsp; → 空格
    .replace(/(```[\s\S]*?```)/g, (block) => block.replace(/&nbsp;/g, " "))
    // 行内代码内的 &nbsp; → 空格
    .replace(/(`[^`\n]+`)/g, (code) => code.replace(/&nbsp;/g, " "))
    .trim();
  return raw.replace(/\n{4,}/g, "\n\n\n");
}
