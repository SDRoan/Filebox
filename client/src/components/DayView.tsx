import React, { useCallback, useEffect, useRef, useState } from 'react';
import { homeAPI, DayOverview, DaySummary, DayFile } from '../services/api';
import { FileRowItem } from './FileRowList';
import { AIAssistantIcon, DocumentIcon, RefreshIcon } from './Icons';
import './DayView.css';

interface DayViewProps {
  onOpenFile: (file: FileRowItem) => void;
  /** Rule-based suggestion cards from Home, shown under File Box AI's suggestions. */
  children?: React.ReactNode;
}

const ACTION_WORDS: Record<string, string> = {
  uploaded: 'uploaded', created: 'created', edited: 'edited', downloaded: 'downloaded', deleted: 'moved to Trash',
  restored: 'restored', renamed: 'renamed', moved: 'moved', copied: 'copied', shared: 'shared', starred: 'starred',
  unstarred: 'unstarred', version_created: 'saved a version', version_restored: 'restored a version',
  commented: 'commented', viewed: 'opened', asked: 'asked about',
};

const pad = (n: number) => String(n).padStart(2, '0');
const toDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toDate(new Date());
const yesterday = () => toDate(new Date(Date.now() - 24 * 3600000));

const dayLabel = (date: string) => {
  if (date === today()) return 'Today';
  if (date === yesterday()) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });

const minutesLabel = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`);

const describeFile = (file: DayFile) => Object.entries(file.actions)
  .filter(([action]) => action !== 'focused')
  .map(([action, n]) => `${ACTION_WORDS[action] || action}${n > 1 ? ` ×${n}` : ''}`)
  .join(' · ');

/**
 * "Your day" on Home: what you did in File Box on a day, File Box AI's summary and suggestions,
 * the files you spent time on and an hour-by-hour timeline. Only activity inside File Box is shown.
 */
const DayView: React.FC<DayViewProps> = ({ onOpenFile, children }) => {
  const [date, setDate] = useState(today());
  const [day, setDay] = useState<DayOverview | null>(null);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');

  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopPolling = () => { if (pollTimer.current) clearTimeout(pollTimer.current); pollTimer.current = undefined; };

  // Check back every few seconds while File Box AI writes the summary in the background.
  const poll = useCallback((forDate: string, tries = 0) => {
    stopPolling();
    pollTimer.current = setTimeout(async () => {
      try {
        const result = await homeAPI.getDay(forDate);
        setDay(result);
        if (result.summary && !result.writing) {
          setSummary(result.summary);
          setWriting(false);
          return;
        }
      } catch { /* keep trying for a while */ }
      if (tries < 45) poll(forDate, tries + 1);
      else setWriting(false);
    }, 4000);
  }, []);

  const writeSummary = useCallback(async (forDate: string, force = false) => {
    setWriting(true);
    try {
      await homeAPI.writeDaySummary(forDate, force);
      poll(forDate);
    } catch {
      setWriting(false);
    }
  }, [poll]);

  const load = useCallback(async (forDate: string) => {
    setError('');
    stopPolling();
    try {
      const result = await homeAPI.getDay(forDate);
      setDay(result);
      setSummary(result.summary);
      if (result.writing) { setWriting(true); poll(forDate); }
      else if (!result.summary && !result.facts.empty) writeSummary(forDate);
      else setWriting(false);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Could not load your day.');
    }
  }, [poll, writeSummary]);

  useEffect(() => () => stopPolling(), []);
  useEffect(() => { load(date); }, [date, load]);

  // Day picker: today, yesterday, then other recent days that have activity.
  const dayOptions = [today(), yesterday(), ...(day?.days || []).map(d => d.date)]
    .filter((d, i, all) => all.indexOf(d) === i)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 7);
  const activeDays = new Set((day?.days || []).map(d => d.date));
  const facts = day?.facts;
  const totals = facts?.totals;

  return (
    <section className="overview-section day-view" aria-labelledby="day-title">
      <div className="day-head">
        <h2 id="day-title">Your day</h2>
        <div className="day-picker" role="tablist" aria-label="Choose a day">
          {dayOptions.map(option => (
            <button
              key={option}
              role="tab"
              aria-selected={option === date}
              className={`${option === date ? 'selected' : ''} ${activeDays.has(option) ? 'has-activity' : ''}`}
              onClick={() => setDate(option)}
            >
              {dayLabel(option)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="overview-error" role="alert">
          <span>{error}</span>
          <button className="btn-secondary" onClick={() => load(date)}>Try again</button>
        </div>
      )}

      {!day && !error && <div className="home-skeleton" aria-busy="true" aria-label="Loading your day" />}

      {facts && facts.empty && (
        <div className="day-empty">
          <p>{date === today() ? 'Nothing yet today.' : `Nothing happened in File Box on ${dayLabel(date)}.`} Open, upload, edit or ask File Box about your files, and your day will show up here.</p>
        </div>
      )}

      {facts && !facts.empty && totals && (
        <>
          <article className="day-summary" aria-live="polite">
            <div className="day-summary-head">
              <AIAssistantIcon size={16} />
              <span>{summary?.basic ? 'Summary' : 'File Box AI summary'}</span>
              <button className="day-refresh" onClick={() => writeSummary(date, true)} disabled={writing} title="Write the summary again">
                <RefreshIcon size={13} /> {writing ? 'Writing…' : 'Refresh'}
              </button>
            </div>
            {summary?.summary ? <p className="day-summary-text">{summary.summary}</p> : (
              <p className="day-summary-text muted">{writing ? 'File Box AI is writing a summary of your day…' : 'No summary yet.'}</p>
            )}
            {summary?.highlights?.length ? (
              <ul className="day-highlights">{summary.highlights.map(h => <li key={h}>{h}</li>)}</ul>
            ) : null}
            {summary?.basic && <p className="day-note">File Box AI was not running, so this is a basic summary. It will write a fuller one when it is.</p>}
          </article>

          <dl className="day-stats">
            <div><dt>Time in files</dt><dd>{totals.activeMinutes ? minutesLabel(totals.activeMinutes) : '–'}</dd></div>
            <div><dt>Files worked on</dt><dd>{totals.filesWorkedOn}</dd></div>
            <div><dt>Uploaded</dt><dd>{totals.uploaded}</dd></div>
            <div><dt>Edited</dt><dd>{totals.edited}</dd></div>
            <div><dt>Opened</dt><dd>{totals.viewed}</dd></div>
            <div><dt>Questions to AI</dt><dd>{totals.questions}</dd></div>
          </dl>

          <div className="day-columns">
            <div>
              <h3>What you worked on</h3>
              <ul className="day-files">
                {facts.files.map(file => (
                  <li key={file.fileId}>
                    <button
                      disabled={!file.exists}
                      onClick={() => onOpenFile({ _id: file.fileId, originalName: file.name, parentFolder: file.parentFolder } as unknown as FileRowItem)}
                      title={file.about || file.name}
                    >
                      <DocumentIcon size={15} />
                      <span className="day-file-name">{file.name}</span>
                      {file.kind && <span className="day-file-kind">{file.kind}</span>}
                      <span className="day-file-detail">{[describeFile(file), file.minutes ? minutesLabel(file.minutes) : ''].filter(Boolean).join(' · ') || 'opened'}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {facts.questions.length > 0 && (
                <>
                  <h3>You asked File Box AI</h3>
                  <ul className="day-questions">{facts.questions.slice(-6).map(q => <li key={`${q.at}-${q.question}`}>“{q.question}”</li>)}</ul>
                </>
              )}
            </div>
            <div>
              <h3>Timeline</h3>
              <ol className="day-timeline">
                {facts.timeline.map(slot => (
                  <li key={slot.hour}>
                    <time>{hourLabel(slot.hour)}</time>
                    <ul>{slot.items.map(item => <li key={item}>{item}</li>)}</ul>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}

      {(summary?.suggestions?.length || children) ? (
        <div className="day-suggestions">
          <h3>Suggestions</h3>
          {summary?.suggestions?.length ? (
            <ul className="day-ai-suggestions">{summary.suggestions.map(s => <li key={s}><AIAssistantIcon size={13} /> {s}</li>)}</ul>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  );
};

export default DayView;
