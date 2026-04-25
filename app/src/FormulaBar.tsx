import { useState, useRef, useCallback, useEffect } from 'react';
import { tokenize } from './formulaParser';
import type { Token } from './formulaParser';

const NUM_COLORS = [
  '#5eead4', // teal
  '#fbbf24', // amber
  '#fb7185', // rose
  '#a78bfa', // violet
  '#a3e635', // lime
  '#38bdf8', // sky
];

interface FormulaBarProps {
  formula: string;
  onFormulaChange: (f: string) => void;
  placeholder?: string;
  error?: string | null;
  onSelectionChange?: (sel: string | null) => void;
}

function formatDragValue(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function FormulaBar({ formula, onFormulaChange, placeholder, error, onSelectionChange }: FormulaBarProps) {
  const [editing, setEditing] = useState(false);
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

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.selectionStart = inputRef.current.value.length;
    }
  }, [editing]);

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
    if (start !== end) {
      onSelectionChange?.(target.value.substring(start, end));
    } else {
      onSelectionChange?.(null);
    }
  }, [onSelectionChange]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setEditing(false);
    }
  }, []);

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
    return (
      <input
        ref={inputRef}
        className={error ? 'formula-input formula-input-error' : 'formula-input'}
        type="text"
        value={formula}
        onChange={(e) => onFormulaChange(e.target.value)}
        onSelect={handleSelect}
        onBlur={exitEdit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
      />
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
              onMouseEnter={() => onIdentEnter(tok)}
              onMouseLeave={onIdentLeave}
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
