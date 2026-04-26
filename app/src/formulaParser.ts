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
//
// Every alias here resolves to a real axis id at parse time, which means
// the formula bar's autocomplete can safely suggest any of these words --
// hitting Tab won't produce an "unknown identifier" error. Two flavours:
//
//   1. Single-letter hotkeys -- keep in sync with HOTKEYS in App.tsx so
//      any axis hotkey also works as a formula identifier (e.g. "i" -> inet).
//   2. Natural-language aliases for users who don't know our short ids
//      ("earthquake" -> risk, "rainfall" -> water, "nuclear" -> e_nuke).
//
// Lookup is case-insensitive (identifier text is lowercased before
// querying). Add multi-char aliases liberally; they only cost a hash slot
// and make the formula bar feel a lot more like a real search box.

export const ALIASES: Record<string, string> = {
  // 1) Single-char hotkeys (kept short on purpose -- not surfaced in autocomplete)
  t: 'temp', v: 'tvar', w: 'water', s: 'solar', n: 'wind',
  e: 'energy', a: 'agri', z: 'agrip', p: 'pop', g: 'gdp', c: 'cost',
  q: 'air', l: 'elev', k: 'risk', d: 'draw',
  i: 'inet', x: 'depv', h: 'hcare', m: 'travel', o: 'vista', f: 'free',

  // 2) Natural-language aliases
  temperature: 'temp', warmth: 'temp', cold: 'temp', heat: 'temp',
  volatility: 'tvar', seasonality: 'tvar', seasons: 'tvar',
  precipitation: 'water', rain: 'water', rainfall: 'water', wet: 'water',
  sunshine: 'solar', sun: 'solar', irradiance: 'solar',
  windspeed: 'wind', breeze: 'wind',
  population: 'pop', density: 'pop', people: 'pop', crowd: 'pop',
  wealth: 'gdp', income: 'gdp', economy: 'gdp', rich: 'gdp',
  affordability: 'cost', cheap: 'cost', expensive: 'cost', cola: 'cost',
  pollution: 'air', smog: 'air', aqi: 'air', pm25: 'air',
  elevation: 'elev', altitude: 'elev', height: 'elev', mountain: 'elev',
  // Disasters axis (Bright = safe). All of these map to the same composite.
  // `dis` mirrors the short hint shown in the hamburger menu.
  dis: 'risk', safety: 'risk', disaster: 'risk', disasters: 'risk', hazard: 'risk', hazards: 'risk',
  earthquake: 'risk', earthquakes: 'risk', quake: 'risk', seismic: 'risk',
  flood: 'risk', flooding: 'risk', floods: 'risk',
  landslide: 'risk', landslides: 'risk', tsunami: 'risk',
  cyclone: 'risk', hurricane: 'risk', typhoon: 'risk',
  drought: 'risk', wildfire: 'risk', volcano: 'risk',
  // `conn` mirrors the short hint shown in the hamburger menu.
  conn: 'inet', internet: 'inet', connectivity: 'inet', wifi: 'inet', broadband: 'inet', bandwidth: 'inet',
  development: 'depv', deprivation: 'depv', hdi: 'depv', poverty: 'depv',
  healthcare: 'hcare', health: 'hcare', hospital: 'hcare', medical: 'hcare', clinic: 'hcare',
  remoteness: 'travel', urban: 'travel', city: 'travel', wilderness: 'travel',
  freedom: 'free', democracy: 'free', liberty: 'free', corruption: 'free',
  agriculture: 'agri', farming: 'agri', cropland: 'agri', farms: 'agri',
  suitability: 'agrip', potential: 'agrip',
  // Energy sub-axes (use distinct words to avoid colliding with the canonical ids)
  oil: 'e_oil', petroleum: 'e_oil', gasoline: 'e_oil',
  coal: 'e_coal',
  natgas: 'e_gas', methane: 'e_gas',
  nuclear: 'e_nuke', nuke: 'e_nuke', reactor: 'e_nuke', uranium: 'e_nuke',
  hydro: 'e_hydro', dam: 'e_hydro', hydroelectric: 'e_hydro',
  windfarm: 'e_wind', windenergy: 'e_wind', turbine: 'e_wind',
  solarfarm: 'e_solar', solarenergy: 'e_solar', photovoltaic: 'e_solar',
  geothermal: 'e_geo',
  consumption: 'e_consume', usage: 'e_consume', kwh: 'e_consume',
  // Vista
  view: 'vista', scenery: 'vista', landscape: 'vista', terrain: 'vista',
};

// Resolve a raw identifier (case-insensitive) into its canonical axis
// name. "T" -> "temp", "Temp" -> "temp", "water" -> "water".
export function resolveAxisAlias(text: string): string {
  const lower = text.toLowerCase();
  return ALIASES[lower] ?? lower;
}

// ── Autocomplete index ───────────────────────────────────────────────
//
// One flat array, ranked by likely-use. Building it here (rather than in
// FormulaBar) keeps the parser as the single source of truth: any alias
// the parser accepts is a valid completion, and vice-versa.

export interface Completion {
  word: string;       // exactly what gets inserted on Tab (always lowercase)
  resolved: string;   // axis id the word parses to (same as word for canonical ids)
  priority: number;   // smaller = preferred; tiebreak by word length, then alpha
}

export function buildCompletionIndex(axisOrder: string[]): Completion[] {
  const order = new Map<string, number>();
  axisOrder.forEach((id, i) => order.set(id, i));

  const entries: Completion[] = [];
  // Canonical ids first (lowest priority numbers), in user-priority order.
  axisOrder.forEach((id, i) => {
    entries.push({ word: id, resolved: id, priority: i });
  });
  // Multi-char aliases get a worse priority than every canonical id, so
  // typing "te" prefers "temp" over "temperature" -- matching IDE behaviour.
  for (const [alias, axisId] of Object.entries(ALIASES)) {
    if (alias.length <= 1) continue;
    if (alias === axisId) continue;
    const base = order.get(axisId);
    const priority = axisOrder.length + (base ?? axisOrder.length);
    entries.push({ word: alias, resolved: axisId, priority });
  }
  return entries;
}

// Returns the best completion for `prefix` (case-insensitive), or null if
// nothing matches or the prefix already exactly equals a candidate. The
// caller decides whether to render only the suffix as ghost text or
// replace the prefix on accept.
export function bestCompletion(prefix: string, index: Completion[]): Completion | null {
  if (!prefix) return null;
  const p = prefix.toLowerCase();
  let best: Completion | null = null;
  for (const c of index) {
    if (c.word.length <= p.length) continue;
    if (!c.word.startsWith(p)) continue;
    if (!best) { best = c; continue; }
    // Lower priority wins; tiebreak: shorter word, then lexicographic.
    if (c.priority < best.priority) best = c;
    else if (c.priority === best.priority) {
      if (c.word.length < best.word.length) best = c;
      else if (c.word.length === best.word.length && c.word < best.word) best = c;
    }
  }
  return best;
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
