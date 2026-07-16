/**
 * Lightweight markdown → safe HTML + source highlighting for prompt editors.
 * No external deps — covers the markdown operators use in system prompts.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline markdown (after HTML escape of the raw segment). */
function renderInline(escaped: string): string {
  let s = escaped;
  // inline code
  s = s.replace(
    /`([^`]+)`/g,
    '<code class="md-code">$1</code>',
  );
  // bold ** or __
  s = s.replace(
    /\*\*([^*]+)\*\*/g,
    "<strong>$1</strong>",
  );
  s = s.replace(
    /__([^_]+)__/g,
    "<strong>$1</strong>",
  );
  // italic * or _
  s = s.replace(
    /(^|[\s(])\*([^*\n]+)\*(?=[\s).,]|$)/g,
    "$1<em>$2</em>",
  );
  s = s.replace(
    /(^|[\s(])_([^_\n]+)_(?=[\s).,]|$)/g,
    "$1<em>$2</em>",
  );
  // links [text](url) — only http(s)
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  return s;
}

/**
 * Convert markdown-ish text to HTML suitable for dangerouslySetInnerHTML
 * after full escaping of user content.
 */
export function renderMarkdownToHtml(source: string): string {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    return '<p class="md-empty">Nothing to preview yet.</p>';
  }

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const body = renderInline(escapeHtml(para.join(" ")));
    out.push(`<p>${body}</p>`);
    para = [];
  };

  const closeList = () => {
    if (listType) {
      out.push(listType === "ul" ? "</ul>" : "</ol>");
      listType = null;
    }
  };

  const flushCode = () => {
    const lang = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : "";
    out.push(
      `<pre class="md-fence"${lang}><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`,
    );
    codeBuf = [];
    codeLang = "";
    inCode = false;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```/.test(line)) {
        flushCode();
      } else {
        codeBuf.push(line);
      }
      i += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = fence[1] || "";
      i += 1;
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      closeList();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(
        `<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`,
      );
      i += 1;
      continue;
    }

    if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
      flushPara();
      closeList();
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(
        `<blockquote>${renderInline(escapeHtml(quoteLines.join(" ")))}</blockquote>`,
      );
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      i += 1;
      continue;
    }

    const ol = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${renderInline(escapeHtml(ol[2]))}</li>`);
      i += 1;
      continue;
    }

    closeList();
    para.push(line);
    i += 1;
  }

  if (inCode) flushCode();
  flushPara();
  closeList();
  return out.join("\n");
}

/**
 * Highlight raw markdown source for the editor overlay / source view.
 * Returns HTML (escaped content + span wrappers).
 */
export function highlightMarkdownSource(source: string): string {
  const text = source.replace(/\r\n/g, "\n");
  if (!text) return "";

  const lines = text.split("\n");
  let inFence = false;
  const htmlLines = lines.map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return `<span class="md-tok-fence">${escapeHtml(line)}</span>`;
    }
    if (inFence) {
      return `<span class="md-tok-code">${escapeHtml(line)}</span>`;
    }

    const h = line.match(/^(#{1,6})(\s+)(.*)$/);
    if (h) {
      return (
        `<span class="md-tok-heading"><span class="md-tok-hash">${escapeHtml(h[1])}</span>` +
        escapeHtml(h[2]) +
        `<span class="md-tok-heading-text">${escapeHtml(h[3])}</span></span>`
      );
    }

    if (/^>\s?/.test(line)) {
      return `<span class="md-tok-quote">${escapeHtml(line)}</span>`;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      return line.replace(
        /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/,
        (_, sp, mark, ws, rest) =>
          `${escapeHtml(sp)}<span class="md-tok-list">${escapeHtml(mark)}</span>${escapeHtml(ws)}${inlineHighlight(rest)}`,
      );
    }

    if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
      return `<span class="md-tok-hr">${escapeHtml(line)}</span>`;
    }

    return inlineHighlight(line);
  });

  // Preserve trailing newline so overlay lines up with textarea
  const body = htmlLines.join("\n");
  return source.endsWith("\n") ? `${body}\n` : body;
}

function inlineHighlight(line: string): string {
  let s = escapeHtml(line);
  // Fenced-style inline code first so * inside `code` is not italicized.
  s = s.replace(
    /`([^`]+)`/g,
    '<span class="md-tok-inline-code">`$1`</span>',
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<span class="md-tok-link">[$1]($2)</span>',
  );
  s = s.replace(
    /\*\*([^*]+)\*\*/g,
    '<span class="md-tok-bold">**$1**</span>',
  );
  s = s.replace(
    /(?<![\w*])\*([^*\n]+)\*(?![\w*])/g,
    '<span class="md-tok-italic">*$1*</span>',
  );
  // Common system-prompt keywords (after markdown marks so they can nest).
  s = s.replace(
    /\b(MUST NOT|MUST|OBJECTIVE|ROLE|CONTEXT|OUTPUT|CONFIDENCE|PIPELINE CONTRACT)\b/g,
    '<span class="md-tok-keyword">$1</span>',
  );
  return s;
}
