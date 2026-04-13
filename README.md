# enex2md

Convert Evernote export file (`.enex`) to Markdown files, with attachments and a lot of noise clean walkarounds.

注: 
  对于中国版本的"印象笔记"，自从独立运营后，导出的文件变成加密的了，因此无法转换。
  解决办法是找一个早期的印象笔记桌面端安装程序，早期版本仍然是可用的，同时导出的 enex 文件尚未加密。

## Install & Build

```bash
cd tools/enex2md
npm install
npm run build
```

## Usage

```bash
# Dev mode (no build needed)
npx tsx src/cli.ts MyNotes.enex [output-dir] [-v]

# Or build first, then run
npm run build
node dist/cli.js MyNotes.enex [output-dir] [-v]
```

### Arguments

| Argument | Description |
|---|---|
| `input.enex` | Path to the Evernote `.enex` export file |
| `output-dir` | Output directory (default: `<enex-basename>/` next to the input file) |
| `-v, --verbose` | Show detailed progress |

### Output Structure

```
output-dir/
├── Note Title 1.md
├── Note Title 2.md
└── attachments/
    ├── image.png
    └── document.pdf
```

Each `.md` file has YAML frontmatter with title, author, tags, created/updated dates.

## Quality Diagnostics

转换完成后，可以用诊断脚本扫描输出目录，检查转换质量：

```bash
# 汇总报告
npx tsx src/diagnose.ts <output-dir>

# 详细报告（显示每个文件的具体问题位置）
npx tsx src/diagnose.ts <output-dir> --verbose

# 过滤特定问题类型
npx tsx src/diagnose.ts <output-dir> --verbose | grep "\[MISSING\]"
```

检测项说明：

| 类型 | 含义 |
|---|---|
| `BLANK` | 连续多余空行（div 堆叠噪音） |
| `DUPBLANK` | 空行占比超过 40%，整体噪音较多 |
| `ESCAPE` | 残留反斜杠转义，如 `\#` `\*` |
| `HR` | 未被转换的下划线/等号分割线 |
| `NBSP` | 残留 `&nbsp;` 实体 |
| `ZWSP` | 零宽字符残留 |
| `MISSING` | 附件找不到，输出了占位符 |
| `ENCRYPT` | 笔记含加密内容，输出了占位符 |
| `RAWHTML` | 残留未转换的 HTML 标签 |
| `EMPTY` | 正文内容为空（只有 frontmatter） |
| `YAML` | frontmatter 格式异常 |

## 转换算法详解

整个转换流水线分为五个阶段：

### 第一阶段：解析 ENEX 文件（`enex2md.ts` → `parseEnexFile`）

ENEX 是标准 XML 格式，使用 `sax` 流式解析器逐节点处理，避免将整个文件载入内存。

解析过程中维护两个游标对象 `currentNote` 和 `currentResource`，遇到对应开标签时创建，遇到闭标签时入队。

- `<note>` 节点：收集 `title`、`created`、`updated`、`author`、`source`、`source-url`、`tag` 等元数据；`<content>` 节点的内容是 CDATA，通过 `cdata` 事件（而非 `text` 事件）读取，拼接到 `currentNote.content`。
- `<resource>` 节点：收集 `mime`、`width`、`height`、`file-name`；附件二进制数据以 Base64 编码存储在 `<data>` 子节点，通过 `text` 事件累积到 `base64Data` 字符串，关闭标签时用 `Buffer.from(..., 'base64')` 解码为原始字节，并对原始字节计算 MD5 作为唯一标识 `hash`。

### 第二阶段：保存附件，建立 hash → 相对路径映射

所有 `Resource` 对象遍历一遍：

1. 根据 `mime` 类型映射扩展名（`image/png` → `.png`，`application/pdf` → `.pdf` 等）。
2. 优先使用 `<file-name>` 字段作为文件名，否则用 `{md5hash}{ext}` 命名。
3. 写入 `attachments/` 子目录，并将 `hash → 相对路径` 存入 `Map<string, string>`，供后续 HTML 转换时替换 `<en-media>` 引用。

### 第三阶段：清洗 ENML（`clean.ts` → `cleanEnmlString`）

ENML（Evernote Markup Language）是 HTML 的方言，包含大量 Evernote 私有标签和冗余属性，需要先清洗：

| 操作 | 原因 |
|---|---|
| 删除 `<resource>` 节点 | 附件数据已在第一阶段提取，此处为重复内容 |
| 删除 `center[style*="display:none"]` | Evernote 插入的不可见占位元素 |
| 删除 `<recognition>`、`<recoIndex>` | OCR 识别数据，无需转换 |
| 删除 `<!DOCTYPE>` 声明 | 避免 cheerio 解析干扰 |
| 将 `<br clear="none">` 替换为 `<br/>` | 规范化换行标签 |
| 移除所有 `style` 属性 | 去除内联样式，输出纯语义 Markdown |
| `<pre>`/`<code>` 内的 `&nbsp;` → 普通空格 | 代码块缩进应为真实空格，不是 HTML 实体 |
| 删除零宽字符（`\u200b` 等） | 不可见噪音字符 |
| 连续 4 个以上空 `<div>` 折叠为 2 个 | 去除过度堆叠的空行，保留段落间距 |

`&nbsp;` 在 `<pre>`/`<code>` 以外的地方保持原样，由后续 Turndown 处理后再还原为普通空格，以保留行首缩进语义。

### 第四阶段：格式化 HTML（`pretty.ts` → `prettyHtmlString`）

清洗后的 ENML 字符串经过一次自定义的 pretty-print，目的是将扁平的 HTML 字符串转换为带缩进的规范树形结构，方便 Turndown 正确识别块级/行内元素边界。

实现细节：
- 用 cheerio 以 `xmlMode: true` 解析，然后递归遍历 DOM 树，按节点类型分别处理：`text` 节点只折叠跨行空白（`\n` 周围的空格），保留行内空格序列（`&nbsp;` 转成的普通空格不会被压缩），`comment` 节点原样保留，`tag` 节点递归格式化子节点。
- void 元素（`br`、`img`、`hr` 等）自闭合，不递归子节点。
- `pre`/`code`/`textarea` 内部内容**原样透传**，不加缩进前缀，避免破坏代码块的换行和空白语义。
- 如果节点内容是嵌套的 CDATA HTML（Evernote 有时会在 CDATA 里再嵌 HTML），则递归调用 `cleanEnmlString` + `prettyHtmlString` 处理后重新包裹为 `<![CDATA[...]]>`。

### 第五阶段：HTML → Markdown（`enml2md.ts` → `enml2md`）

这是核心转换步骤，使用 `turndown` + `turndown-plugin-gfm` 完成。

**预处理（cheerio DOM 操作）：**

1. `flattenTableCells`：仅当单元格内含块级元素（`div`、`p`、`ul` 等）时才将内容替换为纯文本，保留行内格式（`<strong>`、`<a>`、`<code>` 等）。
2. `normalizeTables`：修复结构不规范的表格，并将第一行 `<tr>` 提升为 `<thead>`（GFM 表格插件需要 `<thead>` 才能生成分隔行）。含 `colspan`/`rowspan > 1` 的复杂表格跳过处理，保持原始 HTML（Markdown 无法表达合并单元格）。
3. `<en-media>` 替换：遍历所有 `<en-media>` 标签，取 `hash` 属性在附件 Map 中查找路径；`image/*` 类型替换为 `<img src="..." alt=""/>`，其他类型替换为 `<a href="...">` 链接；找不到对应附件时输出 `[missing attachment: {hash}]` 占位符。
4. `<en-todo>` 替换：`checked="true"` → `☑`，否则 → `☐`。
5. `<en-crypt>` 替换：输出 `[encrypted content]` 占位符。

**Turndown 配置：**

```
codeBlockStyle: "fenced"   // 代码块用 ``` 围栏
headingStyle:   "atx"      // 标题用 # 前缀
emDelimiter:    "*"        // 斜体用 *
bulletListMarker: "-"      // 无序列表用 -
linkStyle:      "inlined"  // 链接用内联格式 [text](url)
hr:             "---"      // 分割线用 ---
```

启用 `gfm` 插件以支持 GFM 表格、删除线、任务列表等扩展语法。

**自定义规则：**

- 覆盖 `escape` 方法：去掉 Turndown 对 `*`、`-`、`+`、`.`、`#`、`_`、`` ` ``、`>` 等字符的不必要反斜杠转义，让输出更干净。
- 添加 `singleLineDiv` 规则：`<div>` 内容用 `trimEnd()` 保留行首空格（`&nbsp;` 缩进），空 `<div>` 不产生额外换行。

**后处理（字符串层面）：**

- `\u00a0`（`&nbsp;` 的 Unicode 形式）→ 普通空格，保留行首缩进。
- 连续 4 个以上下划线的行（手打分割线）→ 标准 `---`。
- 围栏代码块和行内代码内残留的 `&nbsp;` 实体 → 普通空格。
- 连续 4 个以上 `\n` 折叠为 3 个（最多保留 1 个视觉空行）。

### 第六阶段：生成最终 Markdown 文件

1. **YAML frontmatter**：从 `NoteMeta` 生成，字段顺序为 `title`、`author`、`source`、`source_url`、`created`、`updated`、`tags`；字段值含 YAML 特殊字符时自动加引号转义；`updated` 与 `created` 相同时省略；`tags` 输出为标准 YAML 列表格式。
2. **文件名**：取 `title`，将 `< > : " / \ | ? *` 替换为 `_`，截断至 120 字符，拼接 `.md` 后缀；同名文件自动追加 `_2`、`_3` 等序号避免覆盖。
3. **错误隔离**：单篇笔记转换失败时记录错误并继续处理剩余笔记，最终输出 `成功数/总数`。
4. **文件时间戳**：调用 `fs.utimesSync` 将文件的 `atime`/`mtime` 设置为笔记的 `created`/`updated` 时间（格式 `YYYYMMDDTHHmmssZ` 解析为 UTC Date），使导出文件的系统时间与原始笔记一致。
