// parseScriptMeta: read the `meta` literal of a Dynamic Workflow script WITHOUT executing it.
//
// A workflow script starts with a pure-literal declaration such as
//   export const meta = { name: 'x', description: '...', phases: [{ title: 'A', detail: 'b' }] }
// This module finds that declaration at the top level of the script (ignoring look-alikes in
// comments, strings, template literals, regex literals and nested scopes) and evaluates only
// the literal subset of JavaScript: objects, arrays, strings (single, double, template without
// ${}), numbers, true/false/null, comments, trailing commas, unquoted keys and `'a' + 'b'`
// string concatenation. Anything else (identifiers, calls, spread, computed keys,
// interpolation, a member access or operator after the closing brace) makes the result null:
// the script is never run and nothing is guessed.
//
// Result: the parsed object as-is. Fields the script does not declare stay absent
// (`phases` is not defaulted to []), and unknown fields are kept.

const MAX_DEPTH = 64;

/** @returns {object | null} the parsed meta literal, or null when it is missing or not a pure literal */
export function parseScriptMeta(text) {
  if (typeof text !== 'string') return null;
  try {
    const code = maskNonCode(text);
    const decl = /(?:\bexport\s+)?\bconst\s+meta\s*=/g;
    // Only a declaration at nesting level 0 is the script's meta: a `const meta` inside a
    // function or block belongs to that scope. Nesting is counted on the masked code, where
    // strings, comments, templates and regex literals no longer contain brackets.
    let nest = 0;
    let pos = 0;
    for (let m = decl.exec(code); m; m = decl.exec(code)) {
      for (; pos < m.index; pos++) {
        const ch = code.charCodeAt(pos);
        if (ch === 0x7b || ch === 0x28 || ch === 0x5b) nest++;       // { ( [
        else if (ch === 0x7d || ch === 0x29 || ch === 0x5d) nest--;  // } ) ]
      }
      if (nest !== 0) continue;
      const p = new Parser(text, m.index + m[0].length);
      const value = p.parseExpression(0);
      p.expectStatementEnd();
      return isPlainObject(value) ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Words after which a `/` starts a regular expression, not a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function isIdentChar(code) {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f || code === 0x24 || (code > 0x7f && code !== 0xa0 && code !== 0x2028 && code !== 0x2029 && code !== 0xfeff);
}

const isLineBreak = (ch) => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ';

// Replace comments and the contents of string, template and regex literals with spaces (same
// length, so indexes line up with the original) so a regex over the result only sees real code.
//
// One pass, no recursion: template literals nest through `${ ... }`, and the depth comes from
// the input, so it lives in an explicit stack instead of the call stack.
function maskNonCode(text) {
  const n = text.length;
  const out = new Array(n);
  const blank = (i) => { out[i] = text[i] === '\n' ? '\n' : ' '; };

  // Frames, innermost last. { tmpl: true }: the text of a template literal.
  // { tmpl: false, expr, braces, regexOk }: code (the script, or the inside of a `${ }`);
  // `regexOk` tells whether a `/` here starts a regular expression (true after an operator or
  // punctuation, false after a name, number, literal or closing bracket).
  const stack = [{ tmpl: false, expr: false, braces: 0, regexOk: true }];
  let f = stack[0];
  let regexGaveUpUntil = -1; // a regex scan that found no end on its line is not repeated on that line

  // End index (exclusive, flags included) of the regex literal that starts at `start`, or -1.
  // A regex literal never spans lines; `/` inside a [...] class does not end it.
  function regexEnd(start) {
    let inClass = false;
    for (let j = start + 1; j < n; j++) {
      const ch = text[j];
      if (isLineBreak(ch)) { regexGaveUpUntil = j; return -1; }
      if (ch === '\\') {
        if (j + 1 < n && isLineBreak(text[j + 1])) { regexGaveUpUntil = j; return -1; }
        j++;
      } else if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '/') {
        let k = j + 1;
        while (k < n && isIdentChar(text.charCodeAt(k))) k++;
        return k;
      }
    }
    regexGaveUpUntil = n;
    return -1;
  }

  let i = 0;
  while (i < n) {
    const c = text[i];

    if (f.tmpl) {
      if (c === '\\' && i + 1 < n) { blank(i); blank(i + 1); i += 2; }
      else if (c === '`') {
        blank(i); i++;
        stack.pop();
        f = stack[stack.length - 1];
        f.regexOk = false;
      } else if (c === '$' && text[i + 1] === '{') {
        blank(i); blank(i + 1); i += 2;
        f = { tmpl: false, expr: true, braces: 0, regexOk: true };
        stack.push(f);
      } else { blank(i); i++; }
      continue;
    }

    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { blank(i); i++; }
    } else if (c === '/' && d === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
    } else if (c === '"' || c === "'") {
      blank(i); i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) { blank(i); i++; }
        blank(i); i++;
      }
      if (i < n && text[i] === c) { blank(i); i++; }
      f.regexOk = false;
    } else if (c === '`') {
      blank(i); i++;
      f = { tmpl: true };
      stack.push(f);
    } else if (c === '/') {
      const end = f.regexOk && i >= regexGaveUpUntil ? regexEnd(i) : -1;
      if (end > 0) {
        for (; i < end; i++) blank(i);
        f.regexOk = false;
      } else { // division
        out[i] = c; i++;
        f.regexOk = true;
      }
    } else if (f.expr && c === '{') {
      f.braces++; out[i] = c; i++;
      f.regexOk = true;
    } else if (f.expr && c === '}') {
      if (f.braces === 0) { // end of the `${ }`: back to the template text
        out[i] = ' '; i++;
        stack.pop();
        f = stack[stack.length - 1];
      } else {
        f.braces--; out[i] = c; i++;
        f.regexOk = true;
      }
    } else if (isIdentChar(text.charCodeAt(i))) {
      let j = i + 1;
      while (j < n && isIdentChar(text.charCodeAt(j))) j++;
      for (let k = i; k < j; k++) out[k] = text[k];
      f.regexOk = REGEX_AFTER_WORD.has(text.slice(i, j));
      i = j;
    } else if ((c === '+' || c === '-') && d === c) { // `a++ / 2`: a postfix operator ends an operand
      out[i] = c; out[i + 1] = d; i += 2;
      f.regexOk = false;
    } else {
      out[i] = c; i++;
      if (c === ')' || c === ']') f.regexOk = false;
      else if (!/\s/.test(c)) f.regexOk = true;
    }
  }
  return out.join('');
}

const NUMBER_RE = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const CONTINUING_WORD_RE = /(?:in|instanceof)(?![A-Za-z0-9_$])/y;

class Parser {
  constructor(text, index) {
    this.t = text;
    this.i = index;
    this.nl = false;      // skipTrivia saw a line break (set by it, cleared by the caller)
    this.valueEnd = index; // end of the last value parsed by parseExpression
  }

  fail(why) {
    throw new SyntaxError(`${why} at ${this.i}`);
  }

  skipTrivia() {
    const t = this.t;
    for (;;) {
      const c = t[this.i];
      if (c === undefined) return;
      if (/\s|﻿/.test(c)) {
        if (isLineBreak(c)) this.nl = true;
        this.i++;
        continue;
      }
      if (c === '/' && t[this.i + 1] === '/') {
        while (this.i < t.length && t[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && t[this.i + 1] === '*') {
        const end = t.indexOf('*/', this.i + 2);
        if (end < 0) this.fail('unterminated comment');
        if (/[\n\r\u2028\u2029]/.test(t.slice(this.i + 2, end))) this.nl = true;
        this.i = end + 2;
        continue;
      }
      return;
    }
  }

  // After the initializer the declaration must end: `;`, end of input, `,` (the next declarator),
  // `}`, or a line break where automatic semicolon insertion applies. Anything else continues
  // the expression (`{...}.name`, `{...} && f()`, `{...}\n(g())`): a value computed at run time,
  // not a pure literal.
  expectStatementEnd() {
    this.i = this.valueEnd; // look at the gap after the value again, this time noting line breaks
    this.nl = false;
    this.skipTrivia();
    const t = this.t;
    const c = t[this.i];
    if (c === undefined || c === ';' || c === ',' || c === '}') return;
    if (!this.nl) this.fail('the initializer continues after the literal');
    // A line break ends the statement unless the next token can continue the expression.
    if ('.([`+-*/%&|^<>=?'.includes(c) || (c === '!' && t[this.i + 1] === '=')) this.fail('the initializer continues on the next line');
    CONTINUING_WORD_RE.lastIndex = this.i;
    if (CONTINUING_WORD_RE.test(t)) this.fail('the initializer continues on the next line');
  }

  // value ( '+' value )*  -- only string concatenation is allowed
  parseExpression(depth) {
    let left = this.parseValue(depth);
    for (;;) {
      this.valueEnd = this.i;
      this.skipTrivia();
      if (this.t[this.i] !== '+') return left;
      if (typeof left !== 'string') this.fail('+ needs strings');
      this.i++;
      const right = this.parseValue(depth);
      if (typeof right !== 'string') this.fail('+ needs strings');
      left += right;
    }
  }

  parseValue(depth) {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    this.skipTrivia();
    const c = this.t[this.i];
    if (c === undefined) this.fail('unexpected end');
    if (c === '{') return this.parseObject(depth);
    if (c === '[') return this.parseArray(depth);
    if (c === '"' || c === "'") return this.parseString(c);
    if (c === '`') return this.parseTemplate();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.parseNumber();
    IDENT_RE.lastIndex = this.i;
    const id = IDENT_RE.exec(this.t);
    if (id) {
      this.i += id[0].length;
      if (id[0] === 'true') return true;
      if (id[0] === 'false') return false;
      if (id[0] === 'null') return null;
    }
    return this.fail('not a literal');
  }

  parseObject(depth) {
    const obj = {};
    this.i++; // {
    for (;;) {
      this.skipTrivia();
      const c = this.t[this.i];
      if (c === '}') { this.i++; return obj; }
      let key;
      if (c === '"' || c === "'") key = this.parseString(c);
      else if (c === undefined) this.fail('unterminated object');
      else {
        IDENT_RE.lastIndex = this.i;
        const id = IDENT_RE.exec(this.t);
        if (id) { key = id[0]; this.i += key.length; }
        else if ((c >= '0' && c <= '9')) key = String(this.parseNumber());
        else this.fail('bad object key');
      }
      this.skipTrivia();
      if (this.t[this.i] !== ':') this.fail('expected ":" (shorthand, methods and computed keys are not literals)');
      this.i++;
      const value = this.parseExpression(depth + 1);
      // defineProperty so a "__proto__" key becomes an own property instead of changing the prototype
      Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
      this.skipTrivia();
      const sep = this.t[this.i];
      if (sep === ',') { this.i++; continue; }
      if (sep === '}') { this.i++; return obj; }
      this.fail('expected "," or "}"');
    }
  }

  parseArray(depth) {
    const arr = [];
    this.i++; // [
    for (;;) {
      this.skipTrivia();
      const c = this.t[this.i];
      if (c === ']') { this.i++; return arr; }
      if (c === ',') this.fail('array holes are not supported');
      arr.push(this.parseExpression(depth + 1));
      this.skipTrivia();
      const sep = this.t[this.i];
      if (sep === ',') { this.i++; continue; }
      if (sep === ']') { this.i++; return arr; }
      this.fail('expected "," or "]"');
    }
  }

  parseNumber() {
    let sign = 1;
    if (this.t[this.i] === '-') { sign = -1; this.i++; }
    else if (this.t[this.i] === '+') this.i++;
    this.skipTrivia();
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.t);
    if (!m) this.fail('bad number');
    this.i += m[0].length;
    const v = Number(m[0]);
    if (Number.isNaN(v)) this.fail('bad number');
    return sign * v;
  }

  parseString(quote) {
    const t = this.t;
    this.i++; // opening quote
    let out = '';
    for (;;) {
      const c = t[this.i];
      if (c === undefined || c === '\n' || c === '\r') this.fail('unterminated string');
      if (c === quote) { this.i++; return out; }
      if (c === '\\') { out += this.parseEscape(); continue; }
      out += c;
      this.i++;
    }
  }

  parseTemplate() {
    const t = this.t;
    this.i++; // opening backtick
    let out = '';
    for (;;) {
      const c = t[this.i];
      if (c === undefined) this.fail('unterminated template');
      if (c === '`') { this.i++; return out; }
      if (c === '$' && t[this.i + 1] === '{') this.fail('template interpolation is not a literal');
      if (c === '\\') { out += this.parseEscape(); continue; }
      if (c === '\r') { // a template literal cooks CR LF and a lone CR to LF
        this.i++;
        if (t[this.i] === '\n') this.i++;
        out += '\n';
        continue;
      }
      out += c;
      this.i++;
    }
  }

  // At a backslash. Returns the cooked text and advances past the escape.
  parseEscape() {
    const t = this.t;
    this.i++; // backslash
    const c = t[this.i];
    if (c === undefined) this.fail('bad escape');
    this.i++;
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '\n': case ' ': case ' ': return '';
      case '\r': if (t[this.i] === '\n') this.i++; return '';
      case '0':
        if (t[this.i] >= '0' && t[this.i] <= '9') this.fail('octal escapes are not supported');
        return '\0';
      case 'x': {
        const hex = t.slice(this.i, this.i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('bad \\x escape');
        this.i += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (t[this.i] === '{') {
          const end = t.indexOf('}', this.i);
          const hex = end < 0 ? '' : t.slice(this.i + 1, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) this.fail('bad \\u{} escape');
          this.i = end + 1;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        const hex = t.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('bad \\u escape');
        this.i += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        if (c >= '1' && c <= '9') this.fail('octal escapes are not supported');
        return c; // \' \" \\ \` \/ and any other escaped character stand for themselves
    }
  }
}
