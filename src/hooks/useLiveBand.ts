import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createLiveAction,
  mergeActions,
  moveAnchorForTarget,
  replayActions,
  type LiveAction,
  type LiveState,
  type NewLiveAction,
} from '../live/liveState';

type ConnectionStatus = 'idle' | 'authenticating' | 'connecting' | 'connected' | 'error';

interface Peer {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
}

interface SignalPeer {
  peerId: string;
  identity: string;
}

interface SignalWelcome {
  type: 'welcome';
  peerId: string;
  peers: SignalPeer[];
  iceServers: RTCIceServer[];
}

type SignalMessage =
  | SignalWelcome
  | { type: 'peer-joined'; peer: SignalPeer }
  | { type: 'peer-left'; peerId: string }
  | { type: 'pong'; nonce: string }
  | {
      type: 'offer' | 'answer' | 'ice-candidate';
      from: string;
      payload: Record<string, unknown>;
    };

type DataMessage =
  | { type: 'log-request' }
  | { type: 'log-snapshot'; sessionId: string; actions: LiveAction[] }
  | { type: 'actions'; sessionId: string; actions: LiveAction[] };

const EMPTY_STATE: LiveState = { entries: [], activeEntryId: null };

export function useLiveBand() {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [knownPeerIds, setKnownPeerIds] = useState<Set<string>>(new Set());
  const [connectedPeerIds, setConnectedPeerIds] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [actions, setActions] = useState<LiveAction[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const peersRef = useRef(new Map<string, Peer>());
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const actionsRef = useRef<LiveAction[]>([]);
  const counterRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const wantsConnectionRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeProbeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSocketRef = useRef<() => void>(() => undefined);

  const state = useMemo(() => replayActions(actions), [actions]);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const replaceActions = useCallback((next: LiveAction[]) => {
    actionsRef.current = next;
    for (const action of next) {
      counterRef.current = Math.max(counterRef.current, action.revision.counter);
    }
    setActions(next);
  }, []);

  const mergeIncomingActions = useCallback(
    (incoming: LiveAction[]) => {
      replaceActions(mergeActions(actionsRef.current, incoming));
    },
    [replaceActions],
  );

  const sendSignal = useCallback((message: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const sendData = useCallback((channel: RTCDataChannel, message: DataMessage) => {
    if (channel.readyState === 'open') {
      channel.send(JSON.stringify(message));
    }
  }, []);

  const broadcastData = useCallback(
    (message: DataMessage) => {
      for (const peer of peersRef.current.values()) {
        if (peer.channel) sendData(peer.channel, message);
      }
    },
    [sendData],
  );

  const acceptSnapshot = useCallback(
    (incomingSessionId: string, incomingActions: LiveAction[]) => {
      if (!sessionIdRef.current) {
        sessionIdRef.current = incomingSessionId;
        setSessionId(incomingSessionId);
        replaceActions(mergeActions([], incomingActions));
        return;
      }
      if (sessionIdRef.current === incomingSessionId) {
        mergeIncomingActions(incomingActions);
      }
    },
    [mergeIncomingActions, replaceActions],
  );

  const handleDataMessage = useCallback(
    (channel: RTCDataChannel, event: MessageEvent<string>) => {
      let message: DataMessage;
      try {
        message = JSON.parse(event.data) as DataMessage;
      } catch {
        return;
      }

      if (message.type === 'log-request') {
        if (sessionIdRef.current) {
          sendData(channel, {
            type: 'log-snapshot',
            sessionId: sessionIdRef.current,
            actions: actionsRef.current,
          });
        }
        return;
      }

      if (
        (message.type === 'log-snapshot' || message.type === 'actions') &&
        typeof message.sessionId === 'string' &&
        Array.isArray(message.actions)
      ) {
        acceptSnapshot(message.sessionId, message.actions);
      }
    },
    [acceptSnapshot, sendData],
  );

  const removePeer = useCallback((remotePeerId: string) => {
    const peer = peersRef.current.get(remotePeerId);
    if (peer) {
      peer.channel?.close();
      peer.connection.close();
      peersRef.current.delete(remotePeerId);
    }
    setKnownPeerIds((current) => {
      const next = new Set(current);
      next.delete(remotePeerId);
      return next;
    });
    setConnectedPeerIds((current) => {
      const next = new Set(current);
      next.delete(remotePeerId);
      return next;
    });
  }, []);

  const closePeerConnections = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      peer.channel?.close();
      peer.connection.close();
    }
    peersRef.current.clear();
    setKnownPeerIds(new Set());
    setConnectedPeerIds(new Set());
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearResumeProbe = useCallback(() => {
    if (resumeProbeRef.current !== null) {
      clearTimeout(resumeProbeRef.current);
      resumeProbeRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(
    (immediate = false) => {
      if (
        !wantsConnectionRef.current ||
        document.visibilityState === 'hidden' ||
        !navigator.onLine
      ) {
        return;
      }

      clearReconnectTimer();
      const attempt = reconnectAttemptRef.current;
      const delay = immediate ? 0 : Math.min(1_000 * 2 ** attempt, 10_000);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        openSocketRef.current();
      }, delay);
    },
    [clearReconnectTimer],
  );

  const attachDataChannel = useCallback(
    (remotePeerId: string, peer: Peer, channel: RTCDataChannel) => {
      peer.channel = channel;
      channel.onopen = () => {
        setConnectedPeerIds((current) => new Set(current).add(remotePeerId));
        if (sessionIdRef.current) {
          sendData(channel, {
            type: 'log-snapshot',
            sessionId: sessionIdRef.current,
            actions: actionsRef.current,
          });
        } else {
          sendData(channel, { type: 'log-request' });
        }
      };
      channel.onmessage = (event) => handleDataMessage(channel, event);
      channel.onclose = () => {
        setConnectedPeerIds((current) => {
          const next = new Set(current);
          next.delete(remotePeerId);
          return next;
        });
      };
    },
    [handleDataMessage, sendData],
  );

  const createPeer = useCallback(
    (remotePeerId: string): Peer => {
      const existing = peersRef.current.get(remotePeerId);
      if (existing) return existing;

      const peer: Peer = {
        connection: new RTCPeerConnection({ iceServers: iceServersRef.current }),
        channel: null,
        pendingCandidates: [],
      };
      peersRef.current.set(remotePeerId, peer);

      peer.connection.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal({
            type: 'ice-candidate',
            to: remotePeerId,
            payload: { candidate: event.candidate.toJSON() },
          });
        }
      };
      peer.connection.ondatachannel = (event) => {
        attachDataChannel(remotePeerId, peer, event.channel);
      };
      peer.connection.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(peer.connection.connectionState)) {
          removePeer(remotePeerId);
        }
      };
      return peer;
    },
    [attachDataChannel, removePeer, sendSignal],
  );

  const applyPendingCandidates = useCallback(async (peer: Peer) => {
    if (!peer.connection.remoteDescription) return;
    const candidates = peer.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const startOffer = useCallback(
    async (remotePeerId: string) => {
      const peer = createPeer(remotePeerId);
      const channel = peer.connection.createDataChannel('holy-songs-live', { ordered: true });
      attachDataChannel(remotePeerId, peer, channel);
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      sendSignal({
        type: 'offer',
        to: remotePeerId,
        payload: { description: peer.connection.localDescription },
      });
    },
    [attachDataChannel, createPeer, sendSignal],
  );

  const handleSignalMessage = useCallback(
    async (message: SignalMessage) => {
      if (message.type === 'welcome') {
        peerIdRef.current = message.peerId;
        iceServersRef.current = Array.isArray(message.iceServers) ? message.iceServers : [];
        const existingPeerIds = message.peers.map((peer) => peer.peerId);
        setKnownPeerIds(new Set(existingPeerIds));

        if (!sessionIdRef.current && existingPeerIds.length === 0) {
          const firstSessionId = crypto.randomUUID();
          sessionIdRef.current = firstSessionId;
          setSessionId(firstSessionId);
          replaceActions([]);
        }

        await Promise.all(existingPeerIds.map((remotePeerId) => startOffer(remotePeerId)));
        return;
      }

      if (message.type === 'pong') {
        clearResumeProbe();
        return;
      }

      if (message.type === 'peer-joined') {
        setKnownPeerIds((current) => new Set(current).add(message.peer.peerId));
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
        sendSignal({
          type: 'answer',
          to: message.from,
          payload: { description: peer.connection.localDescription },
        });
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
    },
    [
      applyPendingCandidates,
      clearResumeProbe,
      createPeer,
      removePeer,
      replaceActions,
      sendSignal,
      startOffer,
    ],
  );

  const disconnect = useCallback(() => {
    wantsConnectionRef.current = false;
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    clearResumeProbe();
    socketRef.current?.close();
    socketRef.current = null;
    closePeerConnections();
    peerIdRef.current = null;
    sessionIdRef.current = null;
    actionsRef.current = [];
    counterRef.current = 0;
    setKnownPeerIds(new Set());
    setConnectedPeerIds(new Set());
    setSessionId(null);
    setActions([]);
    setStatus('idle');
    setError(null);
  }, [clearReconnectTimer, clearResumeProbe, closePeerConnections]);

  const openSocket = useCallback(() => {
    if (!wantsConnectionRef.current || socketRef.current) return;
    intentionalCloseRef.current = false;
    setStatus('connecting');
    setError(reconnectAttemptRef.current > 0 ? 'Reconnecting to the live band…' : null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(protocol + '//' + window.location.host + '/api/live');
    } catch {
      scheduleReconnect();
      return;
    }
    socketRef.current = socket;
    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      setStatus('connected');
      setError(null);
    };
    socket.onmessage = (event) => {
      let message: SignalMessage;
      try {
        message = JSON.parse(event.data) as SignalMessage;
      } catch {
        return;
      }
      void handleSignalMessage(message).catch((signalError) => {
        console.error('WebRTC signalling failed:', signalError);
        setError('Could not connect to another band member.');
      });
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      clearResumeProbe();
      if (intentionalCloseRef.current) return;

      closePeerConnections();
      peerIdRef.current = null;
      if (event.code === 4401 || event.code === 4403) {
        wantsConnectionRef.current = false;
        setStatus('error');
        setError(
          event.code === 4401
            ? 'PocketID authentication is required.'
            : 'This site is not allowed to open the live band connection.',
        );
        return;
      }
      setStatus('connecting');
      setError('Reconnecting to the live band…');
      scheduleReconnect();
    };
  }, [clearResumeProbe, closePeerConnections, handleSignalMessage, scheduleReconnect]);

  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  const connect = useCallback(async () => {
    if (status !== 'idle' && status !== 'error') return;
    setStatus('authenticating');
    setError(null);
    wantsConnectionRef.current = true;

    if (!import.meta.env.DEV) {
      try {
        const response = await fetch('/oauth2/auth', {
          credentials: 'include',
          redirect: 'manual',
        });
        if (!response.ok) {
          const returnUrl = new URL(window.location.href);
          returnUrl.searchParams.set('live', '1');
          window.location.assign(`/oauth2/start?rd=${encodeURIComponent(returnUrl.toString())}`);
          return;
        }
      } catch {
        wantsConnectionRef.current = false;
        setStatus('error');
        setError('Could not verify PocketID authentication.');
        return;
      }
    }

    openSocket();
  }, [openSocket, status]);

  useEffect(() => {
    const recoverConnection = () => {
      if (
        !wantsConnectionRef.current ||
        document.visibilityState === 'hidden' ||
        !navigator.onLine
      ) {
        return;
      }

      const socket = socketRef.current;
      if (!socket) {
        scheduleReconnect(true);
        return;
      }
      if (socket.readyState === WebSocket.CLOSED) {
        socketRef.current = null;
        closePeerConnections();
        peerIdRef.current = null;
        setStatus('connecting');
        setError('Reconnecting to the live band…');
        scheduleReconnect(true);
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;

      clearResumeProbe();
      const nonce = crypto.randomUUID();
      socket.send(JSON.stringify({ type: 'ping', nonce }));
      resumeProbeRef.current = setTimeout(() => {
        resumeProbeRef.current = null;
        if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
          socket.close(4000, 'Signalling health check timed out');
        }
      }, 4_000);
    };

    document.addEventListener('visibilitychange', recoverConnection);
    window.addEventListener('online', recoverConnection);
    return () => {
      document.removeEventListener('visibilitychange', recoverConnection);
      window.removeEventListener('online', recoverConnection);
    };
  }, [clearResumeProbe, closePeerConnections, scheduleReconnect]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('live') !== '1') return;
    url.searchParams.delete('live');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    void connect();
  }, [connect]);

  useEffect(() => disconnect, [disconnect]);

  const appendAction = useCallback(
    (operation: NewLiveAction) => {
      const actor = peerIdRef.current;
      const currentSessionId = sessionIdRef.current;
      if (!actor || !currentSessionId) return;
      counterRef.current += 1;
      const action = createLiveAction(actor, counterRef.current, operation);
      mergeIncomingActions([action]);
      broadcastData({
        type: 'actions',
        sessionId: currentSessionId,
        actions: [action],
      });
    },
    [broadcastData, mergeIncomingActions],
  );

  const addSong = useCallback(
    (songId: string) => {
      const entries = stateRef.current.entries;
      appendAction({
        type: 'add',
        entryId: crypto.randomUUID(),
        songId,
        afterEntryId: entries[entries.length - 1]?.id ?? null,
      });
    },
    [appendAction],
  );

  const deleteEntry = useCallback(
    (entryId: string) => appendAction({ type: 'delete', entryId }),
    [appendAction],
  );

  const selectEntry = useCallback(
    (entryId: string) => appendAction({ type: 'select', entryId }),
    [appendAction],
  );

  const moveEntry = useCallback(
    (entryId: string, targetIndex: number) => {
      const afterEntryId = moveAnchorForTarget(stateRef.current.entries, entryId, targetIndex);
      if (afterEntryId === undefined) return;
      appendAction({ type: 'move', entryId, afterEntryId });
    },
    [appendAction],
  );

  return {
    status,
    error,
    state: sessionId ? state : EMPTY_STATE,
    isSynchronized: sessionId !== null,
    connectedMembers: status === 'connected' ? connectedPeerIds.size + 1 : 0,
    knownMembers: status === 'connected' ? knownPeerIds.size + 1 : 0,
    connect,
    disconnect,
    addSong,
    deleteEntry,
    selectEntry,
    moveEntry,
  };
}
