# Live band session

The live set is an ephemeral, client-owned WebRTC session. It deliberately has
no database, room model, tenancy model, history, or browser persistence.

## Lifecycle

1. A user presses **Connect**.
2. The browser verifies its existing oauth2-proxy session. If needed, it sends
   the user through PocketID and returns with `?live=1`.
3. The authenticated browser opens `wss://holy-songs.bcgen.ie/api/live`.
4. The FastAPI process assigns a peer ID and returns every currently connected
   peer. The new peer creates WebRTC offers to those peers.
5. If no peers exist, this browser creates a new in-memory session. Otherwise it
   requests and adopts the existing peers' action log.
6. When the last browser disconnects, the session and its state cease to exist.

The signalling WebSocket remains open for presence and future peer discovery.
Song state travels only over reliable, ordered WebRTC data channels.

## Replicated action log

Each client holds the same set of immutable actions in memory:

```json
{
  "id": "peer-a:14:1dc2...",
  "revision": { "counter": 14, "actor": "peer-a" },
  "type": "move",
  "entryId": "set-entry-3",
  "afterEntryId": "set-entry-7"
}
```

Clients merge actions by unique ID, sort them by `(counter, actor, id)`, and
replay them through a pure reducer. `add`, `delete`, `move`, and `select` are the
only operations. Duplicate deletions and operations referring to entries that
do not exist are no-ops.

The logical counter provides deterministic ordering without relying on
unsynchronized device clocks. `actor` and `id` break genuinely concurrent ties.
The log disappears with the session; it is not a write-ahead log on disk.

## Signalling server state

The server stores only this process-local map:

```text
peer ID -> authenticated identity + WebSocket
```

It relays `offer`, `answer`, and `ice-candidate` messages to a named connected
peer. It does not inspect WebRTC descriptions or receive live-set actions.
Restarting it loses only presence; clients can reconnect and negotiate again.

The production Traefik route for `/api/live` must terminate at the existing
oauth2-proxy sidecar. The backend requires an oauth2-proxy identity header and
an allowed `Origin`.

## ICE configuration

With no additional secrets the server returns Cloudflare's STUN service:

```text
stun:stun.cloudflare.com:3478
```

For relay fallback, set both variables in the Holy Songs Nomad task:

```text
CLOUDFLARE_TURN_KEY_ID
CLOUDFLARE_TURN_API_TOKEN
```

The server exchanges them for temporary credentials and sends only those
credentials to authenticated clients. `CLOUDFLARE_TURN_CREDENTIAL_TTL`
defaults to 3600 seconds.

Local `npm run dev` disables the identity-header requirement and proxies
WebSockets to FastAPI. Production defaults to fail-closed authentication.
