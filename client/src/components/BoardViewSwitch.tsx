import React from 'react';

export type BoardView = 'canvas' | 'connections';

/** Canvas or Connections for the open Board tab. The address holds which one, so Back and Forward work. */
const BoardViewSwitch: React.FC<{ view: BoardView; onChange: (view: BoardView) => void }> = ({ view, onChange }) => (
  <div className="board-view-switch" role="group" aria-label="Board view">
    <button type="button" aria-pressed={view === 'canvas'} onClick={() => onChange('canvas')}>Canvas</button>
    <button type="button" aria-pressed={view === 'connections'} onClick={() => onChange('connections')}>Connections</button>
  </div>
);

export default BoardViewSwitch;
