import React, { useCallback, useRef, useState } from 'react';
import { preferencesAPI } from '../services/api';
import { ACCENT_LIGHTNESS, DEFAULT_ACCENT, applyAccent, hexToHsl, hslToHex, isHexColor, rememberAccent, storedAccent } from '../theme/accent';
import './AccentPicker.css';


const PRESETS: Array<{ name: string; color: string }> = [
  { name: 'Forest (File Box)', color: DEFAULT_ACCENT },
  { name: 'Ocean', color: '#2f5d8a' },
  { name: 'Teal', color: '#2f6f6a' },
  { name: 'Plum', color: '#6a4a7d' },
  { name: 'Rose', color: '#a14a63' },
  { name: 'Amber', color: '#9a6b1f' },
  { name: 'Graphite', color: '#4a4f57' },
];

/**
 * Settings > Appearance: choose the color File Box is shown in. The wheel picks hue (around) and how
 * colorful (outward); presets and an exact color picker are there too. Changes apply live and are saved
 * with the account.
 */
const AccentPicker: React.FC = () => {
  const [accent, setAccent] = useState<string>(storedAccent() || DEFAULT_ACCENT);
  // Brightness from the slider; the wheel picks hue (around) and colorfulness (outward) at this brightness.
  const [lightness, setLightness] = useState<number>(() => hexToHsl(storedAccent() || DEFAULT_ACCENT).l);
  const [status, setStatus] = useState('');
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const preview = (color: string) => {
    setAccent(color);
    applyAccent(color);
  };

  const save = useCallback(async (color: string) => {
    const value = color.toLowerCase() === DEFAULT_ACCENT ? null : color.toLowerCase();
    rememberAccent(value);
    setStatus('Saving…');
    try {
      await preferencesAPI.setAccent(value);
      setStatus('Saved');
    } catch {
      setStatus('Saved in this browser only (could not reach File Box)');
    }
  }, []);

  const colorAt = (clientX: number, clientY: number) => {
    const box = wheelRef.current?.getBoundingClientRect();
    if (!box) return accent;
    const radius = box.width / 2;
    const dx = clientX - (box.left + radius);
    const dy = clientY - (box.top + radius);
    const hue = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const strength = Math.min(1, Math.hypot(dx, dy) / radius);
    return hslToHex({ h: hue, s: strength, l: lightness });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    preview(colorAt(event.clientX, event.clientY));
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) preview(colorAt(event.clientX, event.clientY));
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    save(accent);
  };

  // Keyboard: left/right turns the hue, up/down makes it more or less colorful.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const { h, s } = hexToHsl(accent);
    let next: string | null = null;
    if (event.key === 'ArrowRight') next = hslToHex({ h: (h + 10) % 360, s: Math.max(s, 0.2), l: lightness });
    if (event.key === 'ArrowLeft') next = hslToHex({ h: (h + 350) % 360, s: Math.max(s, 0.2), l: lightness });
    if (event.key === 'ArrowUp') next = hslToHex({ h, s: Math.min(1, s + 0.05), l: lightness });
    if (event.key === 'ArrowDown') next = hslToHex({ h, s: Math.max(0, s - 0.05), l: lightness });
    if (next) {
      event.preventDefault();
      preview(next);
      save(next);
    }
  };

  const choose = (color: string) => {
    setLightness(hexToHsl(color).l);
    preview(color);
    save(color);
  };

  const changeLightness = (value: number) => {
    setLightness(value);
    const { h: hue, s: sat } = hexToHsl(accent);
    preview(hslToHex({ h: hue, s: sat, l: value }));
  };

  // Marker position on the wheel for the current accent.
  const { h, s } = hexToHsl(accent);
  const reach = Math.min(1, s);
  // The wheel shows the slider's brightness: darker below the middle, lighter above it.
  const shadeOverlay = lightness < 0.5
    ? `rgba(0, 0, 0, ${((0.5 - lightness) * 2).toFixed(2)})`
    : `rgba(255, 255, 255, ${((lightness - 0.5) * 2).toFixed(2)})`;
  const adjusted = lightness < ACCENT_LIGHTNESS.min || lightness > ACCENT_LIGHTNESS.max;
  const markerX = 50 + 50 * reach * Math.sin((h * Math.PI) / 180);
  const markerY = 50 - 50 * reach * Math.cos((h * Math.PI) / 180);
  const presetName = PRESETS.find(p => p.color === accent.toLowerCase())?.name;

  return (
    <div className="accent-picker">
      <div
        ref={wheelRef}
        className="accent-wheel"
        role="slider"
        tabIndex={0}
        aria-label="Accent color wheel. Left and right change the color, up and down make it more or less colorful."
        aria-valuetext={presetName || accent}
        aria-valuenow={Math.round(h)}
        aria-valuemin={0}
        aria-valuemax={360}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <span className="accent-wheel-shade" style={{ background: shadeOverlay }} />
        <span className="accent-wheel-marker" style={{ left: `${markerX}%`, top: `${markerY}%`, background: accent }} />
      </div>

      <div className="accent-controls">
        <div className="accent-current">
          <span className="accent-swatch large" style={{ background: accent }} />
          <div>
            <strong>{presetName || 'Custom color'}</strong>
            <span>{accent.toUpperCase()}</span>
          </div>
        </div>

        <div className="accent-presets" role="group" aria-label="Preset colors">
          {PRESETS.map(preset => (
            <button
              key={preset.color}
              className={preset.color === accent.toLowerCase() ? 'selected' : ''}
              style={{ background: preset.color }}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={preset.color === accent.toLowerCase()}
              onClick={() => choose(preset.color)}
            />
          ))}
        </div>

        <label className="accent-brightness">
          Brightness
          <input
            type="range"
            min={8}
            max={92}
            value={Math.round(lightness * 100)}
            style={{ background: `linear-gradient(90deg, #000, ${hslToHex({ h, s: Math.max(s, 0.6), l: 0.5 })}, #fff)` }}
            onChange={(event) => changeLightness(Number(event.target.value) / 100)}
            onPointerUp={() => save(accent)}
            onKeyUp={() => save(accent)}
            aria-label="Brightness"
          />
        </label>
        {adjusted && <p className="accent-note">Very {lightness > ACCENT_LIGHTNESS.max ? 'light' : 'dark'} colors are adjusted a little in File Box so text stays readable.</p>}

        <label className="accent-exact">
          Exact color
          <input
            type="color"
            value={accent}
            onChange={(event) => { if (isHexColor(event.target.value)) { setLightness(hexToHsl(event.target.value).l); preview(event.target.value); } }}
            onBlur={(event) => { if (isHexColor(event.target.value)) save(event.target.value); }}
          />
        </label>

        <div className="accent-actions">
          <button className="btn-secondary" onClick={() => choose(DEFAULT_ACCENT)} disabled={accent.toLowerCase() === DEFAULT_ACCENT}>Reset to File Box green</button>
          <span className="accent-status" role="status">{status}</span>
        </div>

        <div className="accent-preview" aria-hidden="true">
          <button className="btn-primary" tabIndex={-1}>Primary button</button>
          <span className="accent-preview-chip">Selected item</span>
          <span className="accent-preview-text">Links and highlights</span>
        </div>
      </div>
    </div>
  );
};

export default AccentPicker;
