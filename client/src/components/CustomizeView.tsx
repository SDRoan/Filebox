import React, { useRef, useState } from 'react';
import AccentPicker from './AccentPicker';
import FontSelect from './FontSelect';
import { sidebarSections, orderedItems, navLabel } from './Sidebar';
import { useAppearance } from '../context/AppearanceContext';
import { preferencesAPI } from '../services/api';
import { DEFAULT_ACCENT, applyAccent, isHexColor, rememberAccent, storedAccent } from '../theme/accent';
import {
  Appearance, BACKGROUND_BLUR, BACKGROUND_FADE, BACKGROUND_PRESETS, DEFAULT_APPEARANCE, MAX_CUSTOM_CSS, ROUNDNESS, TEXT_SCALE, THEME_PRESETS, ThemePreset,
  customCssPaused, darkModeLook, fontStack, isBackgroundImage, isDark, isImageUrl, prepareBackgroundImage, presetAppearance, sanitizeAppearance,
} from '../theme/appearance';
import { workspacePages } from '../config/workspaceNavigation';
import { ArrowUpIcon, ChevronDownIcon, CheckIcon, DownloadIcon, UploadIcon } from './Icons';
import './OverviewPages.css';
import './CustomizeView.css';

type Tab = 'themes' | 'colors' | 'background' | 'text' | 'shape' | 'sidebar' | 'home' | 'css' | 'backup';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'themes', label: 'Themes' },
  { id: 'colors', label: 'Colors' },
  { id: 'background', label: 'Background' },
  { id: 'text', label: 'Text' },
  { id: 'shape', label: 'Shape & motion' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'home', label: 'Home' },
  { id: 'css', label: 'Custom CSS' },
  { id: 'backup', label: 'Save & reset' },
];

// File Box's own colors for the parts a person can recolor (used when they have not chosen one).
const DEFAULT_COLORS = { page: '#fdfdfb', surface: '#ffffff', sidebar: '#f5f5f0', header: '#fdfdfb' };

const CSS_EXAMPLE = `/* Examples — change or delete any of these. */
.sidebar .nav-item.active { font-weight: 700; }
.home-hero h1 { letter-spacing: 0; }
.btn-primary { text-transform: uppercase; letter-spacing: .06em; }
`;

const CSS_HOOKS: Array<[string, string]> = [
  ['.dashboard', 'the whole workspace'],
  ['.sidebar', 'the sidebar; .nav-item for its links, .nav-item.active for the current page'],
  ['.dashboard-header', 'the bar at the top with search'],
  ['.dashboard-content', 'the page area'],
  ['.overview-page h1, .home-hero h1', 'page titles'],
  ['.btn-primary, .btn-secondary', 'buttons'],
  ['--fb-page-bg, --fb-surface, --fb-sidebar-bg', 'colors (variables)'],
  ['--font-sans, --fb-heading-font, --fb-radius-scale', 'fonts and corners (variables)'],
];

const STATUS_TEXT = { '': '', saving: 'Saving…', saved: 'Saved to your account', local: 'Saved in this browser only (could not reach File Box)' };

/** How a theme looks, drawn with fixed colors so the sample is right in light and dark mode alike. */
const ThemeSample: React.FC<{ preset: ThemePreset }> = ({ preset }) => {
  const look = presetAppearance(preset, DEFAULT_APPEARANCE);
  const dark = look.mode === 'dark';
  const shown = (hex: string) => (dark ? darkModeLook(hex) : hex);
  const radius = 6 * look.roundness;
  return (
    <span className="theme-sample fb-true-color" aria-hidden="true" style={{ background: shown(look.pageColor || DEFAULT_COLORS.page), borderRadius: radius + 2 }}>
      <span className="theme-sample-side" style={{ background: shown(look.sidebarColor || DEFAULT_COLORS.sidebar) }}>
        <span style={{ background: shown(preset.accent), borderRadius: radius }} />
        <span style={{ background: dark ? '#ffffff22' : '#00000014', borderRadius: radius }} />
        <span style={{ background: dark ? '#ffffff22' : '#00000014', borderRadius: radius }} />
      </span>
      <span className="theme-sample-main">
        <span className="theme-sample-title" style={{ fontFamily: fontStack(look.headingFont), color: dark ? '#e8ece6' : '#2c3829' }}>Aa</span>
        <span className="theme-sample-card" style={{ background: shown(look.surfaceColor || DEFAULT_COLORS.surface), borderRadius: radius, fontFamily: fontStack(look.bodyFont), color: dark ? '#b8c0b4' : '#56644c' }}>Files</span>
      </span>
    </span>
  );
};

const Segmented = <T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void;
}) => (
  <div className="customize-segmented" role="radiogroup" aria-label={label}>
    {options.map(option => (
      <button key={option.value} role="radio" aria-checked={value === option.value} className={value === option.value ? 'selected' : ''} onClick={() => onChange(option.value)}>
        {option.label}
      </button>
    ))}
  </div>
);

const Toggle: React.FC<{ label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label className="customize-toggle">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span className="customize-toggle-track" aria-hidden="true"><span /></span>
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
  </label>
);

const ColorChoice: React.FC<{ label: string; hint: string; value: string | null; fallback: string; dark: boolean; onChange: (value: string | null) => void }> = ({
  label, hint, value, fallback, dark, onChange,
}) => (
  <div className="customize-color">
    <label>
      <input type="color" className="fb-true-color" value={value || fallback} onChange={(event) => { if (isHexColor(event.target.value)) onChange(event.target.value.toLowerCase()); }} />
      <span><strong>{label}</strong><small>{value ? value.toUpperCase() : 'File Box default'} · {hint}</small></span>
    </label>
    {value && <button className="btn-secondary" onClick={() => onChange(null)}>Use default</button>}
    {value && !dark && isDark(value) && <p className="customize-note">Dark colors read best with Dark mode on (Colors › Mode), since text stays dark in Light mode.</p>}
    {value && dark && !isDark(value) && <p className="customize-note">Light colors read best with Light mode, since text is light in Dark mode.</p>}
  </div>
);

/**
 * Settings > Customize: everything about how File Box looks and is laid out. Every change shows at once
 * (File Box itself is the preview) and is saved with the account.
 */
const CustomizeView: React.FC = () => {
  const { appearance, update, updateSidebar, updateHome, updateBackground, backgroundImage, setBackgroundImage, replace, status } = useAppearance();
  const [tab, setTab] = useState<Tab>('themes');
  const [accentKey, setAccentKey] = useState(0);
  const [message, setMessage] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const pictureRef = useRef<HTMLInputElement>(null);
  const [pictureBusy, setPictureBusy] = useState(false);
  const [linkDraft, setLinkDraft] = useState(appearance.background.url);
  const bg = appearance.background;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const layout = appearance.sidebar;
  const dark = appearance.mode === 'dark';

  const setAccent = (accent: string) => {
    const value = accent.toLowerCase() === DEFAULT_ACCENT ? null : accent.toLowerCase();
    applyAccent(value);
    rememberAccent(value);
    setAccentKey(key => key + 1);
    preferencesAPI.setAccent(value).catch(() => { /* kept in this browser */ });
  };

  const applyPreset = (preset: ThemePreset) => {
    replace(presetAppearance(preset, appearance));
    setAccent(preset.accent);
    setMessage(`${preset.name} theme applied. Your sidebar, Home and custom CSS were kept.`);
  };

  const activePreset = THEME_PRESETS.find(preset => {
    const look = presetAppearance(preset, appearance);
    return (storedAccent() || DEFAULT_ACCENT) === preset.accent && JSON.stringify(look) === JSON.stringify(appearance);
  });

  // Sidebar: move a link up or down within its group.
  const moveItem = (sectionId: string, id: string, direction: -1 | 1) => {
    const all = sidebarSections.map(section => orderedItems(section, layout).map(item => item.id));
    const group = all[sidebarSections.findIndex(section => section.id === sectionId)];
    const from = group.indexOf(id);
    const to = from + direction;
    if (to < 0 || to >= group.length) return;
    [group[from], group[to]] = [group[to], group[from]];
    updateSidebar({ order: all.flat() });
  };
  const toggleHidden = (id: string, visible: boolean) =>
    updateSidebar({ hidden: visible ? layout.hidden.filter(hidden => hidden !== id) : [...layout.hidden, id] });

  const applyPicture = async (file: File) => {
    if (!file.type.startsWith('image/')) { setMessage('Choose a picture file (JPEG, PNG, WebP, HEIC…).'); return; }
    setPictureBusy(true);
    setMessage('');
    try {
      const image = await prepareBackgroundImage(file);
      updateBackground({ kind: 'image' });
      await setBackgroundImage(image);
      setMessage(`“${file.name}” is now your background.`);
    } catch (err: any) {
      setMessage(err?.response ? 'The picture is shown here but could not be saved to your account. Try a smaller picture.' : (err?.message || 'That picture could not be opened.'));
    } finally {
      setPictureBusy(false);
    }
  };

  const applyLink = () => {
    const url = linkDraft.trim();
    if (!isImageUrl(url)) { setMessage('Paste a full picture link that starts with https://'); return; }
    updateBackground({ kind: 'url', url });
    setMessage('Background set from the link. If it stays blank, that site may not allow its pictures to be shown elsewhere.');
  };

  const exportLook = () => {
    const data = { fileBoxLook: 1, accent: storedAccent() || DEFAULT_ACCENT, appearance, backgroundImage: bg.kind === 'image' ? backgroundImage : null };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(appearance.brandName.trim() || 'file-box').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-look.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage('Your look was downloaded. Import it here on any File Box to get the same design.');
  };

  const importLook = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || !('appearance' in data)) throw new Error('not a look');
      replace(sanitizeAppearance(data.appearance));
      if (isHexColor(data.accent)) setAccent(data.accent);
      if (isBackgroundImage(data.backgroundImage)) setBackgroundImage(data.backgroundImage).catch(() => { /* shown here; saving can be retried */ });
      setMessage(`Imported “${file.name}”.`);
    } catch {
      setMessage('That file is not a File Box look. Choose a file saved with “Download my look”.');
    }
  };

  const resetAll = () => {
    if (!window.confirm('Go back to File Box’s original look and layout? Your current design will be replaced (download it first to keep a copy).')) return;
    replace(DEFAULT_APPEARANCE);
    setAccent(DEFAULT_ACCENT);
    setMessage('File Box is back to its original look.');
  };

  const resetPart = (part: Partial<Appearance>, what: string) => {
    update(part);
    setMessage(`${what} reset.`);
  };

  // Tabs: arrow keys move between them.
  const onTabKey = (event: React.KeyboardEvent) => {
    const index = TABS.findIndex(t => t.id === tab);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length];
    setTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <div className="overview-page customize-view">
      <header className="overview-header customize-header">
        <div>
          <h1>Customize</h1>
          <p>Redesign File Box the way you like it. Every change shows right away and is saved to your account.</p>
        </div>
        <span className="customize-status" role="status">{STATUS_TEXT[status]}</span>
      </header>

      <div className="customize-tabs" role="tablist" aria-label="What to customize" onKeyDown={onTabKey}>
        {TABS.map(t => (
          <button
            key={t.id}
            ref={el => { tabRefs.current[t.id] = el; }}
            role="tab"
            id={`customize-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="customize-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'selected' : ''}
            onClick={() => { setTab(t.id); setMessage(''); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {message && <p className="customize-message" role="status">{message}</p>}

      <section className="customize-panel" id="customize-panel" role="tabpanel" aria-labelledby={`customize-tab-${tab}`}>
        {tab === 'themes' && (
          <>
            <p className="customize-intro">Start from a complete look, then fine-tune anything in the other tabs.</p>
            <div className="customize-themes">
              {THEME_PRESETS.map(preset => (
                <button key={preset.id} className={`theme-card ${activePreset?.id === preset.id ? 'selected' : ''}`} aria-pressed={activePreset?.id === preset.id} onClick={() => applyPreset(preset)}>
                  <ThemeSample preset={preset} />
                  <strong>{preset.name}{activePreset?.id === preset.id && <CheckIcon size={14} />}</strong>
                  <small>{preset.description}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'colors' && (
          <>
            <div className="customize-field">
              <h3>Mode</h3>
              <Segmented label="Mode" value={appearance.mode} onChange={(mode) => update({ mode })}
                options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              <p className="customize-hint">Dark mode darkens every page. Pictures and previews keep their real colors.</p>
            </div>
            <div className="customize-field">
              <h3>Accent color</h3>
              <AccentPicker key={accentKey} />
            </div>
            <div className="customize-field">
              <h3>Backgrounds</h3>
              <div className="customize-colors">
                <ColorChoice label="Page" hint="behind everything" value={appearance.pageColor} fallback={DEFAULT_COLORS.page} dark={dark} onChange={(pageColor) => update({ pageColor })} />
                <ColorChoice label="Cards and panels" hint="menus, dialogs, file cards" value={appearance.surfaceColor} fallback={DEFAULT_COLORS.surface} dark={dark} onChange={(surfaceColor) => update({ surfaceColor })} />
                <ColorChoice label="Top bar" hint="the bar with search at the top" value={appearance.headerColor} fallback={appearance.pageColor || DEFAULT_COLORS.header} dark={dark} onChange={(headerColor) => update({ headerColor })} />
                <ColorChoice label="Sidebar" hint="the navigation on the side" value={appearance.sidebarColor} fallback={DEFAULT_COLORS.sidebar} dark={dark} onChange={(sidebarColor) => update({ sidebarColor })} />
              </div>
            </div>
          </>
        )}

        {tab === 'background' && (
          <>
            <div className="customize-field">
              <h3>Background</h3>
              <Segmented label="Background" value={bg.kind === 'url' ? 'image' : bg.kind} onChange={(kind) => {
                if (kind === 'preset') updateBackground({ kind, preset: bg.preset || BACKGROUND_PRESETS[0].id });
                else if (kind === 'image') updateBackground({ kind: backgroundImage || !bg.url ? 'image' : 'url' });
                else updateBackground({ kind });
              }} options={[{ value: 'none', label: 'None' }, { value: 'preset', label: 'Gradient or pattern' }, { value: 'image', label: 'Picture' }]} />
            </div>

            {bg.kind === 'preset' && (
              <div className="customize-backgrounds" role="radiogroup" aria-label="Backgrounds">
                {BACKGROUND_PRESETS.map(preset => (
                  <button key={preset.id} role="radio" aria-checked={bg.preset === preset.id} className={bg.preset === preset.id ? 'selected' : ''} onClick={() => updateBackground({ preset: preset.id })}>
                    <span className="customize-background-sample fb-true-color" style={{ background: preset.css }} />
                    <span>{preset.name}{bg.preset === preset.id && <CheckIcon size={13} />}</span>
                  </button>
                ))}
              </div>
            )}

            {(bg.kind === 'image' || bg.kind === 'url') && (
              <div className="customize-field customize-picture">
                <div className="customize-picture-row">
                  <span className="customize-picture-preview fb-true-color" style={{ backgroundImage: bg.kind === 'image' && backgroundImage ? `url("${backgroundImage}")` : bg.kind === 'url' && bg.url ? `url("${bg.url}")` : undefined }}>
                    {!(bg.kind === 'image' ? backgroundImage : bg.url) && 'No picture yet'}
                  </span>
                  <div className="customize-picture-actions">
                    <button className="btn-primary" disabled={pictureBusy} onClick={() => pictureRef.current?.click()}><UploadIcon size={15} /> {pictureBusy ? 'Preparing…' : 'Upload a picture'}</button>
                    <small className="customize-hint">From your computer. Large pictures are shrunk to load fast.</small>
                    {bg.kind === 'image' && backgroundImage && <button className="btn-secondary" onClick={() => { setBackgroundImage(null).catch(() => {}); updateBackground({ kind: 'none' }); }}>Remove picture</button>}
                  </div>
                  <input ref={pictureRef} type="file" accept="image/*" hidden onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) applyPicture(file);
                  }} />
                </div>
                <label className="customize-text customize-link">
                  <strong>Or use a picture from the web</strong>
                  <span>
                    <input value={linkDraft} placeholder="https://…/picture.jpg" onChange={(event) => setLinkDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyLink(); }} />
                    <button className="btn-secondary" onClick={applyLink}>Use link</button>
                  </span>
                </label>
              </div>
            )}

            {bg.kind !== 'none' && (
              <>
                <div className="customize-field">
                  <h3>Readability</h3>
                  <div className="customize-range">
                    <span className="customize-range-label">Fade</span>
                    <input type="range" min={BACKGROUND_FADE.min * 100} max={BACKGROUND_FADE.max * 100} step={5} value={Math.round(bg.fade * 100)}
                      aria-label="Fade the background" aria-valuetext={`${Math.round(bg.fade * 100)}%`} onChange={(event) => updateBackground({ fade: Number(event.target.value) / 100 })} />
                    <output>{Math.round(bg.fade * 100)}%</output>
                  </div>
                  <div className="customize-range">
                    <span className="customize-range-label">Blur</span>
                    <input type="range" min={BACKGROUND_BLUR.min} max={BACKGROUND_BLUR.max} step={1} value={bg.blur}
                      aria-label="Blur the background" aria-valuetext={`${bg.blur} pixels`} onChange={(event) => updateBackground({ blur: Number(event.target.value) })} />
                    <output>{bg.blur ? `${bg.blur}px` : 'None'}</output>
                  </div>
                  <p className="customize-hint">Fade lays the page color over the background so text stays easy to read. Cards and panels stay solid.</p>
                  {bg.fade < 0.45 && <p className="customize-note">With little fade, text on the page can be hard to read over busy or dark pictures. Raise the fade if it is.</p>}
                </div>
                <Toggle label="Show behind the sidebar too" hint="The sidebar becomes see-through." checked={bg.behindSidebar} onChange={(behindSidebar) => updateBackground({ behindSidebar })} />
              </>
            )}
          </>
        )}

        {tab === 'text' && (
          <>
            <FontSelect label="Text font" value={appearance.bodyFont} onChange={(bodyFont) => update({ bodyFont })} />
            <FontSelect label="Heading font" value={appearance.headingFont} onChange={(headingFont) => update({ headingFont })} />
            <p className="customize-hint">Google fonts load from Google Fonts the first time they’re used; File Box and installed fonts need no download.</p>
            <div className="customize-field">
              <h3>Text and interface size</h3>
              <div className="customize-range">
                <span style={{ fontSize: 12 }}>A</span>
                <input type="range" min={TEXT_SCALE.min * 100} max={TEXT_SCALE.max * 100} step={5}
                  value={Math.round(appearance.textScale * 100)} aria-label="Text and interface size" aria-valuetext={`${Math.round(appearance.textScale * 100)}%`}
                  onChange={(event) => update({ textScale: Number(event.target.value) / 100 })} />
                <span style={{ fontSize: 20 }}>A</span>
                <output>{Math.round(appearance.textScale * 100)}%</output>
              </div>
              <p className="customize-hint">Makes everything in File Box larger or smaller together.</p>
            </div>
            <button className="btn-secondary" onClick={() => resetPart({ bodyFont: DEFAULT_APPEARANCE.bodyFont, headingFont: DEFAULT_APPEARANCE.headingFont, textScale: 1 }, 'Text')}>Reset text</button>
          </>
        )}

        {tab === 'shape' && (
          <>
            <div className="customize-field">
              <h3>Corners</h3>
              <div className="customize-range">
                <span className="corner-sample" style={{ borderRadius: 0 }} aria-hidden="true" />
                <input type="range" min={ROUNDNESS.min * 100} max={ROUNDNESS.max * 100} step={10}
                  value={Math.round(appearance.roundness * 100)} aria-label="Corner roundness" aria-valuetext={appearance.roundness === 0 ? 'Square' : `${Math.round(appearance.roundness * 100)}%`}
                  onChange={(event) => update({ roundness: Number(event.target.value) / 100 })} />
                <span className="corner-sample" style={{ borderRadius: 12 }} aria-hidden="true" />
                <output>{appearance.roundness === 0 ? 'Square' : `${Math.round(appearance.roundness * 100)}%`}</output>
              </div>
              <div className="corner-preview" aria-hidden="true">
                <span className="btn-primary">Button</span>
                <span className="corner-preview-card">Card</span>
              </div>
            </div>
            <div className="customize-field">
              <h3>Motion</h3>
              <Toggle label="Reduce motion" hint="Turn off animations and sliding effects." checked={appearance.reduceMotion} onChange={(reduceMotion) => update({ reduceMotion })} />
            </div>
            <button className="btn-secondary" onClick={() => resetPart({ roundness: 1, reduceMotion: false }, 'Shape and motion')}>Reset shape and motion</button>
          </>
        )}

        {tab === 'sidebar' && (
          <>
            <div className="customize-field customize-inline">
              <label className="customize-text">
                <strong>Workspace name</strong>
                <input value={appearance.brandName} maxLength={30} placeholder="File Box" onChange={(event) => update({ brandName: event.target.value })} />
                <small>Shown next to the logo and at the top of each page.</small>
              </label>
            </div>
            <div className="customize-field customize-row">
              <div>
                <h3>Position</h3>
                <Segmented label="Sidebar position" value={layout.position} onChange={(position) => updateSidebar({ position })}
                  options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
              </div>
              <div>
                <h3>Style</h3>
                <Segmented label="Sidebar style" value={layout.style} onChange={(style) => updateSidebar({ style })}
                  options={[{ value: 'full', label: 'Icons and names' }, { value: 'icons', label: 'Icons only' }]} />
              </div>
            </div>
            <Toggle label="Show group titles" hint="AI, Collaboration, Tools…" checked={layout.showSectionTitles} onChange={(showSectionTitles) => updateSidebar({ showSectionTitles })} />

            <div className="customize-field">
              <h3>Links</h3>
              <p className="customize-hint">Show, hide, rename and reorder. Settings always stays at the bottom so you can come back here.</p>
              {sidebarSections.map(section => {
                const items = orderedItems(section, layout);
                return (
                  <div key={section.id} className="customize-nav-group">
                    {section.title && (
                      <input className="customize-nav-group-title" aria-label={`Name of the ${section.title} group`} value={layout.sectionTitles[section.id] ?? ''}
                        placeholder={section.title} maxLength={40}
                        onChange={(event) => updateSidebar({ sectionTitles: { ...layout.sectionTitles, [section.id]: event.target.value } })} />
                    )}
                    <ul>
                      {items.map(({ id, Icon }, index) => {
                        const visible = !layout.hidden.includes(id);
                        const original = workspacePages.find(page => page.id === id)?.label || id;
                        return (
                          <li key={id} className={visible ? '' : 'hidden-item'}>
                            <label className="customize-nav-visible" title={visible ? 'Shown' : 'Hidden'}>
                              <input type="checkbox" checked={visible} onChange={(event) => toggleHidden(id, event.target.checked)} aria-label={`Show ${navLabel(id, layout)}`} />
                            </label>
                            <Icon size={16} />
                            <input className="customize-nav-label" value={layout.labels[id] ?? ''} placeholder={original} maxLength={40} aria-label={`Name for ${original}`}
                              onChange={(event) => updateSidebar({ labels: { ...layout.labels, [id]: event.target.value } })} />
                            <span className="customize-nav-move">
                              <button onClick={() => moveItem(section.id, id, -1)} disabled={index === 0} aria-label={`Move ${navLabel(id, layout)} up`}><ArrowUpIcon size={14} /></button>
                              <button onClick={() => moveItem(section.id, id, 1)} disabled={index === items.length - 1} aria-label={`Move ${navLabel(id, layout)} down`}><ChevronDownIcon size={14} /></button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    {section.title && !layout.showSectionTitles && <small className="customize-hint">Group titles are hidden.</small>}
                  </div>
                );
              })}
            </div>
            <button className="btn-secondary" onClick={() => resetPart({ sidebar: DEFAULT_APPEARANCE.sidebar, brandName: '' }, 'Sidebar')}>Reset sidebar</button>
          </>
        )}

        {tab === 'home' && (
          <>
            <div className="customize-field">
              <label className="customize-text">
                <strong>Home title</strong>
                <input value={appearance.home.title} maxLength={60} placeholder="Ask File Box" onChange={(event) => updateHome({ title: event.target.value })} />
              </label>
            </div>
            <div className="customize-field customize-toggles">
              <h3>Show on Home</h3>
              <Toggle label="Greeting" hint="“Good morning, …”" checked={appearance.home.showGreeting} onChange={(showGreeting) => updateHome({ showGreeting })} />
              <Toggle label="Shortcuts" hint="Find something, Organize my files…" checked={appearance.home.showShortcuts} onChange={(showShortcuts) => updateHome({ showShortcuts })} />
              <Toggle label="Your day" hint="Today’s activity and its AI summary" checked={appearance.home.showDay} onChange={(showDay) => updateHome({ showDay })} />
              <Toggle label="Suggestions" hint="Things File Box noticed you could tidy up" checked={appearance.home.showSuggestions} onChange={(showSuggestions) => updateHome({ showSuggestions })} />
            </div>
            <button className="btn-secondary" onClick={() => resetPart({ home: DEFAULT_APPEARANCE.home }, 'Home')}>Reset Home</button>
          </>
        )}

        {tab === 'css' && (
          <>
            <p className="customize-intro">For anything the other tabs don’t cover, write your own CSS. It applies to File Box only for you, right away.</p>
            {customCssPaused() && <p className="customize-note">Custom CSS is paused because the address contains “?safe”. Remove it to turn your CSS back on.</p>}
            <textarea className="customize-css" spellCheck={false} value={appearance.customCss} maxLength={MAX_CUSTOM_CSS}
              placeholder={CSS_EXAMPLE} aria-label="Custom CSS" onChange={(event) => update({ customCss: event.target.value })} />
            <div className="customize-css-bar">
              <span>{appearance.customCss.length.toLocaleString()} / {MAX_CUSTOM_CSS.toLocaleString()} characters</span>
              <span>
                {!appearance.customCss && <button className="btn-secondary" onClick={() => update({ customCss: CSS_EXAMPLE })}>Insert examples</button>}
                {appearance.customCss && <button className="btn-secondary" onClick={() => resetPart({ customCss: '' }, 'Custom CSS')}>Clear</button>}
              </span>
            </div>
            <details className="customize-css-help">
              <summary>Useful places to start</summary>
              <dl>{CSS_HOOKS.map(([selector, what]) => <div key={selector}><dt><code>{selector}</code></dt><dd>{what}</dd></div>)}</dl>
              <p>If your CSS ever hides something you need, open File Box with <code>?safe</code> at the end of the address (for example <code>{window.location.origin}/customize?safe</code>) to pause it and fix it here.</p>
            </details>
          </>
        )}

        {tab === 'backup' && (
          <>
            <div className="customize-field">
              <h3>Keep or share your design</h3>
              <p className="customize-hint">Download everything you’ve chosen here, including the accent color, as a file. Import it on another account or share it with your team.</p>
              <div className="customize-actions">
                <button className="btn-primary" onClick={exportLook}><DownloadIcon size={15} /> Download my look</button>
                <button className="btn-secondary" onClick={() => importRef.current?.click()}><UploadIcon size={15} /> Import a look</button>
                <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) importLook(file);
                }} />
              </div>
            </div>
            <div className="customize-field">
              <h3>Start over</h3>
              <p className="customize-hint">Puts File Box back to its original look and layout.</p>
              <button className="btn-secondary customize-danger" onClick={resetAll}>Reset everything</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
};

export default CustomizeView;
