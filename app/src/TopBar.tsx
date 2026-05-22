import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FormulaBar } from './FormulaBar';
import { tokenize, resolveAxisAlias } from './formulaParser';

export interface AxisOption {
  id: string;
  label: string;
  hotkey: string;
  /** Optional short identifier shown in the menu instead of `id`.
   *  The internal `id` still drives tile URLs and saved state. */
  displayId?: string;
  description?: string;
  unitDescription?: string;
  source?: string;
  sourceUrl?: string;
}

interface TopBarProps {
  axes: AxisOption[];
  energySubAxes?: AxisOption[];
  hazardSubAxes?: AxisOption[];
  activeAxisId: string;
  onAxisChange: (id: string) => void;
  formula: string;
  onFormulaChange: (f: string) => void;
  /** Fires only when the user commits the edit (Enter / blur). Used
   *  by the parent to rebroadcast the formula to collab peers without
   *  spamming on every keystroke. */
  onFormulaCommit?: (f: string) => void;
  onFormulaSelectionChange?: (sel: string | null) => void;
  onFormulaIdentDoubleClick?: (text: string) => void;
  formulaError?: string | null;
  /** Ordered axis ids (most-likely-used first) used to rank formula
   *  bar autocomplete suggestions. */
  formulaAxisOrder: string[];
  repoUrl: string;
  onSaveFile?: () => void;
  onLoadFile?: () => void;
  onBuildReadonlyLink?: () => Promise<string>;
  /** Build a hybrid collab link: a `#view=<snapshot>&room=<id>` URL
   *  that carries both the live room id AND a static snapshot of the
   *  current state. The static snapshot is the fallback if the worker
   *  is rate-limited or unreachable, so a recipient always sees
   *  *something*. */
  onBuildCollabLink?: () => Promise<string>;
  /** True iff the collab worker is reachable (VITE_COLLAB_URL is set
   *  and the build is configured for it). When false the share modal
   *  shows the collab option as "coming soon" rather than letting
   *  users copy a link that won't actually connect to anything. */
  collabEnabled: boolean;
  /** Pre-built share URL when the user is already inside a room.
   *  Falsy means "no room yet -- create one via onStartCollab first". */
  collabShareUrl: string | null;
  /** Set when the live worker is unreachable / rate-limited so the
   *  share modal can swap the collab button for a friendly explanation
   *  instead of letting users copy a link that just won't work. */
  collabError?: 'rate-limited' | 'unavailable' | null;
  /** Generate a fresh room id, push it onto the URL, and start the
   *  WebSocket session. Returns the new room id. */
  onStartCollab?: () => string | null;
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect y="3" width="20" height="2" rx="1" fill="currentColor" />
      <rect y="9" width="20" height="2" rx="1" fill="currentColor" />
      <rect y="15" width="20" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" stroke="currentColor" strokeWidth="1.5" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── Share modal ──────────────────────────────────────────────────────

function ShareModal({ onClose, onBuildReadonlyLink, onBuildCollabLink, collabEnabled, collabShareUrl, collabError, onStartCollab }: {
  onClose: () => void;
  onBuildReadonlyLink?: () => Promise<string>;
  onBuildCollabLink?: () => Promise<string>;
  collabEnabled: boolean;
  collabShareUrl: string | null;
  collabError?: 'rate-limited' | 'unavailable' | null;
  onStartCollab?: () => string | null;
}) {
  const [copied, setCopied] = useState<'readonly' | 'collab' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onClick = (e: PointerEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onClick);
    return () => window.removeEventListener('pointerdown', onClick);
  }, [onClose]);

  const copyReadonlyLink = async () => {
    if (!onBuildReadonlyLink || busy) return;
    setBusy(true);
    setError(null);
    try {
      const url = await onBuildReadonlyLink();
      await navigator.clipboard.writeText(url);
      setCopied('readonly');
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build link');
    } finally {
      setBusy(false);
    }
  };

  // Excalidraw-style: tap once -> the modal generates a room, joins it,
  // and copies the URL to the clipboard. If you're already in a room
  // (e.g. someone shared a link with you), it just reuses that room.
  // The link itself is *hybrid* (`#view=...&room=...`), so even if the
  // worker is down or rate-limited the recipient still sees the
  // current snapshot.
  const copyCollabLink = async () => {
    if (!collabEnabled || busy || collabError) return;
    setBusy(true);
    setError(null);
    try {
      let url: string | null = null;
      if (onBuildCollabLink) {
        url = await onBuildCollabLink();
      } else {
        // Defensive fallback: if the parent didn't wire the hybrid
        // builder for some reason, fall back to the live-only link.
        url = collabShareUrl;
        if (!url && onStartCollab) {
          onStartCollab();
          if (typeof window !== 'undefined') {
            url = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
          }
        }
      }
      if (!url) throw new Error('Could not start a session');
      await navigator.clipboard.writeText(url);
      setCopied('collab');
      setTimeout(() => setCopied(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start collab');
    } finally {
      setBusy(false);
    }
  };

  const collabBlocked = collabEnabled && !!collabError;
  const collabBlockedMsg = collabError === 'rate-limited'
    ? 'The live relay just rate-limited this tab. Send the read-only link below instead -- it carries the whole snapshot and works without the relay.'
    : collabError === 'unavailable'
      ? 'The live relay is unreachable right now. Send the read-only link below instead -- it works without the relay.'
      : null;

  return (
    <div className="share-backdrop">
      <div className="share-modal" ref={modalRef}>
        <div className="share-modal-title">Share this session</div>

        {collabEnabled && !collabBlocked ? (
          <button className="share-option" onClick={copyCollabLink} disabled={busy}>
            <div className="share-option-info">
              <div className="share-option-label">
                Collaboration link
                {collabShareUrl && <span className="share-live-pill">live</span>}
              </div>
              <div className="share-option-desc">
                {collabShareUrl
                  ? 'You are already in a room -- this copies the link so others can join. Everyone sees the same axis, formula, year and tuned curves in real time (no live cursors). The link also bakes in a snapshot so it still works if the relay is offline.'
                  : 'Generates a link anyone can open to join this session. All connected browsers stay in lock-step on axis, formula, year and tuned curves in real time (no live cursors). The link also bakes in a snapshot so it still works if the relay is offline.'}
              </div>
            </div>
            <span className="share-copy-btn">
              {copied === 'collab' ? <CheckIcon /> : <CopyIcon />}
            </span>
          </button>
        ) : collabBlocked ? (
          <button className="share-option share-option-disabled" disabled title={collabBlockedMsg ?? undefined}>
            <div className="share-option-info">
              <div className="share-option-label">
                Collaboration link
                <span className="share-coming-soon">{collabError === 'rate-limited' ? 'rate limited' : 'unavailable'}</span>
              </div>
              <div className="share-option-desc">{collabBlockedMsg}</div>
            </div>
            <span className="share-copy-btn share-copy-btn-disabled"><CopyIcon /></span>
          </button>
        ) : (
          <button className="share-option share-option-disabled" disabled title="Real-time collab is coming soon">
            <div className="share-option-info">
              <div className="share-option-label">
                Collaboration link
                <span className="share-coming-soon">coming soon</span>
              </div>
              <div className="share-option-desc">Anyone with this link will be able to view and edit preferences together in real-time.</div>
            </div>
            <span className="share-copy-btn share-copy-btn-disabled"><CopyIcon /></span>
          </button>
        )}

        <button className="share-option" onClick={copyReadonlyLink} disabled={busy || !onBuildReadonlyLink}>
          <div className="share-option-info">
            <div className="share-option-label">Read-only link</div>
            <div className="share-option-desc">Anyone with this link sees your exact preferences, formula, axis, view and year as a static snapshot. The link encodes everything; nothing reaches our servers.</div>
          </div>
          <span className="share-copy-btn">
            {copied === 'readonly' ? <CheckIcon /> : <CopyIcon />}
          </span>
        </button>

        <div className="share-privacy">
          {error
            ? `Error: ${error}`
            : 'No accounts, no tracking. Read-only links carry the whole session inside the URL -- nothing reaches our servers. Collaboration links route through a tiny relay that forwards changes between connected browsers in real time and stores nothing -- when everyone closes the tab the room evaporates from memory.'}
        </div>
      </div>
    </div>
  );
}

// ── TopBar ───────────────────────────────────────────────────────────

export function TopBar({ axes, energySubAxes, hazardSubAxes, activeAxisId, onAxisChange, formula, onFormulaChange, onFormulaCommit, onFormulaSelectionChange, onFormulaIdentDoubleClick, formulaError, formulaAxisOrder, repoUrl, onSaveFile, onLoadFile, onBuildReadonlyLink, onBuildCollabLink, collabEnabled, collabShareUrl, collabError, onStartCollab }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  // Which submenu group (energy / hazards) is currently expanded inline.
  // Only one is open at a time so the menu doesn't grow unbounded; tapping
  // the same trigger again collapses it.
  const [openSubMenu, setOpenSubMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setOpenSubMenu(null);
      }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) setOpenSubMenu(null);
  }, [menuOpen]);

  useEffect(() => {
    if (!saveMenuOpen) return;
    const close = (e: PointerEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) setSaveMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [saveMenuOpen]);

  // When the user expands an accordion group, scroll the freshly-revealed
  // first sub-item into view. Without this, expanding "Natural Hazards"
  // near the bottom of a long menu just shoves the new items off-screen
  // and the user has to chase them with a scroll. `block: 'nearest'`
  // means we only scroll the minimum needed -- if the items are already
  // visible (typical when expanding near the top), nothing moves.
  const firstSubRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    requestAnimationFrame(() => {
      try { node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  }, []);

  // What token to drop into the formula bar when the user toggles a
  // row's checkbox. Prefers the single-letter hotkey (so "water" lands
  // as "w") because that's what every existing alias / autocomplete
  // hint already trains users to read. Multi-char hotkeys (energy
  // sub-axes use digits like '1', '2', ...) fall back to the canonical
  // id so we don't accidentally inject a numeric literal into the
  // formula.
  const formulaTokenFor = useCallback((a: AxisOption): string => {
    if (a.hotkey && /^[a-z]$/i.test(a.hotkey)) return a.hotkey.toLowerCase();
    return a.id;
  }, []);

  // Ordered list of axis ids currently referenced by the formula.
  // Order is preserved so the checkbox UI shows the user's actual
  // multiplication order (e.g. checking water then temp yields
  // "w * t", not "t * w"). When the formula is empty or contains
  // non-ident tokens we still extract whichever idents we find --
  // toggling will overwrite the formula with a pure-multiplication
  // version anyway, so it's only a hint for the checkboxes.
  const formulaIdentIds = useMemo<string[]>(() => {
    const toks = tokenize(formula).filter((t) => t.type !== 'space');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of toks) {
      if (t.type !== 'ident') continue;
      const id = resolveAxisAlias(t.text);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }, [formula]);
  const formulaIdentSet = useMemo(() => new Set(formulaIdentIds), [formulaIdentIds]);

  // Find all axis options (main + submenus) so a checkbox toggle can
  // resolve any id back to the token we want to emit.
  const allOptionsById = useMemo(() => {
    const m = new Map<string, AxisOption>();
    for (const a of axes) m.set(a.id, a);
    for (const a of energySubAxes ?? []) m.set(a.id, a);
    for (const a of hazardSubAxes ?? []) m.set(a.id, a);
    return m;
  }, [axes, energySubAxes, hazardSubAxes]);

  const toggleAxisInFormula = useCallback((a: AxisOption) => {
    const isChecked = formulaIdentSet.has(a.id);
    const nextIds = isChecked
      ? formulaIdentIds.filter((id) => id !== a.id)
      : [...formulaIdentIds, a.id];
    const newFormula = nextIds
      .map((id) => formulaTokenFor(allOptionsById.get(id) ?? a))
      .join(' * ');
    onFormulaChange(newFormula);
    onFormulaCommit?.(newFormula);
  }, [formulaIdentSet, formulaIdentIds, formulaTokenFor, allOptionsById, onFormulaChange, onFormulaCommit]);

  return (
    <>
      <div className="top-bar">
        <div className="top-bar-left" ref={menuRef}>
          <button className="top-bar-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Select data axis">
            <HamburgerIcon />
          </button>
          {menuOpen && (() => {
            const submenuGroups = ([
              { key: 'energy', label: 'Energy ...', items: energySubAxes },
              { key: 'hazards', label: 'Natural Hazards ...', items: hazardSubAxes },
            ] as { key: string; label: string; items?: AxisOption[] }[])
              .filter((g) => g.items && g.items.length > 0);

            const renderAxis = (a: AxisOption) => {
              const isInFormula = formulaIdentSet.has(a.id);
              return (
                <div
                  key={a.id}
                  className={`axis-menu-item${a.id === activeAxisId ? ' active' : ''}${isInFormula ? ' in-formula' : ''}`}
                  onClick={() => { onAxisChange(a.id); setMenuOpen(false); setOpenSubMenu(null); }}
                  role="button"
                  tabIndex={0}
                >
                  <span>{a.label}</span>
                  <span className="axis-menu-right">
                    <span className="axis-menu-hint">{a.displayId ?? a.id}</span>
                    {a.hotkey && <kbd className="axis-menu-hotkey">{a.hotkey.toUpperCase()}</kbd>}
                    <label
                      className="axis-menu-check"
                      onClick={(e) => e.stopPropagation()}
                      title={isInFormula
                        ? `Remove "${a.label}" from the formula`
                        : `Add "${a.label}" to the formula (multiplicative)`}
                    >
                      <input
                        type="checkbox"
                        checked={isInFormula}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleAxisInFormula(a);
                        }}
                      />
                    </label>
                  </span>
                </div>
              );
            };

            const renderSubmenuGroups = () => submenuGroups.flatMap((group) => {
              const isOpen = openSubMenu === group.key;
              const trigger = (
                <button
                  key={`${group.key}-trigger`}
                  className={`axis-menu-item axis-more-trigger${isOpen ? ' open' : ''}`}
                  onClick={() => setOpenSubMenu((cur) => cur === group.key ? null : group.key)}
                  aria-expanded={isOpen}
                >
                  <span>{group.label}</span>
                  <span className="axis-menu-right axis-more-chevron">{isOpen ? '\u25BE' : '\u25B8'}</span>
                </button>
              );
              if (!isOpen) return [trigger];
              const subItems = group.items!.map((a, idx) => {
                const isInFormula = formulaIdentSet.has(a.id);
                return (
                  <div
                    key={a.id}
                    ref={idx === 0 ? firstSubRef : undefined}
                    className={`axis-menu-item axis-menu-subitem${a.id === activeAxisId ? ' active' : ''}${isInFormula ? ' in-formula' : ''}`}
                    onClick={() => { onAxisChange(a.id); setMenuOpen(false); setOpenSubMenu(null); }}
                    role="button"
                    tabIndex={0}
                  >
                    <span>{a.label}</span>
                    <span className="axis-menu-right">
                      <span className="axis-menu-hint">{a.displayId ?? a.id}</span>
                      {a.hotkey && <kbd className="axis-menu-hotkey">{a.hotkey.toUpperCase()}</kbd>}
                      <label
                        className="axis-menu-check"
                        onClick={(e) => e.stopPropagation()}
                        title={isInFormula
                          ? `Remove "${a.label}" from the formula`
                          : `Add "${a.label}" to the formula (multiplicative)`}
                      >
                        <input
                          type="checkbox"
                          checked={isInFormula}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleAxisInFormula(a);
                          }}
                        />
                      </label>
                    </span>
                  </div>
                );
              });
              return [trigger, ...subItems];
            });

            // Submenus go right before the "draw" item so the menu reads:
            // ...wind, Energy..., Natural Hazards..., DRAW. If there is
            // no draw axis (paranoid fallback), append at the end.
            const drawIdx = axes.findIndex((a) => a.id === 'draw');
            const elements: React.ReactNode[] = [];
            axes.forEach((a, i) => {
              if (i === drawIdx) elements.push(...renderSubmenuGroups());
              elements.push(renderAxis(a));
            });
            if (drawIdx < 0) elements.push(...renderSubmenuGroups());

            return <div className="axis-menu">{elements}</div>;
          })()}
        </div>

        <div className="top-bar-center">
          <FormulaBar
            formula={formula}
            onFormulaChange={onFormulaChange}
            onFormulaCommit={onFormulaCommit}
            onSelectionChange={onFormulaSelectionChange}
            onIdentDoubleClick={onFormulaIdentDoubleClick}
            placeholder="e.g. temp + water / pop"
            error={formulaError}
            axisOrder={formulaAxisOrder}
          />
        </div>

        <div className="top-bar-right">
          <div ref={saveMenuRef} style={{ position: 'relative' }}>
            <button className="top-bar-btn" onClick={() => setSaveMenuOpen(v => !v)} aria-label="Save / Load">
              <SaveIcon />
            </button>
            {saveMenuOpen && (
              <div className="save-menu">
                <button className="save-menu-item" onClick={() => { onSaveFile?.(); setSaveMenuOpen(false); }}>
                  Save to file
                </button>
                <button className="save-menu-item" onClick={() => { onLoadFile?.(); setSaveMenuOpen(false); }}>
                  Load from file
                </button>
              </div>
            )}
          </div>
          <button className="top-bar-btn" onClick={() => setShareOpen(true)} aria-label="Share">
            <ShareIcon />
          </button>
          <a className="top-bar-btn" href={repoUrl} target="_blank" rel="noopener noreferrer" aria-label="GitHub">
            <GitHubIcon />
          </a>
        </div>
      </div>

      {shareOpen && (
        <ShareModal
          onClose={() => setShareOpen(false)}
          onBuildReadonlyLink={onBuildReadonlyLink}
          onBuildCollabLink={onBuildCollabLink}
          collabEnabled={collabEnabled}
          collabShareUrl={collabShareUrl}
          collabError={collabError}
          onStartCollab={onStartCollab}
        />
      )}
    </>
  );
}
