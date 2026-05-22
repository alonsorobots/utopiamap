// First-visit intro: 45s cinematic that puppets the real heatmap +
// formula bar + curve LUTs, followed by a 2-of-6 "what matters?"
// picker, per-axis preset chips, and a reveal that drops the user
// into the live app with their personalised formula loaded.
//
// Self-contained: the parent supplies a CinematicAPI handle (so all
// the puppeting goes through the real underlying state) and a
// `onFinish` callback to call when the intro is fully dismissed.
// LocalStorage gating happens in the parent so this component can
// stay 100% about presentation.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { CinematicAPI, AxisChip } from './introScript';
import { CINEMATIC, AXIS_CHIPS, composeFormula, composeRevealSentence } from './introScript';
import type { CurvePoint } from './CurveEditor';

type Stage = 'cinematic' | 'pick-axes' | 'pick-presets' | 'reveal';

interface IntroProps {
  api: CinematicAPI;
  // Called when the intro is fully done -- either after the reveal
  // completes, or after the user skips at any point. The parent uses
  // this to set the localStorage flag and unmount the overlay.
  onFinish: () => void;
  // Called once with the final personalised state right before the
  // overlay fades out, so the parent can install the chosen presets
  // (curves) and final formula into its own React state in addition
  // to whatever the API already pushed through the heatmap module.
  onCommit: (commit: {
    formula: string;
    activeAxis: string;
    curves: Record<string, CurvePoint[]>;
  }) => void;
}

const SKIP_REVEAL_DELAY_MS = 3000;

export function Intro({ api, onFinish, onCommit }: IntroProps) {
  const [stage, setStage] = useState<Stage>('cinematic');
  const [sceneIdx, setSceneIdx] = useState(0);
  const [skipVisible, setSkipVisible] = useState(false);
  const [chosenAxes, setChosenAxes] = useState<string[]>([]); // chip ids in click order
  const [pickPresetForIdx, setPickPresetForIdx] = useState(0); // which of the chosen axes are we configuring
  const [presetChoices, setPresetChoices] = useState<Record<string, string>>({}); // chipId -> presetId
  const [fading, setFading] = useState(false);

  // Latest API in a ref so the long-running cinematic loop doesn't
  // capture a stale instance after parent re-renders.
  const apiRef = useRef(api);
  apiRef.current = api;

  // Cancellation token shared across all async waits in the cinematic.
  // Flipping `cancelled = true` short-circuits each sleep() so a skip
  // doesn't have to wait for the current scene to finish.
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // Skip button fades in after a brief delay so the opening shot
  // isn't immediately cluttered with UI chrome.
  useEffect(() => {
    if (stage !== 'cinematic') { setSkipVisible(true); return; }
    const t = window.setTimeout(() => setSkipVisible(true), SKIP_REVEAL_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [stage]);

  // Cinematic runner. Steps through CINEMATIC scenes, applying each
  // scene's mutation and waiting holdMs before moving on. On cancel
  // we jump straight to the interactive picker -- but only if the
  // user explicitly skipped, not on unmount (so React strict-mode
  // double-effects don't accidentally race past the cinematic).
  useEffect(() => {
    if (stage !== 'cinematic') return;
    const token = cancelRef.current;
    let cancelled = false;
    const isCancelled = () => cancelled || token.cancelled;
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (isCancelled()) return resolve();
        if (performance.now() - start >= ms) return resolve();
        window.setTimeout(tick, Math.min(120, ms - (performance.now() - start)));
      };
      tick();
    });

    (async () => {
      for (let i = 0; i < CINEMATIC.length; i++) {
        if (isCancelled()) return;
        setSceneIdx(i);
        const scene = CINEMATIC[i];
        try { await scene.apply?.(apiRef.current); } catch {}
        if (isCancelled()) return;
        await sleep(scene.holdMs);
      }
      // Natural finish -- move to interactive picker.
      if (!isCancelled()) setStage('pick-axes');
    })();

    return () => { cancelled = true; };
  }, [stage]);

  // ── Stage transitions ────────────────────────────────────────────

  const advanceCinematic = useCallback(() => {
    cancelRef.current.cancelled = true;
    cancelRef.current = { cancelled: false };
    setStage('pick-axes');
  }, []);

  const onChooseAxis = useCallback((chipId: string) => {
    setChosenAxes((cur) => {
      if (cur.includes(chipId)) return cur.filter((c) => c !== chipId);
      if (cur.length >= 2) return [cur[1], chipId]; // sliding window: keep last 2
      return [...cur, chipId];
    });
  }, []);

  const confirmAxisPicks = useCallback(() => {
    if (chosenAxes.length === 0) return;
    setPickPresetForIdx(0);
    setStage('pick-presets');
  }, [chosenAxes]);

  const onChoosePreset = useCallback((chipId: string, presetId: string) => {
    setPresetChoices((cur) => ({ ...cur, [chipId]: presetId }));
    // Auto-advance to next axis (or reveal) -- single click commits.
    setTimeout(() => {
      if (pickPresetForIdx + 1 < chosenAxes.length) {
        setPickPresetForIdx(pickPresetForIdx + 1);
      } else {
        setStage('reveal');
      }
    }, 220);
  }, [pickPresetForIdx, chosenAxes.length]);

  // When we reach the reveal stage, install the chosen presets and
  // formula via the API + commit callback, then fade out.
  useEffect(() => {
    if (stage !== 'reveal') return;
    const chosenChips: AxisChip[] = chosenAxes
      .map((id) => AXIS_CHIPS.find((c) => c.id === id))
      .filter((c): c is AxisChip => c != null);
    const curves: Record<string, CurvePoint[]> = {};
    for (const chip of chosenChips) {
      const presetId = presetChoices[chip.id];
      const preset = chip.presets.find((p) => p.id === presetId) ?? chip.presets[0];
      apiRef.current.setCurve(chip.axisId, preset.curve);
      curves[chip.axisId] = preset.curve;
    }
    const formula = composeFormula(chosenChips.map((c) => c.axisId));
    apiRef.current.setFormula(formula);
    onCommit({
      formula,
      activeAxis: chosenChips[0]?.axisId ?? 'temp',
      curves,
    });
    // Hold the reveal for a moment so the user reads the sentence,
    // then fade the overlay away.
    const t1 = window.setTimeout(() => setFading(true), 3200);
    const t2 = window.setTimeout(() => onFinish(), 4200);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [stage, chosenAxes, presetChoices, onCommit, onFinish]);

  const onSkip = useCallback(() => {
    cancelRef.current.cancelled = true;
    setFading(true);
    window.setTimeout(() => onFinish(), 400);
  }, [onFinish]);

  // ── Render ────────────────────────────────────────────────────────

  const currentScene = CINEMATIC[sceneIdx] ?? CINEMATIC[CINEMATIC.length - 1];

  const chosenChips = useMemo<AxisChip[]>(() =>
    chosenAxes.map((id) => AXIS_CHIPS.find((c) => c.id === id)).filter((c): c is AxisChip => c != null),
  [chosenAxes]);

  return (
    <div className={`intro-overlay${fading ? ' intro-fade-out' : ''}`}>
      {/* Backdrop wash -- low alpha so the live map remains visible
           behind every stage of the intro. */}
      <div className="intro-backdrop" />

      {/* Skip / replay control. Hidden for the first few seconds
           of the cinematic to give the opening shot some breathing
           room (see SKIP_REVEAL_DELAY_MS). */}
      <button
        className={`intro-skip${skipVisible ? ' visible' : ''}`}
        onClick={onSkip}
        aria-label="Skip intro"
      >
        Skip
      </button>

      {stage === 'cinematic' && (
        <>
          <div className="intro-caption">
            <span key={sceneIdx} className="intro-caption-text">
              {currentScene.caption}
            </span>
          </div>
          {sceneIdx >= CINEMATIC.length - 1 && (
            <button
              className="intro-cta visible"
              onClick={advanceCinematic}
            >
              Begin →
            </button>
          )}
        </>
      )}

      {stage === 'pick-axes' && (
        <div className="intro-panel intro-pick-axes">
          <h2 className="intro-h">What matters most where you'd want to live?</h2>
          <p className="intro-sub">Pick two.</p>
          <div className="intro-chip-grid">
            {AXIS_CHIPS.map((chip) => {
              const isChosen = chosenAxes.includes(chip.id);
              const order = chosenAxes.indexOf(chip.id);
              return (
                <button
                  key={chip.id}
                  className={`intro-chip${isChosen ? ' chosen' : ''}`}
                  onClick={() => onChooseAxis(chip.id)}
                >
                  {isChosen && <span className="intro-chip-order">{order + 1}</span>}
                  <div className="intro-chip-label">{chip.label}</div>
                  <div className="intro-chip-blurb">{chip.blurb}</div>
                </button>
              );
            })}
          </div>
          <div className="intro-actions">
            <button
              className="intro-cta visible"
              disabled={chosenAxes.length === 0}
              onClick={confirmAxisPicks}
            >
              {chosenAxes.length === 0 ? 'Pick at least one' : 'Continue →'}
            </button>
          </div>
        </div>
      )}

      {stage === 'pick-presets' && chosenChips[pickPresetForIdx] && (() => {
        const chip = chosenChips[pickPresetForIdx];
        return (
          <div className="intro-panel intro-pick-presets">
            <div className="intro-step-counter">
              {pickPresetForIdx + 1} of {chosenChips.length}
            </div>
            <h2 className="intro-h">{chip.blurb}</h2>
            <p className="intro-sub">{chip.label}</p>
            <div className="intro-preset-grid">
              {chip.presets.map((preset) => (
                <button
                  key={preset.id}
                  className="intro-preset"
                  onClick={() => onChoosePreset(chip.id, preset.id)}
                >
                  <div className="intro-preset-label">{preset.label}</div>
                  {preset.hint && <div className="intro-preset-hint">{preset.hint}</div>}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {stage === 'reveal' && (
        <div className="intro-panel intro-reveal">
          <div className="intro-reveal-eyebrow">Here's your map.</div>
          <h2 className="intro-h intro-reveal-sentence">
            {composeRevealSentence(chosenChips)}
          </h2>
          <div className="intro-reveal-formula">
            <span className="intro-reveal-formula-label">You composed:</span>
            <code className="intro-reveal-formula-code">
              {composeFormula(chosenChips.map((c) => c.axisId))}
            </code>
          </div>
          <p className="intro-sub intro-reveal-hint">
            Tap any feature in the menu to keep refining.
          </p>
        </div>
      )}
    </div>
  );
}
