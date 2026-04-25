import { useState, useRef, useEffect, useCallback } from 'react';
import { FormulaBar } from './FormulaBar';

export interface AxisOption {
  id: string;
  label: string;
  hotkey: string;
  description?: string;
  unitDescription?: string;
  source?: string;
  sourceUrl?: string;
}

interface TopBarProps {
  axes: AxisOption[];
  energySubAxes?: AxisOption[];
  activeAxisId: string;
  onAxisChange: (id: string) => void;
  formula: string;
  onFormulaChange: (f: string) => void;
  onFormulaSelectionChange?: (sel: string | null) => void;
  formulaError?: string | null;
  repoUrl: string;
  onSaveFile?: () => void;
  onLoadFile?: () => void;
  onBuildReadonlyLink?: () => Promise<string>;
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

function ShareModal({ onClose, onBuildReadonlyLink }: {
  onClose: () => void;
  onBuildReadonlyLink?: () => Promise<string>;
}) {
  const [copied, setCopied] = useState<'readonly' | null>(null);
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

  return (
    <div className="share-backdrop">
      <div className="share-modal" ref={modalRef}>
        <div className="share-modal-title">Share this session</div>

        <button className="share-option share-option-disabled" disabled title="Real-time collab is coming soon">
          <div className="share-option-info">
            <div className="share-option-label">
              Collaboration link
              <span className="share-coming-soon">coming soon</span>
            </div>
            <div className="share-option-desc">Anyone with this link will be able to view and edit preferences together in real-time</div>
          </div>
          <span className="share-copy-btn share-copy-btn-disabled"><CopyIcon /></span>
        </button>

        <button className="share-option" onClick={copyReadonlyLink} disabled={busy || !onBuildReadonlyLink}>
          <div className="share-option-info">
            <div className="share-option-label">Read-only link</div>
            <div className="share-option-desc">Anyone with this link can view your exact preferences, formula, axis, view and year. The link contains the data, so nothing is sent to a server.</div>
          </div>
          <span className="share-copy-btn">
            {copied === 'readonly' ? <CheckIcon /> : <CopyIcon />}
          </span>
        </button>

        <div className="share-privacy">
          {error
            ? `Error: ${error}`
            : 'No accounts, no tracking, no servers storing your data. Your whole session lives only in your browser and inside the link itself.'}
        </div>
      </div>
    </div>
  );
}

// ── TopBar ───────────────────────────────────────────────────────────

export function TopBar({ axes, energySubAxes, activeAxisId, onAxisChange, formula, onFormulaChange, onFormulaSelectionChange, formulaError, repoUrl, onSaveFile, onLoadFile, onBuildReadonlyLink }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [subMenuOpen, setSubMenuOpen] = useState(false);
  const [hoveredAxis, setHoveredAxis] = useState<AxisOption | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setSubMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      setHoveredAxis(null);
      setSubMenuOpen(false);
      if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
      if (subMenuTimer.current) { clearTimeout(subMenuTimer.current); subMenuTimer.current = null; }
    }
  }, [menuOpen]);

  useEffect(() => {
    if (!saveMenuOpen) return;
    const close = (e: PointerEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) setSaveMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [saveMenuOpen]);

  const onMenuItemEnter = useCallback((a: AxisOption, isSubmenuItem = false) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHoveredAxis(a), 500);
    // Only top-level items should collapse the submenu when the mouse moves
    // away from "more...". When the user actually hovers a submenu item we
    // want it to stay open (otherwise it dismisses itself on entry).
    if (!isSubmenuItem) {
      if (subMenuTimer.current) { clearTimeout(subMenuTimer.current); subMenuTimer.current = null; }
      setSubMenuOpen(false);
    }
  }, []);

  const onMenuItemLeave = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHoveredAxis(null);
  }, []);

  const onMoreEnter = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHoveredAxis(null);
    if (subMenuTimer.current) clearTimeout(subMenuTimer.current);
    subMenuTimer.current = setTimeout(() => setSubMenuOpen(true), 150);
  }, []);

  const onMoreLeave = useCallback(() => {
    if (subMenuTimer.current) { clearTimeout(subMenuTimer.current); subMenuTimer.current = null; }
    setSubMenuOpen(false);
  }, []);

  return (
    <>
      <div className="top-bar">
        <div className="top-bar-left" ref={menuRef}>
          <button className="top-bar-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Select data axis">
            <HamburgerIcon />
          </button>
          {menuOpen && (
            <div className="axis-menu">
              {axes.map((a) => (
                <button
                  key={a.id}
                  className={a.id === activeAxisId ? 'axis-menu-item active' : 'axis-menu-item'}
                  onClick={() => { onAxisChange(a.id); setMenuOpen(false); }}
                  onMouseEnter={() => onMenuItemEnter(a)}
                  onMouseLeave={onMenuItemLeave}
                >
                  <span>{a.label}</span>
                  <span className="axis-menu-right">
                    <span className="axis-menu-hint">{a.id}</span>
                    {a.hotkey && <kbd className="axis-menu-hotkey">{a.hotkey.toUpperCase()}</kbd>}
                  </span>
                </button>
              ))}
              {energySubAxes && energySubAxes.length > 0 && (
                <div
                  className="axis-more-wrapper"
                  onMouseEnter={onMoreEnter}
                  onMouseLeave={onMoreLeave}
                >
                  <div className="axis-menu-item axis-more-trigger">
                    <span>more ...</span>
                    <span className="axis-menu-right" style={{ fontSize: 11 }}>&#9654;</span>
                  </div>
                  {subMenuOpen && (
                    <div className="axis-menu axis-submenu">
                      {energySubAxes.map((a) => (
                        <button
                          key={a.id}
                          className={a.id === activeAxisId ? 'axis-menu-item active' : 'axis-menu-item'}
                          onClick={() => { onAxisChange(a.id); setMenuOpen(false); setSubMenuOpen(false); }}
                          onMouseEnter={() => onMenuItemEnter(a, true)}
                          onMouseLeave={onMenuItemLeave}
                        >
                          <span>{a.label}</span>
                          <span className="axis-menu-right">
                            <span className="axis-menu-hint">{a.id}</span>
                            {a.hotkey && <kbd className="axis-menu-hotkey">{a.hotkey.toUpperCase()}</kbd>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="top-bar-center">
          <FormulaBar
            formula={formula}
            onFormulaChange={onFormulaChange}
            onSelectionChange={onFormulaSelectionChange}
            placeholder="e.g. (temp * water) / pop"
            error={formulaError}
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

      {shareOpen && <ShareModal onClose={() => setShareOpen(false)} onBuildReadonlyLink={onBuildReadonlyLink} />}

      {hoveredAxis && hoveredAxis.description && (
        <div className="axis-info-tooltip">
          <div className="axis-info-title">{hoveredAxis.label}</div>
          <div className="axis-info-row">
            <span className="axis-info-label">What it shows</span>
            <span className="axis-info-text">{hoveredAxis.description}</span>
          </div>
          {hoveredAxis.unitDescription && (
            <div className="axis-info-row">
              <span className="axis-info-label">Units</span>
              <span className="axis-info-text">{hoveredAxis.unitDescription}</span>
            </div>
          )}
          {hoveredAxis.source && (
            <div className="axis-info-row">
              <span className="axis-info-label">Source</span>
              <span className="axis-info-text">{hoveredAxis.source}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
