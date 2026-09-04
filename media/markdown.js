/* SUBI Markdown Renderer
   Safe, incremental renderer for chat messages.
   - Uses marked for markdown parsing
   - Uses DOMPurify for HTML sanitization
   - Uses KaTeX for LaTeX math
   - Uses highlight.js for code syntax highlighting
   - Streaming-safe: takes raw text and returns sanitized HTML
*/
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.SUBI_MD) return;

  const SUBI_MD = {};

  function getMarkedInstance() {
    if (!window.marked) return null;
    const m = window.marked;
    if (typeof m.setOptions === 'function') {
      m.setOptions({
        gfm: true,
        breaks: true,
        headerIds: false,
        mangle: false,
        // Custom renderer: defer code blocks to highlight.js
        renderer: (function () {
          const r = new m.Renderer();
          const origCode = r.code.bind(r);
          r.code = function (codeObj, infostring, escaped) {
            // marked v12 passes { text, lang, escaped } as first arg in object form
            const text = (codeObj && typeof codeObj === 'object') ? codeObj.text : codeObj;
            const lang = (codeObj && typeof codeObj === 'object') ? codeObj.lang : (infostring || '');
            const code = String(text || '').replace(/\n$/, '');
            let langClass = '';
            let highlighted = SUBI_MD.escapeHtml(code);
            if (lang && window.hljs && window.hljs.getLanguage(lang)) {
              try {
                highlighted = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                langClass = ' language-' + lang;
              } catch (_) { /* ignore */ }
            } else if (!lang && window.hljs) {
              try {
                const auto = window.hljs.highlightAuto(code);
                highlighted = auto.value;
                if (auto.language) langClass = ' language-' + auto.language;
              } catch (_) { /* ignore */ }
            }
            return '<pre class="subi-hljs"><code class="hljs' + langClass + '">' + highlighted + '</code></pre>';
          };
          const origLink = r.link.bind(r);
          r.link = function (hrefObj, title, text2) {
            const href = (hrefObj && typeof hrefObj === 'object') ? hrefObj.href : hrefObj;
            const t = (hrefObj && typeof hrefObj === 'object') ? hrefObj.title : title;
            const tx = (hrefObj && typeof hrefObj === 'object') ? hrefObj.text : text2;
            const safeHref = SUBI_MD.safeHref(String(href || ''));
            const titleAttr = t ? ' title="' + SUBI_MD.escapeAttr(t) + '"' : '';
            return '<a href="' + SUBI_MD.escapeAttr(safeHref) + '"' + titleAttr + ' target="_blank" rel="noopener noreferrer">' + tx + '</a>';
          };
          return r;
        })(),
      });
    }
    return m;
  }

  SUBI_MD.escapeHtml = function (s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  SUBI_MD.escapeAttr = SUBI_MD.escapeHtml;

  SUBI_MD.safeHref = function (href) {
    const trimmed = String(href || '').trim();
    if (!trimmed) return '#';
    if (/^(javascript|data|vbscript|file):/i.test(trimmed)) return '#';
    return trimmed;
  };

  // Render LaTeX inside an already-rendered HTML root using KaTeX.
  SUBI_MD.renderMath = function (root) {
    if (!root) return;
    if (!window.katex) return;
    // Block math: $$...$$  (use \[...\] too)
    const blockPatterns = [/\$\$([\s\S]+?)\$\$/g, /\\\[([\s\S]+?)\\\]/g];
    // Inline math: $...$ and \(...\)
    const inlinePatterns = [/\$([^\$\n]+?)\$/g, /\\\(([^\$\n]+?)\\\)/g];

    const walk = (node) => {
      if (!node) return;
      // Skip if inside <code> or <pre>
      if (node.nodeType === 1 && (node.tagName === 'CODE' || node.tagName === 'PRE' || node.tagName === 'SCRIPT' || node.tagName === 'STYLE')) {
        return;
      }
      if (node.nodeType === 3) {
        // Process text node
        let text = node.nodeValue;
        if (!text || text.indexOf('$') === -1 && text.indexOf('\\[') === -1 && text.indexOf('\\(') === -1) return;

        // Try block first
        let blockMatch = null;
        for (const pat of blockPatterns) {
          pat.lastIndex = 0;
          blockMatch = pat.exec(text);
          if (blockMatch) break;
        }
        if (blockMatch) {
          const before = text.slice(0, blockMatch.index);
          const tex = blockMatch[1];
          const after = text.slice(blockMatch.index + blockMatch[0].length);
          const beforeNode = document.createTextNode(before);
          const afterNode = document.createTextNode(after);
          const span = document.createElement('span');
          span.className = 'subi-math-block';
          try { window.katex.render(tex, span, { displayMode: true, throwOnError: false }); }
          catch (_) { span.textContent = blockMatch[0]; }
          const parent = node.parentNode;
          if (parent) {
            parent.insertBefore(beforeNode, node);
            parent.insertBefore(span, node);
            parent.insertBefore(afterNode, node);
            parent.removeChild(node);
            // Continue with afterNode
            walk(afterNode);
            walk(beforeNode);
          }
          return;
        }
        // Inline
        for (const pat of inlinePatterns) {
          pat.lastIndex = 0;
          const m = pat.exec(text);
          if (m) {
            const before = text.slice(0, m.index);
            const after = text.slice(m.index + m[0].length);
            const beforeNode = document.createTextNode(before);
            const afterNode = document.createTextNode(after);
            const span = document.createElement('span');
            span.className = 'subi-math-inline';
            try { window.katex.render(m[1], span, { displayMode: false, throwOnError: false }); }
            catch (_) { span.textContent = m[0]; }
            const parent = node.parentNode;
            if (parent) {
              parent.insertBefore(beforeNode, node);
              parent.insertBefore(span, node);
              parent.insertBefore(afterNode, node);
              parent.removeChild(node);
              walk(afterNode);
              walk(beforeNode);
            }
            return;
          }
        }
        return;
      }
      // Element node: recurse into children (snapshot because we may mutate)
      const children = Array.from(node.childNodes || []);
      for (const child of children) walk(child);
    };

    walk(root);
  };

  // Render markdown text → sanitized HTML string with math + code highlighting.
  SUBI_MD.render = function (text) {
    const src = String(text || '');
    const m = getMarkedInstance();
    if (!m || !window.DOMPurify) {
      return SUBI_MD.escapeHtml(src);
    }
    let html = '';
    try {
      html = m.parse(src);
    } catch (_) {
      return SUBI_MD.escapeHtml(src);
    }
    const clean = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'a', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark',
        'p', 'br', 'hr', 'div', 'span',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li',
        'blockquote', 'q', 'cite',
        'code', 'pre', 'kbd', 'samp', 'var',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'img', 'figure', 'figcaption',
        'details', 'summary',
        'sub', 'sup',
      ],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'src', 'alt', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false,
    });
    return clean;
  };

  // Render and apply (sets innerHTML then post-processes math)
  SUBI_MD.renderToElement = function (root, text) {
    if (!root) return;
    const html = SUBI_MD.render(text);
    root.innerHTML = html;
    SUBI_MD.renderMath(root);
  };

  window.SUBI_MD = SUBI_MD;
})();
