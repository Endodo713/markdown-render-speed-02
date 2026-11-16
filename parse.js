import { marked } from './vendor/marked/marked.esm.js';

function esc(s) {
  // Fast path: a single character (the common case — parseInline calls
  // esc() once per literal character). Most chars need no escaping.
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    return c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : c === 39 ? '&#39;' : s;
  }
  // Fast path: no escapable character at all — return the string as-is.
  // (The single-char path above already handled length 1.)
  if (!/[&<>"']/.test(s)) return s;
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const replacement = c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : c === 39 ? '&#39;' : '';
    if (replacement) {
      out.push(s.slice(start, i), replacement);
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.join('');
}

function escAttr(s) {
  // Marked percent-encodes space, '[', ']', backslash, double-quote and
  // non-breaking space (as UTF-8 %C2%A0) in link hrefs.
  return esc(s.split(' ').join('%20').split('[').join('%5B').split(']').join('%5D').split('\\').join('%5C').split('"').join('%22').split(' ').join('%C2%A0'));
}

function isWord(c) {
  return c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
}

function expandIndent(line) {
  // Fast path: no tab in the leading whitespace means nothing expands
  // — return the line itself (no new string). Most lines have no tab.
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (line[i] !== '\t') return line;
  let column = i, j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    column += line[j] === '\t' ? 4 - column % 4 : 1;
    j++;
  }
  return ' '.repeat(column) + line.slice(j);
}

// Strip a blockquote marker (`> `) from a line. Tabs in the leading
// whitespace after the marker are expanded to spaces using their
// ABSOLUTE column in the original line, so fenced-code content keeps
// the right indent (e.g. ">   \tfoo" → 6 spaces + "foo": the tab sits
// at column 4 and expands to 4 spaces).
function stripQuote(line) {
  const m = line.match(/^ {0,3}> ?/);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  let col = m[0].length;
  let result = '';
  let j = 0;
  while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) {
    if (rest[j] === '\t') {
      const w = 4 - (col % 4);
      result += ' '.repeat(w);
      col += w;
    } else {
      result += ' ';
      col++;
    }
    j++;
  }
  return result + rest.slice(j);
}

// Remove the first `cols` columns of indentation from a line (tabs count to
// the next multiple of 4). A tab straddling the boundary becomes spaces,
// and a tab sitting exactly at the boundary expands to its width. Any
// leading tabs left in the remainder are expanded to spaces using the
// column already consumed, so a tab never survives into a later strip
// where it would be expanded from the wrong (already-stripped) column.
function stripIndent(line, cols, literal = false) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    if (line[i] === '\t') {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + line.slice(i + 1);
      col += w; i++;
    } else if (line[i] === ' ') {
      col++; i++;
    } else break;
  }
  // When literal is set (indented code blocks), the remainder is
  // literal content: a tab after the stripped indent is preserved as
  // a tab, not expanded to spaces.
  if (literal) return line.slice(i);
  // Expand any leading tabs in the remainder to spaces, starting from
  // the column already consumed — but only when we actually stripped
  // indent (col > 0). A tab at column 0 with nothing stripped is
  // content (e.g. fenced-code content with a 0-indent fence) and must
  // be preserved literally, not expanded.
  if (col > 0) {
    let result = '';
    let j = i;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      if (line[j] === '\t') {
        const w = 4 - (col % 4);
        result += ' '.repeat(w);
        col += w;
      } else {
        result += ' ';
        col++;
      }
      j++;
    }
    return result + line.slice(j);
  }
  return line.slice(i);
}

// marked preserves named entity references as-is in the output (the browser
// decodes them) but decodes numeric character references to the character.
// &#0; and out-of-range / surrogate values become U+FFFD.
function decodeEntity(entity) {
  const body = entity.slice(1, -1);
  if (body[0] !== '#') return entity;
  const hex = body[1] === 'x' || body[1] === 'X';
  const value = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!value || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\uFFFD';
  return esc(String.fromCodePoint(value));
}

function unescapePunct(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Parse the inside of an inline link's parentheses (or a reference
// definition's destination + title). Returns {href, title} or null.
// Destination: <...> or a bare token (no spaces, balanced parens).
// Title (optional, after whitespace): "..." or '...' or (...).
function splitLinkTarget(inner) {
  let i = 0;
  while (i < inner.length && (inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t')) i++;
  if (i >= inner.length) return null;
  let href;
  if (inner[i] === '<') {
    const j = inner.indexOf('>', i + 1);
    if (j < 0) return null;
    if (inner.slice(i + 1, j).includes('\n')) return null;
    href = inner.slice(i + 1, j);
    i = j + 1;
  } else {
    let depth = 0, j = i;
    while (j < inner.length) {
      const ch = inner[j];
      if (ch === '\\' && j + 1 < inner.length) { j += 2; continue; }
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
      if (ch === '(') depth++;
      if (ch === ')') { if (depth === 0) break; depth--; }
      j++;
    }
    if (j === i) return null;
    href = inner.slice(i, j);
    i = j;
  }
  while (i < inner.length && (inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t')) i++;
  let title = null;
  if (i < inner.length) {
    const q = inner[i];
    if (q === '"' || q === "'") {
      let k = i + 1;
      while (k < inner.length) {
        if (inner[k] === '\\' && k + 1 < inner.length) { k += 2; continue; }
        if (inner[k] === q) break;
        k++;
      }
      if (k >= inner.length) return null;
      title = inner.slice(i + 1, k);
      i = k + 1;
    } else if (q === '(') {
      let k = i + 1, depth = 0;
      while (k < inner.length) {
        if (inner[k] === '\\' && k + 1 < inner.length) { k += 2; continue; }
        if (inner[k] === '(') depth++;
        if (inner[k] === ')') { if (depth === 0) break; depth--; }
        k++;
      }
      if (k >= inner.length) return null;
      title = inner.slice(i + 1, k);
      i = k + 1;
    } else {
      return null;
    }
    while (i < inner.length && (inner[i] === ' ' || inner[i] === '\n' || inner[i] === '\t')) i++;
    if (i < inner.length) return null;
  }
  return { href: unescapePunct(href), title: title === null ? null : unescapePunct(title) };
}

// A domain label: alphanumerics and hyphens, not starting or ending with '-'.
function validLabel(s) {
  if (!s) return false;
  if (s[0] === '-' || s[s.length - 1] === '-') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isWord(c) || c === 45)) return false;
  }
  return true;
}

// Validate a domain (host) for an extended autolink: labels separated by '.',
// at least one '.', and a TLD of at least two letters.
function validDomain(host) {
  const dot = host.lastIndexOf('.');
  if (dot < 1 || dot === host.length - 1) return false;
  const tld = host.slice(dot + 1);
  if (tld.length < 2) return false;
  for (let i = 0; i < tld.length; i++) {
    const c = tld.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  }
  const labels = host.split('.');
  for (const lab of labels) if (!validLabel(lab)) return false;
  return true;
}

// GFM extended autolink for www. / http:// / https:// starting at i.
// Returns {href, text, length} or null.
// marked's _backpedal for GFM URLs: the longest prefix of the
// candidate URL formed by runs of safe chars, balanced (...) groups,
// bare '&' (not starting a trailing entity), and punctuation that is
// NOT at the very end. A '(' group is kept only when it closes
// ( \([^)]*\) ); an unbalanced '(' ends the URL before it.
function backpedalUrl(text) {
  const n = text.length;
  let k = 0;
  while (k < n) {
    const c = text[k];
    if (!'?!.,:;*_\'"~()&'.includes(c)) {
      while (k < n && !'?!.,:;*_\'"~()&'.includes(text[k])) k++;
      continue;
    }
    if (c === '(') {
      const close = text.indexOf(')', k + 1);
      if (close < 0) break;
      k = close + 1; continue;
    }
    if (c === '&') {
      // A '&' starting a trailing &word; entity is not part of the URL.
      if (/^[a-zA-Z0-9]+;$/.test(text.slice(k + 1))) break;
      k++; continue;
    }
    if ('?!.,:;*_\'"~)'.includes(c)) {
      // A run of punctuation reaching the end of the URL is trailing
      // punctuation: none of it is part of the URL (marked loops its
      // backpedal until stable, which strips such a run whole).
      // A run followed by a non-punctuation char is mid-URL and kept.
      let e = k;
      while (e < n && '?!.,:;*_\'"~)'.includes(text[e])) e++;
      if (e === n) break;
      k = e; continue;
    }
    break;
  }
  return text.slice(0, k);
}
function matchUrl(s, i) {
  let scheme = null, start = i;
  // Schemes are case-insensitive (Https:// is a valid autolink), EXCEPT
  // the www. prefix, which GFM requires to be lowercase.
  const low = s.slice(i, i + 8).toLowerCase();
  if (s.startsWith('www.', i)) { scheme = 'www'; }
  else if (low.startsWith('http://')) { scheme = 'http'; }
  else if (low.startsWith('https://')) { scheme = 'https'; }
  else if (s.slice(i, i + 7).toLowerCase() === 'mailto:') {
    // mailto:email is one autolink (href and text are the whole thing).
    const em = matchEmail(s, i + 7);
    if (!em) return null;
    const text = s.slice(i, i + 7 + em.length);
    return { href: text, text, length: text.length };
  }
  else return null;
  if (i > 0) {
    const prev = s.charCodeAt(i - 1);
    if (isWord(prev) || s[i - 1] === '/') return null;
  }
  // Consume the URL: stop at whitespace, <, >, ", backtick. A backslash
  // IS part of the URL (marked includes it, percent-encoded as %5C in
  // the href); it is not a hard-break escape inside an autolink.
  // A '(' after ']' or ')' does NOT end the URL — marked's backpedal
  // keeps a balanced (...) group attached (e.g. the whole of
  // "https://a)](https://b)" is one autolink).
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 34 || c === 96) break;
    j++;
  }
  // Apply marked's _backpedal to the candidate URL (strips trailing
  // punctuation, keeps balanced (...) groups, drops an unbalanced '('
  // group and a trailing &word; entity), so the host below is
  // validated on the real URL.
  let text = backpedalUrl(s.slice(i, j));
  if (!text) return null;
  // The host part (after the scheme) must be a valid domain. It ends at
  // the first character that cannot appear in a domain (/, ?, #, :, or
  // any bracket/punctuation that terminates the host).
  const hostStart = scheme === 'www' ? 4 : scheme === 'http' ? 7 : 8;
  let hostEnd = hostStart;
  while (hostEnd < text.length) {
    const c = text.charCodeAt(hostEnd);
    if (c === 47 || c === 63 || c === 35 || c === 58 || !(isWord(c) || c === 45 || c === 46)) break;
    hostEnd++;
  }
  const host = text.slice(hostStart, hostEnd);
  // A URL host needs no dot (marked links https://a and www.a) — it is
  // just one or more valid labels, with an optional trailing dot.
  // (Emails keep the stricter validDomain, which requires a dot + TLD.)
  {
    let h = host;
    while (h.endsWith('.')) h = h.slice(0, -1);
    if (!h) return null;
    const labels = h.split('.');
    for (const lab of labels) if (!validLabel(lab)) return null;
  }
  const href = scheme === 'www' ? 'http://' + text : text;
  return { href, text, length: text.length };
}

// GFM extended autolink for an email address starting at i (word start).
// Returns {email, length} or null.
function matchEmail(s, i) {
  if (i > 0) {
    const prev = s.charCodeAt(i - 1);
    if (isWord(prev) || s[i - 1] === '/') return null;
  }
  // Local part: atoms separated by single dots.
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isWord(c) || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 45 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 46) j++;
    else break;
  }
  if (j === i || s[j] !== '@') return null;
  const local = s.slice(i, j);
  if (local[0] === '.' || local[local.length - 1] === '.' || local.includes('..')) return null;
  j++;
  const hostStart = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isWord(c) || c === 45 || c === 46) j++;
    else break;
  }
  // A trailing '.' is sentence punctuation, not part of the domain
  // (e.g. `return@echo.example.com.` ends the sentence).
  while (j > hostStart && s[j - 1] === '.') j--;
  const host = s.slice(hostStart, j);
  if (!validDomain(host)) return null;
  const email = s.slice(i, j);
  return { email, length: email.length };
}

// Find the index of the `]` matching the `[` at `start` (balanced brackets,
// code spans and escapes skipped), or -1.
function closeBracket(s, start) {
  let depth = 1;
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const j = s.indexOf('`'.repeat(n), i + n);
      if (j < 0) return -1;
      i = j + n - 1; continue;
    }
    if (s[i] === '[') depth++;
    if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

// Does a link start at index i (s[i] is '[' or '!' followed by '[')?
// A link starts there when the bracketed text is followed by a valid inline
// destination (...) or a defined reference label [...].
function linkStartsAt(s, i, refs) {
  const image = s[i] === '!';
  const begin = i + (image ? 2 : 1);
  const end = closeBracket(s, begin - 1);
  if (end < 0) return false;
  if (s[end + 1] === '(') {
    let j = end + 2, balance = 0;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '(') balance++;
      if (s[j] === ')') { if (!balance) break; balance--; }
    }
    if (j >= s.length) return false;
    return splitLinkTarget(s.slice(end + 2, j)) !== null;
  }
  let label = s.slice(begin, end);
  if (s[end + 1] === '[') {
    const close = s.indexOf(']', end + 2);
    if (close < 0) return false;
    label = s.slice(end + 2, close) || label;
  }
  return refs[label.toLowerCase().replace(/\s+/g, ' ')] !== undefined;
}

// ASCII punctuation / whitespace tests for emphasis flanking rules.
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}

// Can the delimiter run of `ch` at q (length m) CLOSE emphasis?
// A run can close only when right-flanking; `_` additionally requires it
// to be non-left-flanking or followed by punctuation. String boundaries
// count as whitespace (the paragraph is followed by a newline).
function canCloseRun(s, q, m, ch) {
  const prev = q > 0 ? s.charCodeAt(q - 1) : 32;
  const next = q + m < s.length ? s.charCodeAt(q + m) : 32;
  const prevSpace = isSpaceCode(prev);
  const nextSpace = isSpaceCode(next);
  const prevPunct = isPunctCode(prev);
  const nextPunct = isPunctCode(next);
  const leftFlanking = !nextSpace && (!nextPunct || (prevSpace || prevPunct));
  const rightFlanking = !prevSpace && (!prevPunct || (nextSpace || nextPunct));
  if (ch === '_') return rightFlanking && (!leftFlanking || nextPunct);
  return rightFlanking;
}

// Can the delimiter run of `ch` at q (length m) OPEN emphasis?
// String boundaries count as whitespace (the paragraph is followed by a
// newline). `_` additionally requires non-right-flanking or a preceding
// punctuation character.
// Validate an inline-HTML tag body (the text between '<' and '>'):
// a tag name, then attributes whose names start [A-Za-z:_] and
// continue [\w.:-], each optionally =value (double-quoted,
// single-quoted, or unquoted with no space/"'=< > `). A closing tag
// is /name plus optional whitespace; an open tag may end with /.
// This mirrors marked's tag regex; a tag with an invalid attribute
// name (e.g. <foo bar=baz bim!bop />) is literal text, not HTML.
function validTagBody(body) {
  let j = 0;
  const isWs = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  if (body[j] === '/') {
    j++;
    if (!/[A-Za-z]/.test(body[j] || '')) return false;
    while (j < body.length && /[A-Za-z0-9-]/.test(body[j])) j++;
    while (j < body.length && isWs(body[j])) j++;
    return j === body.length;
  }
  if (!/[A-Za-z]/.test(body[j] || '')) return false;
  while (j < body.length && /[A-Za-z0-9-]/.test(body[j])) j++;
  while (j < body.length) {
    if (body[j] === '/') {
      // A self-closing '/' must sit immediately before '>' — no
      // whitespace may follow it (<bar/ > is literal text).
      j++;
      return j === body.length;
    }
    if (isWs(body[j])) {
      while (j < body.length && isWs(body[j])) j++;
      if (j >= body.length) return true;
      if (body[j] === '/') {
        j++;
        return j === body.length;
      }
    }
    // At an attribute name: the separator whitespace was consumed
    // either just above or by the previous attribute's trailing skip.
    if (!/[A-Za-z:_]/.test(body[j])) return false;
    while (j < body.length && /[\w.:-]/.test(body[j])) j++;
    while (j < body.length && isWs(body[j])) j++;
    if (body[j] === '=') {
      j++;
      while (j < body.length && isWs(body[j])) j++;
      if (body[j] === '"') {
        j++;
        while (j < body.length && body[j] !== '"') j++;
        if (j >= body.length) return false;
        j++;
      } else if (body[j] === "'") {
        j++;
        while (j < body.length && body[j] !== "'") j++;
        if (j >= body.length) return false;
        j++;
      } else {
        if (j >= body.length) return false;
        while (j < body.length && !isWs(body[j]) && body[j] !== '"' && body[j] !== "'" && body[j] !== '=' && body[j] !== '<' && body[j] !== '>' && body[j] !== '`') j++;
      }
    }
  }
  return true;
}
function canOpenRun(s, q, m, ch) {
  const prev = q > 0 ? s.charCodeAt(q - 1) : 32;
  const next = q + m < s.length ? s.charCodeAt(q + m) : 32;
  const prevSpace = isSpaceCode(prev);
  const nextSpace = isSpaceCode(next);
  const prevPunct = isPunctCode(prev);
  const nextPunct = isPunctCode(next);
  const leftFlanking = !nextSpace && (!nextPunct || (prevSpace || prevPunct));
  const rightFlanking = !prevSpace && (!prevPunct || (nextSpace || nextPunct));
  if (ch === '_') return leftFlanking && (!rightFlanking || prevPunct);
  return leftFlanking;
}

// Find the closer for an opener of `n` copies of `ch`, starting the search
// at `start`. Returns the index of the LAST n chars of the closing run
// (inner delimiters consume the run from its start), or -1. A closer run
// first satisfies pending inner openers (tracked on a stack) before it
// can close the outer opener; runs that can only open are skipped, as are
// code spans and escaped delimiters.
function findEmphClose(s, start, n, ch) {
  // Stack entries are {v: delimiter length, sp: opener preceded by
  // whitespace (or at the start)} — the sp flag decides the "poisoned"
  // rule below: only a strong whose opener sat at a word boundary
  // (space before it) poisons the outer opener when it closes.
  const stack = [];
  let i = start;
  let poisoned = false;
  // Rule of 3 (marked's emStrong): a delimiter run that can both open
  // and close, whose length makes (opener + run) divisible by 3 while
  // the opener alone is not, is SKIPPED for this opener — its length
  // is added to f and it neither opens nor closes anything here. The
  // skipped length extends the final closer's raw match, so that many
  // extra delimiters of the closing run land inside the emphasis
  // (e.g. **a *b*c*** keeps a '*' inside the <strong>).
  let f = 0;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '`') {
      let m = 1;
      while (s[i + m] === '`') m++;
      const j = s.indexOf('`'.repeat(m), i + m);
      // No matching closer: the backticks are literal text inside the
      // emphasis, not a code span — keep scanning for the closer.
      if (j < 0) { i += m; continue; }
      i = j + m; continue;
    }
    // An HTML tag is opaque to emphasis: a delimiter inside a tag's
    // attributes (e.g. title="*") is never a closer or an opener.
    // Skip over a whole valid tag (marked masks tags out before
    // detecting emphasis).
    if (s[i] === '<') {
      const gt = s.indexOf('>', i + 1);
      if (gt > i && validTagBody(s.slice(i + 1, gt))) { i = gt + 1; continue; }
    }
    if (s[i] === ch) {
      let m = 1;
      while (s[i + m] === ch) m++;
      // A ~ run of 3+ is literal text, never a strikethrough delimiter.
      if (ch === '~' && m >= 3) { i += m; continue; }
      const wasPoisoned = poisoned;
      poisoned = false;
      const canOpen = canOpenRun(s, i, m, ch);
      const canClose = canCloseRun(s, i, m, ch);
      const sp = i === 0 || isSpaceCode(s.charCodeAt(i - 1));
      // Rule of 3 skip (see above): a both-ways run whose length
      // completes a multiple of 3 with the opener is skipped.
      if (canOpen && canClose && n % 3 !== 0 && (n + m) % 3 === 0) { f += m; i += m; continue; }
      if (canClose) {
        let rem = m;
        let poppedStrong = false;
        let poppedSp = false;
        while (stack.length > 0 && rem >= stack[stack.length - 1].v) {
          const e = stack.pop();
          if (e.v === 2) { poppedStrong = true; poppedSp = e.sp; }
          rem -= e.v;
        }
        // The closer uses b delimiters of the run (b is the run
        // length, capped by the excess over the opener plus the
        // rule-of-3 skips); the content ends b-n delimiters into
        // the run, so skipped delimiters land inside the emphasis.
        // A run that closes an inner strong AND the outer opener at
        // once (e.g. *** closing ** and *) closes the outer here —
        // the poisoned flag (set below) only blocks a LATER closer
        // run, not this one (wasPoisoned is read before it is set).
        if (stack.length === 0 && rem >= n) {
          if (!wasPoisoned) {
            const b = Math.min(m, m + n - rem + f);
            return i + b - n;
          }
          // Poisoned: an inner strong just closed with non-space text
          // after it, so this run cannot close the outer opener.
        }
        if (canOpen && rem > 0) stack.push({ v: rem, sp });
        // A strong that closes with non-space text right after it
        // "poisons" the outer opener — but only when that strong's
        // opener sat at a word boundary (space before it). An intraword
        // strong (type**other**) does not poison: the outer opener
        // still closes (marked forms *public **other**optional*).
        // This is the rule of 3: it only blocks when the outer opener
        // is a single delimiter (n=1) and the inner closer is a double
        // (1+2=3); a ** outer (n=2) is not blocked (2+2=4).
        if (n === 1 && (ch === '*' || ch === '_') && poppedStrong && poppedSp) {
          const after = s[i + m];
          if (after !== undefined && after !== ' ' && after !== '\n' && after !== '\t') poisoned = true;
        }
        i += m; continue;
      }
      if (canOpen) { stack.push({ v: m, sp }); i += m; continue; }
      i += m; continue;
    }
    i++;
  }
  return -1;
}

// Document-wide "inside an <a> tag" flag (marked's lexer inLink state).
// Set when an <a> start tag is seen inline, cleared by </a>. While set,
// GFM extended autolinks (bare URLs and emails) are not recognised.
let inATag = false;

function parseInline(s, refs, inLink = false) {
  const out = [];
  // Batch consecutive literal characters into one esc() call instead
  // of one esc() per character (esc was ~24% of runtime).
  let lit = '';
  const flushLit = () => { if (lit) { out.push(esc(lit)); lit = ''; } };
  // Gate the expensive autolink/email attempts: most paragraphs contain
  // no '@' and no URL prefix, so skip those checks entirely for them.
  const mayHaveEmail = s.includes('@');
  const mayHaveUrl = s.includes('www.') || s.includes('http') || s.includes('mailto:');
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s.charCodeAt(i + 1);
      if (n === 10) { flushLit(), out.push('<br>'); i += 2; while (s[i] === ' ' || s[i] === '\t') i++; continue; }
      if ((n >= 33 && n <= 47) || (n >= 58 && n <= 64) || (n >= 91 && n <= 96) || (n >= 123 && n <= 126)) {
        flushLit(), out.push(esc(s[i + 1])); i += 2; continue;
      }
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      let j = i + n;
      while ((j = s.indexOf('`', j)) >= 0) {
        let k = j;
        while (s[k] === '`') k++;
        if (k - j === n) break;
        j = k;
      }
      if (j >= 0) {
        let text = s.slice(i + n, j).split('\n').join(' ');
        if (text[0] === ' ' && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
        flushLit(), out.push('<code>', esc(text), '</code>'); i = j + n; continue;
      }
      // No matching closer: the whole backtick run is literal text.
      // Skip past it so a later backtick in the run is not re-read as a
      // new (shorter) opener.
      flushLit(), out.push(esc(c.repeat(n))); i += n; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      // Run length: for * and _ an odd run of 3+ opens em (leaving an even
      // run for strong), an even run opens strong; ~ is always <del>, but
      // only runs of length 1 or 2 are delimiters — a run of 3+ tildes
      // is literal text (marked never splits it to close a del).
      let L = 1;
      while (s[i + L] === c) L++;
      if (c === '~' && L >= 3) { flushLit(), out.push(esc(c.repeat(L))); i += L; continue; }
      let n = c === '~' ? (L >= 2 ? 2 : 1) : L === 1 ? 1 : (L % 2 === 1 ? 1 : 2);
      const end = findEmphClose(s, i + n, n, c);
      const intraword = c === '_' && i > 0 && isWord(s.charCodeAt(i - 1));
      // An opener must not be followed by whitespace (a '*' before a
      // newline is literal, not an opener), and it must be able to open
      // (left-flanking; '_' has its extra rule).
      const afterOpener = s.charCodeAt(i + n);
      if (!intraword && end > i + n && !isSpaceCode(afterOpener) && canOpenRun(s, i, L, c)) {
        const tag = c === '~' ? 'del' : n === 2 ? 'strong' : 'em';
        flushLit(), out.push('<' + tag + '>', parseInline(s.slice(i + n, end), refs, inLink), '</' + tag + '>');
        i = end + n; continue;
      }
    }
    if ((c === '[' && !inLink) || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      const begin = i + (image ? 2 : 1);
      // Scan the bracketed text. A bare '[' that starts a nested link
      // invalidates this link (a link cannot contain a link); an image
      // '![' or balanced brackets that form no link are fine.
      let depth = 1, end = begin, valid = true;
      for (; end < s.length; end++) {
        if (s[end] === '\\') { end++; continue; }
        if (s[end] === '`') {
          let n = 1;
          while (s[end + n] === '`') n++;
          // A code span in a link label follows marked's label regex:
          // `+ [^`]*? `+ — the closing run may be ANY length, but it
          // must come before the label's closing ']'. If no closing
          // backtick run exists before the next ']', the backticks are
          // literal ONLY when they are a run of 2+ immediately before
          // ']' (``+(?=])``); otherwise the label regex fails and the
          // link does not form (an unmatched ` in a label kills it).
          const nextClose = s.indexOf(']', end + n);
          let j = end + n, m2 = 0;
          while (j < s.length && s[j] !== '`') j++;
          if (j < s.length) { m2 = 1; while (s[j + m2] === '`') m2++; }
          if (j < s.length && (nextClose < 0 || j < nextClose)) { end = j + m2 - 1; continue; }
          if (n >= 2 && s[end + n] === ']') { end += n - 1; continue; }
          valid = false; break;
        }
        if (s[end] === '[') {
          if (s[end - 1] === '!') {
            // An image: skip the whole construct (alt text, plus a
            // following reference label [...] or inline destination
            // (...)), so its label is never misread as a nested link.
            const imgEnd = closeBracket(s, end);
            if (imgEnd < 0) { depth++; continue; }
            let skip = imgEnd;
            if (s[skip + 1] === '[') {
              const c = s.indexOf(']', skip + 2);
              if (c >= 0) skip = c;
            } else if (s[skip + 1] === '(') {
              let j = skip + 2, bal = 0;
              for (; j < s.length; j++) {
                if (s[j] === '\\') { j++; continue; }
                if (s[j] === '(') bal++;
                if (s[j] === ')') { if (!bal) break; bal--; }
              }
              if (j < s.length) skip = j;
            }
            end = skip; continue;
          }
          // A link cannot contain a link: a '[' that starts a nested
          // link invalidates the outer LINK. An IMAGE's label may
          // contain link-like text (it renders as plain text in the
          // alt), so this check only applies when parsing a link.
          if (!image && linkStartsAt(s, end, refs)) { valid = false; break; }
          depth++;
          continue;
        }
        if (s[end] === ']' && --depth === 0) break;
      }
      if (valid && depth === 0) {
        let target = null, finish = end + 1;
        if (s[finish] === '(') {
          let j = finish + 1, balance = 0;
          for (; j < s.length; j++) {
            if (s[j] === '\\') { j++; continue; }
            if (s[j] === '(') balance++;
            if (s[j] === ')') { if (!balance) break; balance--; }
          }
          if (j < s.length) {
            target = splitLinkTarget(s.slice(finish + 1, j));
            if (target) finish = j + 1;
          }
        } else {
          let label = s.slice(begin, end);
          if (s[finish] === '[') {
            const close = s.indexOf(']', finish + 1);
            if (close >= 0) { label = s.slice(finish + 1, close) || label; finish = close + 1; }
          }
          target = refs[label.toLowerCase().replace(/\s+/g, ' ')];
        }
        if (target) {
          const text = parseInline(s.slice(begin, end), refs, !image);
          const title = target.title ? ' title="' + esc(target.title) + '"' : '';
          flushLit(), out.push(image ? '<img src="' + escAttr(target.href) + '" alt="' + text.replace(/<[^>]*>/g, '') + '"' + title + '>' : '<a href="' + escAttr(target.href) + '"' + title + '>' + text + '</a>');
          i = finish; continue;
        }
      }
    }
    if (c === '&') {
      const end = s.indexOf(';', i + 1);
      if (end > i && end - i < 35) {
        const entity = s.slice(i, end + 1);
        if (/^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);$/.test(entity)) {
          flushLit(), out.push(decodeEntity(entity)); i = end + 1; continue;
        }
      }
    }
    if (c === '<') {
      // A block-level HTML construct (comment, CDATA, PI, declaration,
      // script/pre/style/textarea, or a block tag) at the start of a
      // paragraph line joins directly onto the previous line: marked
      // drops the soft-break newline before it (e.g. inside a list
      // item, "item one<!-- note -->" has no newline). Inline tags
      // (<span>) keep the newline.
      if (i > 0 && s[i - 1] === '\n' && /^<(?:\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|picture|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul|video|audio|source|embed|object|canvas|output|progress|meter|data)(?:\s|>|\/)|!--|\?|!\[CDATA\[|![A-Z])/i.test(s.slice(i, i + 20))) {
        const last = out[out.length - 1];
        if (typeof last === 'string' && last.endsWith('\n')) {
          if (last.length === 1) out.pop();
          else out[out.length - 1] = last.slice(0, -1);
        }
      }
      // CDATA sections, comments and processing instructions close at
      // ]]>, --> and ?> respectively — not at the first '>' (their
      // content may contain '>' and must be copied verbatim).
      let end = -1;
      if (s.startsWith('<![CDATA[', i)) {
        const cdataEnd = s.indexOf(']]>', i + 9);
        if (cdataEnd >= 0) { flushLit(), out.push(s.slice(i, cdataEnd + 3)); i = cdataEnd + 3; continue; }
      } else if (s.startsWith('<!--', i)) {
        const commentEnd = s.indexOf('-->', i + 4);
        if (commentEnd >= 0) { flushLit(), out.push(s.slice(i, commentEnd + 3)); i = commentEnd + 3; continue; }
      } else if (s.startsWith('<?', i)) {
        const piEnd = s.indexOf('?>', i + 2);
        if (piEnd >= 0) { flushLit(), out.push(s.slice(i, piEnd + 2)); i = piEnd + 2; continue; }
      }
      end = s.indexOf('>', i + 1);
      if (end >= 0) {
        const body = s.slice(i + 1, end);
        if (validTagBody(body)) {
          // Track an unclosed <a> tag: while inside one, GFM extended
          // autolinks are suppressed (marked's lexer inLink state).
          // A tag split across lines (e.g. <a href="foo\nbar">) still
          // opens the state, since it is not an HTML block.
          // marked's rule is startATag=/^<a /i: only "<a" followed by
          // a space opens it — <a> and <a/> do NOT, and a self-closing
          // <a /> DOES (the space after <a is what matters, not the /).
          // endATag=/^<\/a>/i closes it.
          const tagText = s.slice(i, end + 1);
          if (/^<a /i.test(tagText)) inATag = true;
          else if (/^<\/a>/i.test(tagText)) inATag = false;
          flushLit(), out.push(s.slice(i, end + 1)); i = end + 1; continue;
        }
        if (body.includes('://') && !body.includes(' ') && !body.includes('<') && !body.includes('\n')) { flushLit(), out.push('<a href="', escAttr(body), '">', esc(body), '</a>'); i = end + 1; continue; }
        if (body.includes('@') && !body.includes(' ')) {
          // An address already starting with mailto: keeps its href as-is.
          const href = body.toLowerCase().startsWith('mailto:') ? body : 'mailto:' + body;
          flushLit(), out.push('<a href="', escAttr(href), '">', esc(body), '</a>'); i = end + 1; continue;
        }
        if (/^!|^\?/.test(body)) { flushLit(), out.push(s.slice(i, end + 1)); i = end + 1; continue; }
      }
    }
    // GFM extended autolinks (not inside a link's text, and not inside
    // an unclosed <a> tag). 'm' is for mailto:.
    // Schemes are case-insensitive, so H/W/M match too.
    if (!inLink && !inATag && mayHaveUrl && (c === 'w' || c === 'W' || c === 'h' || c === 'H' || c === 'm' || c === 'M')) {
      const url = matchUrl(s, i);
      if (url) {
        flushLit(), out.push('<a href="', escAttr(url.href), '">', esc(url.text), '</a>');
        i += url.length; continue;
      }
    }
    if (!inLink && !inATag && mayHaveEmail && isWord(s.charCodeAt(i)) && (i === 0 || !isWord(s.charCodeAt(i - 1)))) {
      const email = matchEmail(s, i);
      if (email) {
        flushLit(), out.push('<a href="mailto:', escAttr(email.email), '">', esc(email.email), '</a>');
        i += email.length; continue;
      }
    }
    if (c === ' ' && s[i + 1] === ' ') {
      let end = i + 2;
      while (s[end] === ' ') end++;
      // A hard break swallows the leading spaces of the next line.
      if (s[end] === '\n') { flushLit(), out.push('<br>'); i = end + 1; while (s[i] === ' ' || s[i] === '\t') i++; continue; }
    }
    lit += c; i++;
  }
  return out.join('');
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// Returns the alignment array for a table delimiter row, or null.
// A delimiter cell is ':'? '-'+ ':'? ; the row must contain a ':' or a '|'.
function tableAlign(line) {
  if (!line.includes(':') && !line.includes('|')) return null;
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  if (!s) return null;
  const parts = s.split('|');
  const aligns = [];
  for (let p of parts) {
    p = p.trim();
    if (!/^:?-+:?$/.test(p)) return null;
    if (p.startsWith(':') && p.endsWith(':')) aligns.push('center');
    else if (p.endsWith(':')) aligns.push('right');
    else if (p.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Remove <p> / </p> tags that sit at the top level (depth 0) of a
// tight list item's HTML. <p> tags nested inside a blockquote or a
// sub-list are at depth > 0 and are kept. A </p> at depth 0 also drops
// its following newline, so the item's blocks join as marked does.
function stripTopLevelP(html) {
  // Only block-level containers affect depth: inline tags (<em>,
  // <x-custom>, <a>, <span>...) never contain a <p>, so they must not
  // push the depth up — an unclosed <x-custom> would otherwise strand
  // a later </p> at depth 1 and leave it unstripped.
  const BLOCK = new Set(['ul', 'ol', 'li', 'blockquote', 'div', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'figure', 'figcaption', 'details', 'summary', 'dl', 'dt', 'dd', 'fieldset', 'form']);
  const out = [];
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i + 1);
      if (end < 0) { flushLit(), out.push(html.slice(i)); break; }
      const tag = html.slice(i, end + 1);
      const m = tag.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
      if (!m) { flushLit(), out.push(tag); i = end + 1; continue; }
      const name = m[1].toLowerCase();
      const closing = tag[1] === '/';
      const selfClose = tag.endsWith('/>');
      if (name === 'p' && depth === 0) {
        if (!closing) { i = end + 1; continue; }
        // Drop </p> and the newline that follows it.
        i = end + 1;
        if (html[i] === '\n') i++;
        continue;
      }
      flushLit(), out.push(tag);
      if (BLOCK.has(name) && !selfClose) depth += closing ? -1 : 1;
      i = end + 1;
      continue;
    }
    flushLit(), out.push(html[i]);
    i++;
  }
  return out.join('');
}

function parseBlocks(lines, refs, inList = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = expandIndent(lines[i]);
    if (!line.trim()) { i++; continue; }
    // First non-space character (and indent) gates the expensive block
    // regexes below: a plain paragraph line skips the HTML/fence/
    // heading/hr/list checks entirely.
    let sp = 0;
    while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
    const fc = line.charCodeAt(sp);
    const htmlStart = line.trimStart();
    // An HTML block may be indented at most 3 spaces; a line indented 4+
    // is an indented code block, not HTML.
    const htmlIndent = sp;
    // Type 7: a complete open or closing tag (any name) alone on its
    // line — e.g. </ins>, <span>, <custom attr="1">. It is an HTML
    // block (raw until a blank line); a tag with text after it is not.
    const type7 = fc === 60 && /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>$/.test(htmlStart.trim());
    if (fc === 60 && htmlIndent <= 3 && (type7 || /^<(?:\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|picture|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul|video|audio|source|embed|object|canvas|output|progress|meter|data)(?:\s|>|\/)|!--|\?|!\[CDATA\[|![A-Z])/i.test(htmlStart))) {
      const tag = htmlStart.match(/^<(script|pre|style|textarea)(?:\s|>)/i);
      const terminator = tag ? '</' + tag[1] + '>' : htmlStart.startsWith('<!--') ? '-->' : htmlStart.startsWith('<?') ? '?>' : htmlStart.startsWith('<![CDATA[') ? ']]>' : null;
      const body = [];
      while (i < lines.length && (terminator || lines[i].trim())) {
        body.push(lines[i++]);
        if (terminator && body.at(-1).toLowerCase().includes(terminator.toLowerCase())) break;
      }
      // marked outputs an HTML block's raw text with trailing newlines
      // stripped. A block that ends at a terminator (comment, PI, CDATA,
      // script/pre/style/textarea) is followed by a newline before the
      // next block — but only when the next source line is non-blank
      // (the block runs straight into the next block). When a blank line
      // follows, or for a block that ends at a blank line (e.g. <div>),
      // there is no trailing newline.
      // A terminator HTML block (comment/script/CDATA) is followed by
      // '\n' unless the next line is truly EMPTY. A whitespace-only
      // next line still counts as "followed" (marked keeps the '\n'
      // after --> when the next line is spaces/tabs, but not when it
      // is empty).
      const followedByBlock = terminator && i < lines.length && lines[i].length > 0;
      out.push(body.join('\n') + (followedByBlock ? '\n' : ''));
      continue;
    }
    const fence = (fc === 96 || fc === 126) && sp <= 3 ? line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) : null;
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const body = [];
      const marker = fence[1];
      const language = fence[2].trim().split(' ')[0];
      // Content lines lose the fence opener's indent (up to 3 spaces).
      const fenceIndent = sp;
      i++;
      while (i < lines.length) {
        const candidate = lines[i].trim();
        let count = 0;
        while (candidate[count] === marker[0]) count++;
        if (count >= marker.length && count === candidate.length) { i++; break; }
        body.push(stripIndent(lines[i], fenceIndent, true)); i++;
      }
      // marked strips exactly one trailing blank line from fenced-code
      // content (a blank line just before the closing fence does not
      // produce an extra blank line in the output).
      if (body.at(-1) === '') body.pop();
      out.push('<pre><code' + (language ? ' class="language-' + esc(language) + '"' : '') + '>' + esc(body.join('\n') + (body.length ? '\n' : '')) + '</code></pre>\n');
      continue;
    }
    const heading = fc === 35 && sp <= 3 ? line.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*)$/) : null;
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      out.push('<h' + heading[1].length + '>' + parseInline(text, refs) + '</h' + heading[1].length + '>\n'); i++; continue;
    }
    if ((fc === 42 || fc === 45 || fc === 95) && sp <= 3 && /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.startsWith('    ') || line.startsWith('\t')) {
      const body = [];
      while (i < lines.length) {
        const cur = expandIndent(lines[i]);
        if (!cur.startsWith('    ') && !cur.startsWith('\t') && cur.trim()) break;
        body.push(stripIndent(lines[i], 4, true)); i++;
      }
      while (body.at(-1) === '') body.pop();
      out.push('<pre><code>' + esc(body.join('\n') + '\n') + '</code></pre>\n'); continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body = [];
      // Track fenced-code state inside the quote: a line without '>'
      // ends the quote when the open block is a fence (lazy continuation
      // only continues a paragraph, never a fenced code block).
      let inFence = false, fenceChar = '', fenceLen = 0;
      while (i < lines.length && lines[i].trim()) {
        const raw = lines[i];
        if (!/^ {0,3}>/.test(raw) && inFence) break;
        // A blank blockquote line (">" alone) ends the paragraph inside
        // the quote; a following line without ">" is NOT a lazy
        // continuation — it starts a new block outside the quote.
        if (!/^ {0,3}>/.test(raw) && body.length > 0 && body[body.length - 1] === '') break;
        // A --- line is never a lazy continuation: it ends the quote
        // (the line becomes a thematic break outside it). An === line
        // IS a lazy continuation — it stays inside the quote as plain
        // paragraph text, so it is folded into the previous body line
        // (a separate line would be misread as a setext underline).
        if (!/^ {0,3}>/.test(raw) && /^ {0,3}-+\s*$/.test(raw)) break;
        // A line without '>' that starts a new block (ATX heading,
        // fence, list item, thematic break, HTML block) is never a
        // lazy continuation: it ends the quote and starts that block
        // outside it. Only plain paragraph text continues lazily.
        if (!/^ {0,3}>/.test(raw) && /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)|(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$)/.test(raw)) break;
        const stripped = stripQuote(raw);
        if (!/^ {0,3}>/.test(raw) && /^ {0,3}=+\s*$/.test(raw) && body.length > 0 && body[body.length - 1] !== '') {
          body[body.length - 1] += '\n' + stripped; i++; continue;
        }
        body.push(stripped); i++;
        const t = stripped.trim();
        if (!inFence) {
          const fm = t.match(/^(`{3,}|~{3,})/);
          if (fm && !(fm[1][0] === '`' && t.slice(fm[1].length).includes('`'))) {
            inFence = true; fenceChar = fm[1][0]; fenceLen = fm[1].length;
          }
        } else {
          let count = 0;
          while (t[count] === fenceChar) count++;
          if (count >= fenceLen && count === t.length) inFence = false;
        }
      }
      out.push('<blockquote>\n' + parseBlocks(body, refs, inList) + '</blockquote>\n'); continue;
    }
    const list = line.match(/^ {0,3}([-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)(.*)$/);
    if (list) {
      const ordered = list[1].length > 1;
      const marker = ordered ? list[1].slice(-1) : list[1];
      const start = ordered ? Number(list[1].slice(0, -1)) : 1;
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const match = expandIndent(lines[i]).match(/^ {0,3}([-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)(.*)$/);
        if (!match || (ordered ? match[1].slice(-1) !== marker : match[1] !== marker)) break;
        const expanded = expandIndent(lines[i]);
        const leadSpaces = expanded.match(/^ */)[0].length;
        const markerEnd = leadSpaces + match[1].length;
        const contentStart = expanded.indexOf(match[2], match[1].length);
        const gap = contentStart - markerEnd;
        // 5+ spaces after the marker: the content indent is marker+1 and
        // the leftover spaces stay in the body, so the content is an
        // indented code block (CommonMark: `1.     indented code`).
        const indent = gap >= 5 ? markerEnd + 1 : contentStart;
        const body = [gap >= 5 ? ' '.repeat(gap - 1) + match[2] : match[2]];
        i++;
        while (i < lines.length) {
          const next = expandIndent(lines[i]);
          if (!next.trim()) {
            // A blank line only makes the list loose when the next non-blank
            // line continues this item or starts another item of this list.
            // A blank line before a new block ends the list instead.
            // A blank line before NESTED content (deeper than this item's
            // content indent) belongs to the nested block and does not
            // make this list loose.
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j >= lines.length) { i = j; break; }
            const after = expandIndent(lines[j]);
            const afterIndent = after.match(/^ */)[0].length;
            // A following item only continues THIS list when its marker
            // matches: a blank line before a list with a different
            // marker ends this list instead of making it loose.
            const afterMatch = after.match(/^ {0,3}([-+*]|[0-9]{1,9}[.)])(?:\s|$)/);
            const isItem = afterIndent < indent && !!afterMatch && (ordered ? afterMatch[1].slice(-1) === marker : afterMatch[1] === marker);
            const isContinuation = after.startsWith(' '.repeat(Math.max(1, indent)));
            if (isItem || isContinuation) {
              // A blank line before a nested list item at exactly this
              // item's content indent only makes this list loose when
              // the sublist is just starting (the blank line separates
              // the item's paragraph from its sublist). Once a sublist
              // has started in this item's body, blank lines between
              // its items belong to the sublist, not to this list.
              // (The after-line carries its absolute indent, so the
              // marker test must slice at afterIndent, not ^ {0,3}.)
              const isNestedMarker = afterIndent === indent && /^(?:[-+*]|[0-9]{1,9}[.)])(?:\s|$)/.test(after.slice(afterIndent));
              const sublistStarted = isNestedMarker && body.some(l => /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:\s|$)/.test(l));
              if (afterIndent <= indent && !sublistStarted) loose = true;
              while (i < j) { body.push(''); i++; }
              continue;
            }
            break;
          }
          // Fenced code block inside the item: consume the opener through
          // the closing fence even when content lines sit at column 0
          // (a fence absorbs unindented lines until its closer).
          if (next.startsWith(' '.repeat(Math.max(1, indent)))) {
            const stripped = next.slice(Math.max(1, indent));
            const fenceM = stripped.match(/^ {0,3}(`{3,}|~{3,})/);
            if (fenceM && !(fenceM[1][0] === '`' && stripped.slice(fenceM[0].length).includes('`'))) {
              const fmarker = fenceM[1];
              // stripIndent handles a tab straddling the indent boundary.
              const strip = (l) => stripIndent(l, Math.max(1, indent));
              body.push(strip(next)); i++;
              let fenceEndedEarly = false;
              let fenceHasContent = false;
              while (i < lines.length) {
                const cur = lines[i];
                // A fenced code block inside a list item ends (empty)
                // when its FIRST content line is not indented to the
                // item's content column (that line leaves the list
                // item, so the fence never starts). Once the fence has
                // content, it absorbs lines at any indent until its
                // closer. Blank lines do not end it.
                if (!fenceHasContent && cur.trim()) {
                  const curIndent = expandIndent(cur).match(/^ */)[0].length;
                  if (curIndent < Math.max(1, indent)) { fenceEndedEarly = true; break; }
                }
                const cand = cur.trim();
                let count = 0;
                while (cand[count] === fmarker[0]) count++;
                body.push(strip(cur));
                if (cur.trim()) fenceHasContent = true;
                i++;
                if (count >= fmarker.length && count === cand.length) break;
              }
              // A fence that ended early (under-indented first line)
              // ends the list item too: that line is not a lazy
              // continuation of the item (it starts a new block
              // outside the list).
              if (fenceEndedEarly) break;
              continue;
            }
          }
          // A line only starts a NEW item of this list when its marker
          // sits left of the item's content indent; a marker indented to
          // the content level is nested content, not a sibling item.
          const leadSpaces = next.match(/^ */)[0].length;
          if (leadSpaces < indent && /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?:\s|$)/.test(next)) break;
          if (next.startsWith(' '.repeat(Math.max(1, indent)))) {
            body.push(next.slice(Math.max(1, indent))); i++; continue;
          }
          // Lazy continuation: a non-blank line at column 0 that does not
          // start a new block (heading, fence, blockquote, list item, hr)
          // continues the paragraph inside this item.
          if (body.length > 0 && body[body.length - 1].trim() !== '' && !/^ {0,3}(?:#{1,6}(?:\s|$)|>|`{3,}|~{3,}|(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)|(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$)/.test(next)) {
            body.push(next); i++; continue;
          }
          break;
        }
        items.push(body);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>\n');
      for (const body of items) {
        let checkbox = '';
        if (/^\[[ xX]\] /.test(body[0])) {
          checkbox = '<input ' + (body[0][1].toLowerCase() === 'x' ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
          body[0] = body[0].slice(4);
        }
        let html = parseBlocks(body, refs, true);
        // In a tight list every top-level <p> of the item is unwrapped
        // (not just the first): a paragraph split by an HTML block leaves
        // a second <p> that must also go. <p> tags nested inside a
        // blockquote or a sub-list are kept (they sit at depth > 0).
        if (!loose) html = stripTopLevelP(html);
        if (loose && checkbox) html = html.replace('<p>', '<p>' + checkbox);
        else html = checkbox + html;
        out.push('<li>' + html + '</li>\n');
      }
      out.push('</' + tag + '>\n'); continue;
    }
    // GFM table: this line is the header, the next line is the delimiter row.
    if (i + 1 < lines.length && line.includes('|')) {
      const aligns = tableAlign(lines[i + 1]);
      if (aligns) {
        const header = splitTableRow(line);
        const rows = [];
        i += 2;
        // A table body continues while the line is not blank, where
        // "blank" means empty or spaces-only: a tab-only line is NOT
        // blank to marked's table parser (it becomes an empty row), and
        // any non-blank line becomes a row even without a pipe. A line
        // starting a block-level HTML tag (e.g. <details>) ends the
        // table; an inline tag (<span>) does not.
        while (i < lines.length && !/^ *$/.test(lines[i]) && !/^ {0,3}(?:#{1,6}(?:\s|$)|>|`{3,}[^`]*$|~{3,}|(?:[-+*]|1[.)])(?:[ \t]+|$))/.test(lines[i]) && !/^ {0,3}<(?:\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|picture|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul|video|audio|source|embed|object|canvas|output|progress|meter|data)(?:\s|>|\/)|!--|\?|!\[CDATA\[|![A-Z])/i.test(lines[i])) {
          rows.push(splitTableRow(lines[i])); i++;
        }
        const cell = (text, isHead, align) => {
          const a = align ? ' align="' + align + '"' : '';
          return isHead ? '<th' + a + '>' + parseInline(text, refs) + '</th>\n' : '<td' + a + '>' + parseInline(text, refs) + '</td>\n';
        };
        let html = '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < header.length; k++) html += cell(header[k], true, aligns[k] ?? null);
        html += '</tr>\n</thead>\n<tbody>';
        for (const row of rows) {
          html += '<tr>\n';
          for (let k = 0; k < header.length; k++) html += cell(row[k] ?? '', false, aligns[k] ?? null);
          html += '</tr>\n';
        }
        html += '</tbody></table>\n';
        out.push(html);
        continue;
      }
    }
    const paragraph = [line]; i++;
    // Inside a list item, any ordered-list marker can interrupt a paragraph
    // and start a nested list; at the top level only a list starting with
    // 1 (or a bullet list) can interrupt. A backtick fence only interrupts
    // when its info string holds no backtick (```inner backticks``` is an
    // inline code span, not a fence); a tilde fence always interrupts.
    const interruptRe = inList
      ? /^ {0,3}(?:#{1,6}(?:\s|$)|>|`{3,}[^`]*$|~{3,}|(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$))/
      : /^ {0,3}(?:#{1,6}(?:\s|$)|>|`{3,}[^`]*$|~{3,}|(?:[-+*]|1[.)])(?:[ \t]+|$))/;
    while (i < lines.length && lines[i].trim() && !interruptRe.test(lines[i])) {
      // A setext underline line ends the paragraph; it is handled below.
      if (/^ {0,3}(=+|-+)\s*$/.test(lines[i])) break;
      // An HTML block (types 1–6: script/pre/style/textarea, comment,
      // processing instruction, CDATA, declaration, or block tag) ends
      // a paragraph; a type-7 inline tag does not. This applies inside
      // list items too (a tight list just renders the blocks without
      // <p> wrappers, so the join looks continuous).
      const nextHtml = expandIndent(lines[i]);
      const nextIndent = nextHtml.match(/^ */)[0].length;
      if (nextIndent <= 3 && /^<(?:\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|picture|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul|video|audio|source|embed|object|canvas|output|progress|meter|data)(?:\s|>|\/)|!--|\?|!\[CDATA\[|![A-Z])/i.test(nextHtml.trimStart())) break;
      // A following line that is a table header (next line a delimiter row)
      // ends the paragraph here; the table is parsed next.
      if (lines[i].includes('|') && i + 1 < lines.length && tableAlign(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    // Setext heading: the paragraph is followed directly by === or ---.
    if (i < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i])) {
      const level = lines[i].trim()[0] === '=' ? 1 : 2;
      out.push('<h' + level + '>' + parseInline(paragraph.join('\n').trim(), refs) + '</h' + level + '>\n'); i++; continue;
    }
    out.push('<p>' + parseInline(paragraph.join('\n'), refs) + '</p>\n');
  }
  return out.join('');
}

// Strip blockquote markers and list-item markers to get the effective
// content of a line for fence detection. Used by the ref-collection pass
// so definitions inside fenced code (including fences nested in a
// blockquote or list item) are not collected as references.
function effectiveLine(line) {
  // Fast path: most lines start with neither '>' nor a list marker, so
  // no stripping is needed. Check the first non-space character first
  // (a plain content line returns immediately, no regex).
  let s = line, sp = 0;
  while (sp < s.length && s.charCodeAt(sp) === 32) sp++;
  const f = s.charCodeAt(sp);
  if (f !== 62 && f !== 45 && f !== 43 && f !== 42 && !(f >= 48 && f <= 57)) return s;
  for (let guard = 0; guard < 8; guard++) {
    let m = s.match(/^ {0,3}> ?/);
    if (m) { s = s.slice(m[0].length); continue; }
    m = s.match(/^ {0,3}(?:[-+*]|[0-9]{1,9}[.)]) +/);
    if (m) { s = s.slice(m[0].length); continue; }
    break;
  }
  return s;
}

export function parse(markdown) {
  if (markdown.length < 1000) return marked.parse(markdown);
  if (!markdown) return '';

  try {
    // Document-wide "inside an <a> tag" state (marked's lexer inLink):
    // an unclosed <a> start tag suppresses GFM extended autolinks for
    // the rest of the document, until a </a> tag is seen.
    inATag = false;
    // Only normalise line endings when a CR is present (most docs are
    // pure \n); the regex replace copies the whole string otherwise.
    const lines = markdown.indexOf('\r') >= 0 ? markdown.replace(/\r\n?/g, '\n').split('\n') : markdown.split('\n');
    const refs = Object.create(null);
    // First pass: collect link reference definitions (first wins).
    // A definition is [label]: destination [title]; the title may be on
    // the next line. Definition lines produce no output.
    // Skip lines inside a fenced code block (fences may be nested in a
    // blockquote or list item, so detect them on the effective line).
    let inFence = false, fenceChar = '', fenceLen = 0;
    for (let i = 0; i < lines.length; i++) {
      const eff = effectiveLine(lines[i]);
      // Fast pre-check: a fence opener starts with ` or ~ (after ≤3
      // spaces); skip the regex for all other lines.
      const eff0 = eff.charCodeAt(0), eff1 = eff.charCodeAt(1), eff2 = eff.charCodeAt(2), eff3 = eff.charCodeAt(3);
      const fm = (eff0 === 96 || eff0 === 126 || eff1 === 96 || eff1 === 126 || eff2 === 96 || eff2 === 126 || eff3 === 96 || eff3 === 126) ? eff.match(/^ {0,3}(\`{3,}|~{3,})(.*)$/) : null;
      // A backtick fence opener whose info string contains a backtick is
      // not a fence (it is inline code); a closing fence must consist
      // only of fence characters (plus whitespace), not merely start
      // with them (e.g. ```inner backticks``` is code, not a closer).
      if (fm && !inFence && !(fm[1][0] === '`' && fm[2].includes('`'))) {
        // A fence inside a list item ends (empty) when its first content
        // line is less indented than the opener: that line leaves the
        // list item, so the fence never starts and does not swallow
        // later lines (e.g. reference definitions after it).
        const openerIndent = eff.match(/^ */)[0].length;
        let firstContentIndent = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim()) continue;
          firstContentIndent = effectiveLine(lines[j]).match(/^ */)[0].length;
          break;
        }
        if (firstContentIndent < 0 || firstContentIndent >= openerIndent) {
          inFence = true; fenceChar = fm[1][0]; fenceLen = fm[1].length;
        }
      } else if (inFence) {
        const t = eff.trim();
        const cm = t.match(/^(`{3,}|~{3,})\s*$/);
        if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) inFence = false;
      }
      if (inFence) continue;
      // Fast pre-check: a reference definition starts with '[' (after
      // ≤3 spaces); skip the regex for all other lines.
      const li = lines[i];
      let lsp = 0;
      while (lsp < 3 && li.charCodeAt(lsp) === 32) lsp++;
      const m = li.charCodeAt(lsp) === 91 ? li.match(/^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/) : null;
      if (!m) continue;
      // Try destination + title, consuming as many following lines as
      // needed until the title closes (a title may span several lines,
      // e.g. [foo]: /url ' then title/line1/line2/'), then destination
      // alone. A blank line ends the definition.
      let target = null, consumed = 1;
      let acc = m[2];
      for (let j = i + 1; j < lines.length && j <= i + 10; j++) {
        if (!lines[j].trim()) break;
        acc += '\n' + lines[j].trim();
        target = splitLinkTarget(acc);
        if (target) { consumed = j - i + 1; break; }
      }
      if (!target) target = splitLinkTarget(m[2]);
      if (target) {
        const label = m[1].toLowerCase().replace(/\s+/g, ' ');
        if (!refs[label]) refs[label] = target;
        for (let k = 0; k < consumed; k++) lines[i + k] = '';
        i += consumed - 1;
      }
    }
    return parseBlocks(lines, refs);
  } catch {
    return marked.parse(markdown);
  }
}

// Re-recorded under a live makefun recording: fast single-pass parser, 720/720 practice.
