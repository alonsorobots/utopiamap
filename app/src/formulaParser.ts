// ── Token types ──────────────────────────────────────────────────────

export interface Token {
  type: 'number' | 'ident' | 'op' | 'paren' | 'space';
  text: string;
  start: number;
  end: number;
}

// ── AST node types ───────────────────────────────────────────────────

export type ASTNode =
  | { type: 'number'; value: number }
  | { type: 'ident'; name: string }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: ASTNode; right: ASTNode }
  | { type: 'unary'; op: '-'; child: ASTNode };

// ── Tokenizer ────────────────────────────────────────────────────────

const TOKEN_RE = /(\d+\.?\d*|\.\d+)|([a-zA-Z_]\w*)|([+\-*/])|([()])|(\s+)/g;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = TOKEN_RE.exec(input)) !== null) {
    const text = m[0];
    const start = m.index;
    const end = start + text.length;

    if (m[1]) tokens.push({ type: 'number', text, start, end });
    else if (m[2] && text.toLowerCase() === 'x') tokens.push({ type: 'op', text: '*', start, end });
    else if (m[2]) tokens.push({ type: 'ident', text, start, end });
    else if (m[3]) tokens.push({ type: 'op', text, start, end });
    else if (m[4]) tokens.push({ type: 'paren', text, start, end });
    else if (m[5]) tokens.push({ type: 'space', text, start, end });
  }

  return tokens;
}

// ── Axis aliases ─────────────────────────────────────────────────────

// Single-letter aliases for axes. Keep these in sync with HOTKEYS in
// App.tsx so any axis hotkey also works as a formula identifier
// (e.g. pressing "i" switches to internet AND typing "i" in the
// formula bar resolves to the inet axis). Lookup is case-insensitive
// because identifier text is lowercased before this table is queried.
const ALIASES: Record<string, string> = {
  t: 'temp', v: 'tvar', w: 'water', s: 'solar', n: 'wind',
  e: 'energy', a: 'agri', z: 'agrip', p: 'pop', g: 'gdp', c: 'cost',
  q: 'air', l: 'elev', k: 'risk', d: 'draw',
  i: 'inet', x: 'depv', h: 'hcare', m: 'travel', o: 'vista', f: 'free',
};

// Resolve a raw identifier (case-insensitive) into its canonical axis
// name. "T" -> "temp", "Temp" -> "temp", "water" -> "water".
export function resolveAxisAlias(text: string): string {
  const lower = text.toLowerCase();
  return ALIASES[lower] ?? lower;
}

// ── Recursive descent parser ─────────────────────────────────────────
//
// Grammar:
//   expr    = term (('+' | '-') term)*
//   term    = unary (('*' | '/') unary)*
//   unary   = '-' unary | primary
//   primary = NUMBER | IDENT | '(' expr ')'

export interface ParseResult {
  ast: ASTNode;
  axes: Set<string>;
}

export function parse(input: string): ParseResult {
  const allTokens = tokenize(input);
  const tokens = allTokens.filter((t) => t.type !== 'space');
  const axes = new Set<string>();
  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }

  function expect(type: Token['type'], text?: string): Token {
    const t = peek();
    if (!t) throw new Error(`Unexpected end of expression`);
    if (t.type !== type || (text !== undefined && t.text !== text))
      throw new Error(`Expected ${text ?? type} at position ${t.start}, got "${t.text}"`);
    return advance();
  }

  function parseExpr(): ASTNode {
    let node = parseTerm();
    while (peek()?.type === 'op' && (peek()!.text === '+' || peek()!.text === '-')) {
      const op = advance().text as '+' | '-';
      node = { type: 'binary', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm(): ASTNode {
    let node = parseUnary();
    while (peek()?.type === 'op' && (peek()!.text === '*' || peek()!.text === '/')) {
      const op = advance().text as '*' | '/';
      node = { type: 'binary', op, left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary(): ASTNode {
    if (peek()?.type === 'op' && peek()!.text === '-') {
      advance();
      return { type: 'unary', op: '-', child: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): ASTNode {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');

    if (t.type === 'number') {
      advance();
      return { type: 'number', value: parseFloat(t.text) };
    }

    if (t.type === 'ident') {
      advance();
      // Identifiers are case-insensitive: 'Temp', 'TEMP' and 'temp' all
      // resolve to the same axis. Aliases ('t' -> 'temp') are keyed
      // lowercase in ALIASES so we just normalize before lookup.
      const lower = t.text.toLowerCase();
      const resolved = ALIASES[lower] ?? lower;
      axes.add(resolved);
      return { type: 'ident', name: resolved };
    }

    if (t.type === 'paren' && t.text === '(') {
      advance();
      const node = parseExpr();
      expect('paren', ')');
      return node;
    }

    throw new Error(`Unexpected token "${t.text}" at position ${t.start}`);
  }

  if (tokens.length === 0) throw new Error('Empty expression');

  const ast = parseExpr();

  if (pos < tokens.length) {
    const leftover = tokens[pos];
    throw new Error(`Unexpected token "${leftover.text}" at position ${leftover.start}`);
  }

  return { ast, axes };
}

// ── GLSL emitter ─────────────────────────────────────────────────────

function emitNode(node: ASTNode): string {
  switch (node.type) {
    case 'number': {
      const s = node.value.toString();
      return s.includes('.') ? s : s + '.0';
    }
    case 'ident':
      return `f_${node.name}`;
    case 'unary':
      return `(-${emitNode(node.child)})`;
    case 'binary':
      return `(${emitNode(node.left)} ${node.op} ${emitNode(node.right)})`;
  }
}

export function emitGLSL(ast: ASTNode): string {
  return emitNode(ast);
}

// ── Convenience: parse + emit in one call ────────────────────────────

export interface FormulaCompileResult {
  glsl: string;
  axes: Set<string>;
}

export function compileFormula(input: string): FormulaCompileResult {
  const { ast, axes } = parse(input);
  return { glsl: emitGLSL(ast), axes };
}
