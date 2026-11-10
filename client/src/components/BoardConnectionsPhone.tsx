import React, { useMemo } from 'react';
import { GraphEdge, GraphModel, GraphNode, relationshipLabel } from '../utils/boardGraph';
import { ITEM_ICONS } from './BoardItemIcons';

/** Connections on a phone: each connected item with what it joins, read-only. A graph would be too small to use here. */

const WHERE = { item: 'On this Board', 'list-file': 'In a File List', 'off-board': 'Not on this Board' } as const;

const BoardConnectionsPhone: React.FC<{ model: GraphModel; order: string[]; visibleEdges: Set<string>; matches: Set<string> | null }> = ({ model, order, visibleEdges, matches }) => {
  const nodeByKey = useMemo(() => new Map(model.nodes.map(n => [n.key, n])), [model.nodes]);
  const edgesOf = useMemo(() => {
    const out = new Map<string, GraphEdge[]>();
    model.edges.forEach((e) => {
      if (!visibleEdges.has(e.key)) return;
      [e.source, e.target].forEach((key) => out.set(key, [...(out.get(key) || []), e]));
    });
    return out;
  }, [model.edges, visibleEdges]);

  const groups = order.map(key => nodeByKey.get(key)).filter((n): n is GraphNode => Boolean(n && edgesOf.has(n.key) && (!matches || matches.has(n.key))));
  if (!groups.length) return null;

  return (
    <ul className="board-connections-phone" aria-label="Connections">
      {groups.map(node => (
        <li key={node.key} className={`board-connections-phone-group is-${node.kind}${node.available ? '' : ' is-unavailable'}`} data-node-key={node.key}>
          <h3>
            <span className="board-graph-node-icon" aria-hidden="true">{ITEM_ICONS[node.itemType]}</span>
            <span className="board-graph-node-text">
              <span className="board-graph-node-name">{node.shortName}</span>
              <span className="board-graph-node-where">{node.available ? WHERE[node.kind] : 'Unavailable'}</span>
            </span>
          </h3>
          <ul>
            {(edgesOf.get(node.key) as GraphEdge[]).map((edge) => {
              const outgoing = edge.source === node.key;
              const other = nodeByKey.get(outgoing ? edge.target : edge.source);
              const words = edge.system === 'file' ? relationshipLabel(edge) : edge.style === 'arrow' ? 'Arrow' : 'Line';
              return (
                <li key={edge.key} className={`is-${edge.system}`} data-edge-key={edge.key}>
                  <span className="board-connections-phone-arrow" aria-hidden="true">{!edge.directed ? '—' : outgoing ? '→' : '←'}</span>
                  <span className="board-connections-phone-text">
                    <span className="board-connections-phone-other">{other?.shortName}</span>
                    <span className="board-connections-phone-kind">{edge.directed && !outgoing ? `${words} (incoming)` : words} · {edge.system === 'file' ? 'File relationship' : 'Board connector'}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
};

export default BoardConnectionsPhone;
