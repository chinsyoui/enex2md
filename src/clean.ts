import * as cheerio from "cheerio/slim";

// enml字符串指 ENEX文件中每个 note 的 <content> 节点内的 CDATA 内容
export function cleanEnmlString(input: string): string {
  const $ = cheerio.load(input, { xmlMode: true });

  $("resource").remove();
  $('center[style*="display:none"]').remove();
  $("recognition").remove();
  $("recoIndex").remove();
  $("!DOCTYPE").remove();
  $('br[clear="none"]').replaceWith("<br/>");
  $("[style]").removeAttr("style");

  // <pre>/<code> 内的 &nbsp; 是代码缩进，直接替换为普通空格
  $("pre, code").each((_, el) => {
    const html = $(el).html();
    if (html && html.includes("&nbsp;")) {
      $(el).html(html.replace(/&nbsp;/g, " "));
    }
  });

  // 删除零宽字符；&nbsp; 保留原样，由 Turndown 处理后再还原为普通空格（保留行首缩进）
  const html = $.html()
    .replace(/[\u200b\u200c\u200d\u00ad\ufeff]/g, "");  // zero-width / soft-hyphen / BOM

  // 连续4个以上空 <div> 折叠为2个（保留段落间距，去除过度堆叠）
  return html.replace(/(<div[^>]*>\s*<\/div>\s*){4,}/gi, "<div></div><div></div>");
}
