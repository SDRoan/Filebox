import api from './api';
import type { GraphConnections, GraphScope } from '../utils/boardGraph';

/** The file relationships for a tab's Connections view. Read-only: Board connectors come from the open Board instead. */
export const getBoardConnections = async (tabId: string, scope: GraphScope, signal?: AbortSignal): Promise<GraphConnections> => {
  const response = await api.get(`/workspace-boards/tabs/${tabId}/connections`, { params: { scope }, signal });
  return response.data;
};
