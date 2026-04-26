import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { tokenize, buildCompletionIndex, bestCompletion } from './formulaParser';
import type { Token } from './formulaParser';

const NUM_COLORS = [
  '#5eead4', // teal
  '#fbbf24', // amber
  '#fb7185', // rose
  '#a78bfa', // violet
  '#a3e635', // lime
  '#38bdf8', // sky
];

// Don't suggest until the user has typed at least this many letters of an
// identifier. One-char prefixes are noisy ("t" -> "temp" steals the typing
// momentum on every keystroke); two chars is a strong enough signal.
const MIN_PREFIX_LEN = 2;

// Match the partial identifier the cursor is currently sitting at the end
// of. We only suggest when the cursor is at the *end* of an identifier --
// editing in the middle of one would surprise the user.
const TRAILING_IDENT = /[a-zA-Z_][a-zA-Z0-9_]*$/;

interface FormulaBarProps {
  formula: string;
  onFormulaChange: (f: string) => void;
  placeholder?: string;
  error?: string | null;
  onSelectionChange?: (sel: string | null) => void;
  /** Double-click on an axis identifier in the display -> parent
   *  switches the active axis (so the curve editor lets the user tune
   *  it). Receives the raw identifier text; the parent is responsible
   *  for resolving aliases. */
  onIdentDoubleClick?: (text: string) => void;
  /**
   * Ordered list of canonical axis ids, ranked by how likely the user is
   * to reach for them (the same order driving the menu / arrow-key cycle).
   * Used purely to rank autocomplete suggestions.
   */
  axisOrder: string[];
}

function formatDragValue(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function FormulaBar({
  formula,
  onFormulaChange,
  placeholder,
  error,
  onSelectionChange,
  onIdentDoubleClick,
  axisOrder,
}: FormulaBarProps) {
  const [editing, setEditing] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  // Token start offset of the identifier currently being previewed via
  // hover. Using start (not text) so duplicates like `temp + temp` only
  // highlight the one under the cursor.
  const [hoveredIdentStart, setHoveredIdentStart] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const formulaRef = useRef(formula);
  formulaRef.current = formula;
  const onChangeRef = useRef(onFormulaChange);
  onChangeRef.current = onFormulaChange;
  const dragRef = useRef<{
    startX: number;
    startValue: number;
    tokenStart: number;
    tokenEnd: number;
  } | null>(null);

  // Build the completion index once per axis-order change. For ~30
  // candidates a flat array is plenty fast (a trie would be the textbook
  // answer but adds zero perceived speed at this scale).
  const completionIndex = useMemo(() => buildCompletionIndex(axisOrder), [axisOrder]);

  // Compute the live ghost-text suggestion: the trailing identifier that
  // the cursor is currently typing, plus the longest sensible completion.
  // Returns null whenever there's nothing to suggest -- so the rendering
  // path can short-circuit and the Tab handler knows to fall through.
  const suggestion = useMemo(() => {
    if (!editing) return null;
    if (cursorPos < MIN_PREFIX_LEN) return null;
    const before = formula.slice(0, cursorPos);
    const after = formula.slice(cursorPos);
    // Only suggest when the cursor is at the end of an identifier; if the
    // next char continues the word, the user is editing in the middle.
    if (/^[a-zA-Z0-9_]/.test(after)) return null;
    const m = before.match(TRAILING_IDENT);
    if (!m) return null;
    const prefix = m[0];
    if (prefix.length < MIN_PREFIX_LEN) return null;
    const best = bestCompletion(prefix, completionIndex);
    if (!best) return null;
    return { prefix, completion: best };
  }, [formula, cursorPos, editing, completionIndex]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.selectionStart = inputRef.current.value.length;
      setCursorPos(inputRef.current.value.length);
    }
  }, [editing]);

  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return false;
    const { prefix, completion } = suggestion;
    const before = formula.slice(0, cursorPos - prefix.length);
    const after = formula.slice(cursorPos);
    const updated = before + completion.word + after;
    const newPos = before.length + completion.word.length;
    onFormulaChange(updated);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.selectionStart = newPos;
      el.selectionEnd = newPos;
      setCursorPos(newPos);
    });
    return true;
  }, [suggestion, formula, cursorPos, onFormulaChange]);

  const enterEdit = useCallback(() => {
    if (dragRef.current) return;
    // Clear any active hover-preview before swapping to the input so
    // the parent doesn't keep showing a soloed sub-formula.
    if (hoveredIdentStart !== null) {
      setHoveredIdentStart(null);
      onSelectionChange?.(null);
    }
    setEditing(true);
  }, [hoveredIdentStart, onSelectionChange]);

  const onIdentEnter = useCallback((tok: Token) => {
    setHoveredIdentStart(tok.start);
    onSelectionChange?.(tok.text);
  }, [onSelectionChange]);

  const onIdentLeave = useCallback(() => {
    setHoveredIdentStart(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLInputElement, Event>) => {
    const target = e.target as HTMLInputElement;
    const start = target.selectionStart || 0;
    const end = target.selectionEnd || 0;
    setCursorPos(end);
    if (start !== end) {
      onSelectionChange?.(target.value.substring(start, end));
    } else {
      onSelectionChange?.(null);
    }
  }, [onSelectionChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Tab always accepts a pending suggestion (and never moves focus while
    // we have one to offer). Right Arrow only accepts when the cursor is
    // at the very end of the input -- otherwise it's just normal cursor
    // movement, matching fish / zsh-autosuggestions behaviour.
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault();
      acceptSuggestion();
      return;
    }
    if (e.key === 'ArrowRight' && suggestion) {
      const el = inputRef.current;
      if (el && el.selectionStart === el.value.length && el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      setEditing(false);
    }
  }, [suggestion, acceptSuggestion]);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onFormulaChange(e.target.value);
    setCursorPos(e.target.selectionStart || e.target.value.length);
  }, [onFormulaChange]);

  const onNumberPointerDown = useCallback((e: React.PointerEvent, token: Token) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startValue: parseFloat(token.text),
      tokenStart: token.start,
      tokenEnd: token.end,
    };
    document.body.style.cursor = 'grabbing';
  }, []);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.startX;
      const scale = Math.max(0.01, Math.abs(drag.startValue) * 0.01);
      const newValue = drag.startValue + dx * scale;
      const newText = formatDragValue(newValue);

      const f = formulaRef.current;
      const before = f.slice(0, drag.tokenStart);
      const after = f.slice(drag.tokenEnd);
      const updated = before + newText + after;

      drag.tokenEnd = drag.tokenStart + newText.length;
      onChangeRef.current(updated);
    };

    const onPointerUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  if (editing) {
    // The ghost overlay sits behind the input with identical font + padding;
    // hidden filler text shoves the visible suffix to the cursor's column,
    // so we never have to measure pixel widths by hand. Three spans: text
    // up to the cursor (transparent), the faint suffix, then text after the
    // cursor (also transparent) -- the layout falls out for free.
    const ghostBefore = suggestion ? formula.slice(0, cursorPos) : '';
    const ghostSuffix = suggestion ? suggestion.completion.word.slice(suggestion.prefix.length) : '';
    const ghostAfter = suggestion ? formula.slice(cursorPos) : '';

    // While the user is mid-typing the formula is almost always
    // syntactically incomplete ("temp +" before they finish). Flashing red
    // on every keystroke trains them to ignore the warning, so we suppress
    // the error styling until they commit (Enter / blur) -- the error
    // string itself is still kept around so it lights up immediately on
    // commit if the formula didn't actually parse.
    return (
      <div className="formula-input-wrap">
        <input
          ref={inputRef}
          className="formula-input"
          type="text"
          value={formula}
          onChange={onInputChange}
          onSelect={handleSelect}
          onBlur={exitEdit}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => setCursorPos((e.target as HTMLInputElement).selectionStart || 0)}
          onClick={(e) => setCursorPos((e.target as HTMLInputElement).selectionStart || 0)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {suggestion && (
          <div className="formula-ghost" aria-hidden="true">
            <span className="formula-ghost-fill">{ghostBefore}</span>
            <span className="formula-ghost-suffix">{ghostSuffix}</span>
            <span className="formula-ghost-fill">{ghostAfter}</span>
          </div>
        )}
      </div>
    );
  }

  const tokens = tokenize(formula);
  let numIdx = 0;

  return (
    <div
      ref={displayRef}
      className={error ? 'formula-display formula-display-error' : 'formula-display'}
      onClick={enterEdit}
      onKeyDown={enterEdit}
      tabIndex={0}
      role="textbox"
      aria-label="Formula"
    >
      {formula.length === 0 && (
        <span className="formula-placeholder">{placeholder}</span>
      )}
      {tokens.map((tok, i) => {
        if (tok.type === 'number') {
          const color = NUM_COLORS[numIdx % NUM_COLORS.length];
          numIdx++;
          return (
            <span
              key={`${i}-${tok.start}`}
              className="formula-token-number"
              style={{ color, borderColor: color + '40' }}
              onPointerDown={(e) => onNumberPointerDown(e, tok)}
            >
              {tok.text}
            </span>
          );
        }
        if (tok.type === 'ident') {
          const isHovered = hoveredIdentStart === tok.start;
          return (
            <span
              key={`${i}-${tok.start}`}
              className={isHovered ? 'formula-token-ident formula-token-ident-hover' : 'formula-token-ident'}
              title="Double-click to tune this axis"
              onMouseEnter={() => onIdentEnter(tok)}
              onMouseLeave={onIdentLeave}
              // Swallow single-clicks so the parent's onClick (enter
              // edit mode) doesn't fire and unmount this span before
              // the dblclick can land. Edit mode is still entered by
              // clicking anywhere else on the bar.
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onIdentDoubleClick?.(tok.text);
              }}
            >
              {tok.text}
            </span>
          );
        }
        if (tok.type === 'op' || tok.type === 'paren') {
          return <span key={`${i}-${tok.start}`} className="formula-token-op">{tok.text}</span>;
        }
        return <span key={`${i}-${tok.start}`}>{tok.text}</span>;
      })}
      {error && <span className="formula-error-hint" title={error}>!</span>}
    </div>
  );
}
