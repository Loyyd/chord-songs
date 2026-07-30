import { writable } from 'svelte/store';
import {
  createLiveAction,
  mergeActions,
  moveAnchorForTarget,
  replayActions,
  type LiveAction,
  type LiveState,
  type NewLiveAction,
} from '../live/liveState';

export type ConnectionStatus = 'idle' | 'authenticating' | 'connecting' | 'connected' | 'error';

export interface LiveBandSnapshot {
  status: ConnectionStatus;
  error: string | null;
  state: LiveState;
  isSynchronized: boolean;
  connectedMembers: number;
  knownMembers: number;
}

interface Peer {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
}

interface SignalPeer {
  peerId: string;
  identity: string;
}

type SignalMessage =
  | { type: 'welcome'; peerId: string; peers: SignalPeer[]; iceServers: RTCIceServer[] }
  | { type: 'peer-joined'; peer: SignalPeer }
  | { type: 'peer-left'; peerId: string }
  | { type: 'pong'; nonce: string }
  | { type: 'offer' | 'answer' | 'ice-candidate'; from: string; payload: Record<string, unknown> };

type DataMessage =
  | { type: 'log-request' }
  | { type: 'log-snapshot'; sessionId: string; actions: LiveAction[] }
  | { type: 'actions'; sessionId: string; actions: LiveAction[] };

const EMPTY_STATE: LiveState = { entries: [], activeEntryId: null };

export function createLiveBand() {
  let status: ConnectionStatus = 'idle';
  let error: string | null = null;
  let socket: WebSocket | null = null;
  let peerId: string | null = null;
  let iceServers: RTCIceServer[] = [];
  let sessionId: string | null = null;
  let actions: LiveAction[] = [];
  let counter = 0;
  let intentionalClose = false;
  let wantsConnection = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let resumeProbe: number | null = null;
  const localActor = crypto.randomUUID();
  const peers = new Map<string, Peer>();
  const knownPeerIds = new Set<string>();
  const connectedPeerIds = new Set<string>();

  const $state = writable<LiveBandSnapshot>({
    status,
    error,
    state: EMPTY_STATE,
    isSynchronized: false,
    connectedMembers: 0,
    knownMembers: 0,
  });

  const publish = () => {
    $state.set({
      status,
      error,
      state: replayActions(actions),
      isSynchronized: sessionId !== null,
      connectedMembers: status === 'connected' ? connectedPeerIds.size + 1 : 0,
      knownMembers: status === 'connected' ? knownPeerIds.size + 1 : 0,
    });
  };

  const replaceActions = (next: LiveAction[]) => {
    actions = next;
    for (const action of next) counter = Math.max(counter, action.revision.counter);
    publish();
  };

  const mergeIncomingActions = (incoming: LiveAction[]) => {
    replaceActions(mergeActions(actions, incoming));
  };

  const sendSignal = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const sendData = (channel: RTCDataChannel, message: DataMessage) => {
    if (channel.readyState === 'open') channel.send(JSON.stringify(message));
  };

  const broadcastData = (message: DataMessage) => {
    for (const peer of peers.values()) if (peer.channel) sendData(peer.channel, message);
  };

  const acceptSnapshot = (incomingSessionId: string, incomingActions: LiveAction[]) => {
    if (!sessionId) {
      sessionId = incomingSessionId;
      replaceActions(mergeActions([], incomingActions));
      return;
    }
    if (sessionId === incomingSessionId) mergeIncomingActions(incomingActions);
  };

  const handleDataMessage = (channel: RTCDataChannel, event: MessageEvent<string>) => {
    let message: DataMessage;
    try {
      message = JSON.parse(event.data) as DataMessage;
    } catch {
      return;
    }
    if (message.type === 'log-request') {
      if (sessionId) sendData(channel, { type: 'log-snapshot', sessionId, actions });
      return;
    }
    if (
      (message.type === 'log-snapshot' || message.type === 'actions') &&
      typeof message.sessionId === 'string' &&
      Array.isArray(message.actions)
    ) acceptSnapshot(message.sessionId, message.actions);
  };

  const removePeer = (remotePeerId: string) => {
    const peer = peers.get(remotePeerId);
    peer?.channel?.close();
    peer?.connection.close();
    peers.delete(remotePeerId);
    knownPeerIds.delete(remotePeerId);
    connectedPeerIds.delete(remotePeerId);
    publish();
  };

  const closePeerConnections = () => {
    for (const peer of peers.values()) {
      peer.channel?.close();
      peer.connection.close();
    }
    peers.clear();
    knownPeerIds.clear();
    connectedPeerIds.clear();
    publish();
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const clearResumeProbe = () => {
    if (resumeProbe !== null) window.clearTimeout(resumeProbe);
    resumeProbe = null;
  };

  let openSocket = () => undefined;

  const scheduleReconnect = (immediate = false) => {
    if (!wantsConnection || document.visibilityState === 'hidden' || !navigator.onLine) return;
    clearReconnectTimer();
    const delay = immediate ? 0 : Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  const attachDataChannel = (remotePeerId: string, peer: Peer, channel: RTCDataChannel) => {
    peer.channel = channel;
    channel.onopen = () => {
      connectedPeerIds.add(remotePeerId);
      publish();
      if (sessionId) sendData(channel, { type: 'log-snapshot', sessionId, actions });
      else sendData(channel, { type: 'log-request' });
    };
    channel.onmessage = (event) => handleDataMessage(channel, event);
    channel.onclose = () => {
      connectedPeerIds.delete(remotePeerId);
      publish();
    };
  };

  const createPeer = (remotePeerId: string) => {
    const existing = peers.get(remotePeerId);
    if (existing) return existing;
    const peer: Peer = {
      connection: new RTCPeerConnection({ iceServers }),
      channel: null,
      pendingCandidates: [],
    };
    peers.set(remotePeerId, peer);
    peer.connection.onicecandidate = (event) => {
      if (event.candidate) sendSignal({
        type: 'ice-candidate',
        to: remotePeerId,
        payload: { candidate: event.candidate.toJSON() },
      });
    };
    peer.connection.ondatachannel = (event) => attachDataChannel(remotePeerId, peer, event.channel);
    peer.connection.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(peer.connection.connectionState)) removePeer(remotePeerId);
    };
    return peer;
  };

  const applyPendingCandidates = async (peer: Peer) => {
    if (!peer.connection.remoteDescription) return;
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  };

  const startOffer = async (remotePeerId: string) => {
    const peer = createPeer(remotePeerId);
    const channel = peer.connection.createDataChannel('holy-songs-live', { ordered: true });
    attachDataChannel(remotePeerId, peer, channel);
    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    sendSignal({ type: 'offer', to: remotePeerId, payload: { description: peer.connection.localDescription } });
  };

  const handleSignalMessage = async (message: SignalMessage) => {
    if (message.type === 'welcome') {
      peerId = message.peerId;
      iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
      knownPeerIds.clear();
      for (const peer of message.peers) knownPeerIds.add(peer.peerId);
      if (!sessionId && message.peers.length === 0) sessionId = crypto.randomUUID();
      publish();
      await Promise.all(message.peers.map((peer) => startOffer(peer.peerId)));
      return;
    }
    if (message.type === 'pong') {
      clearResumeProbe();
      return;
    }
    if (message.type === 'peer-joined') {
      knownPeerIds.add(message.peer.peerId);
      publish();
      return;
    }
    if (message.type === 'peer-left') {
      removePeer(message.peerId);
      return;
    }

    const peer = createPeer(message.from);
    if (message.type === 'offer') {
      const description = message.payload.description as RTCSessionDescriptionInit | undefined;
      if (!description) return;
      await peer.connection.setRemoteDescription(description);
      await applyPendingCandidates(peer);
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      sendSignal({ type: 'answer', to: message.from, payload: { description: peer.connection.localDescription } });
      return;
    }
    if (message.type === 'answer') {
      const description = message.payload.description as RTCSessionDescriptionInit | undefined;
      if (!description) return;
      await peer.connection.setRemoteDescription(description);
      await applyPendingCandidates(peer);
      return;
    }
    const candidate = message.payload.candidate as RTCIceCandidateInit | undefined;
    if (!candidate) return;
    if (peer.connection.remoteDescription) {
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    } else {
      peer.pendingCandidates.push(candidate);
    }
  };

  const disconnect = () => {
    wantsConnection = false;
    intentionalClose = true;
    clearReconnectTimer();
    clearResumeProbe();
    socket?.close();
    socket = null;
    closePeerConnections();
    peerId = null;
    sessionId = null;
    status = 'idle';
    error = null;
    publish();
  };

  openSocket = () => {
    if (!wantsConnection || socket) return;
    intentionalClose = false;
    status = 'connecting';
    error = reconnectAttempt > 0 ? 'Reconnecting to the live band…' : null;
    publish();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      socket = new WebSocket(`${protocol}//${window.location.host}/api/live`);
    } catch {
      scheduleReconnect();
      return;
    }
    const currentSocket = socket;
    currentSocket.onopen = () => {
      reconnectAttempt = 0;
      status = 'connected';
      error = null;
      publish();
    };
    currentSocket.onmessage = (event) => {
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data) as SignalMessage;
      } catch {
        return;
      }
      void handleSignalMessage(message).catch((signalError) => {
        console.error('WebRTC signalling failed:', signalError);
        error = 'Could not connect to another band member.';
        publish();
      });
    };
    currentSocket.onerror = () => undefined;
    currentSocket.onclose = (event) => {
      if (socket !== currentSocket) return;
      socket = null;
      clearResumeProbe();
      if (intentionalClose) return;
      closePeerConnections();
      peerId = null;
      if (event.code === 4401 || event.code === 4403) {
        wantsConnection = false;
        status = 'error';
        error = event.code === 4401
          ? 'PocketID authentication is required.'
          : 'This site is not allowed to open the live band connection.';
        publish();
        return;
      }
      status = 'connecting';
      error = 'Reconnecting to the live band…';
      publish();
      scheduleReconnect();
    };
  };

  const connect = async () => {
    if (status !== 'idle' && status !== 'error') return;
    status = 'authenticating';
    error = null;
    wantsConnection = true;
    publish();
    if (!import.meta.env.DEV) {
      try {
        const response = await fetch('/oauth2/auth', { credentials: 'include', redirect: 'manual' });
        if (!response.ok) {
          const returnUrl = new URL(window.location.href);
          returnUrl.searchParams.set('live', '1');
          window.location.assign(`/oauth2/start?rd=${encodeURIComponent(returnUrl.toString())}`);
          return;
        }
      } catch {
        wantsConnection = false;
        status = 'error';
        error = 'Could not verify PocketID authentication.';
        publish();
        return;
      }
    }
    openSocket();
  };

  const recoverConnection = () => {
    if (!wantsConnection || document.visibilityState === 'hidden' || !navigator.onLine) return;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      socket = null;
      closePeerConnections();
      peerId = null;
      status = 'connecting';
      error = 'Reconnecting to the live band…';
      publish();
      scheduleReconnect(true);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    clearResumeProbe();
    const nonce = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'ping', nonce }));
    resumeProbe = window.setTimeout(() => {
      resumeProbe = null;
      if (socket?.readyState === WebSocket.OPEN) socket.close(4000, 'Signalling health check timed out');
    }, 4_000);
  };

  document.addEventListener('visibilitychange', recoverConnection);
  window.addEventListener('online', recoverConnection);

  const appendAction = (operation: NewLiveAction) => {
    const currentSessionId = sessionId;
    counter += 1;
    const action = createLiveAction(localActor, counter, operation);
    mergeIncomingActions([action]);
    if (currentSessionId) broadcastData({ type: 'actions', sessionId: currentSessionId, actions: [action] });
  };

  const addSong = (songId: string) => {
    const entries = replayActions(actions).entries;
    if (entries.some((entry) => entry.songId === songId)) return;
    appendAction({
      type: 'add',
      entryId: crypto.randomUUID(),
      songId,
      afterEntryId: entries.at(-1)?.id ?? null,
    });
  };

  const deleteEntry = (entryId: string) => appendAction({ type: 'delete', entryId });
  const selectEntry = (entryId: string) => appendAction({ type: 'select', entryId });
  const moveEntry = (entryId: string, targetIndex: number) => {
    const afterEntryId = moveAnchorForTarget(replayActions(actions).entries, entryId, targetIndex);
    if (afterEntryId !== undefined) appendAction({ type: 'move', entryId, afterEntryId });
  };

  const returnFromAuth = new URL(window.location.href);
  if (returnFromAuth.searchParams.get('live') === '1') {
    returnFromAuth.searchParams.delete('live');
    window.history.replaceState(null, '', `${returnFromAuth.pathname}${returnFromAuth.search}${returnFromAuth.hash}`);
    void connect();
  }

  const destroy = () => {
    disconnect();
    document.removeEventListener('visibilitychange', recoverConnection);
    window.removeEventListener('online', recoverConnection);
  };

  return { $state, connect, disconnect, addSong, deleteEntry, selectEntry, moveEntry, destroy };
}

export type LiveBand = ReturnType<typeof createLiveBand>;
