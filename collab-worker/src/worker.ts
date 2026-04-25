// utopiamap collab worker
//
// A tiny Cloudflare Worker + Durable Object that relays Yjs sync messages
// between everybody connected to the same room. There is no auth, no
// storage, and no logging of room contents -- the room id in the URL is
// the only access boundary, exactly like Excalidraw shares.
//
// URL shape:
//   wss://collab.utopiamap.com/room/<roomId>
//
// Anything sent on a socket is broadcast verbatim to every other socket in
// the same room. Clients use Yjs' standard sync + awareness protocols on
// top of this dumb relay; the worker has no idea what's inside the bytes.
//
// Free-tier safety:
//   - We never persist to DO storage; everything is in-memory.
//   - When the last socket disconnects, the DO instance becomes idle and is
//     evicted by the runtime, so an unused room costs nothing.
//   - We hibernate active sockets via state.acceptWebSocket() so a room can
//     keep a few thousand clients connected without burning DO compute.

const CORS_HEADERS: Record<string, string> = {
  // The frontend may live on utopiamap.com, www.utopiamap.com, *.pages.dev
  // (preview builds), or localhost during development. Allow all of them.
  // Note: WebSocket upgrades themselves don't honour CORS, so this only
  // matters for the small status endpoint below.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export interface Env {
  ROOMS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET / -> short status page so a human poking the URL gets a useful
    // message instead of a blank 404. Not used by the frontend.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "utopiamap collab relay is up. Connect via WebSocket to /room/<id>.\n",
        { headers: { ...CORS_HEADERS, "content-type": "text/plain" } }
      );
    }

    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,128})$/);
    if (!match) {
      return new Response("expected /room/<id>", {
        status: 404,
        headers: CORS_HEADERS,
      });
    }
    const roomId = match[1];

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("websocket upgrade required", {
        status: 426,
        headers: CORS_HEADERS,
      });
    }

    // Route to the Durable Object instance whose name is the room id, so
    // every socket for "abc123" lands on the same DO and can talk to its
    // peers. Different room ids never share state.
    const id = env.ROOMS.idFromName(roomId);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

export class RoomDO {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: the runtime evicts our DO from memory between
    // messages; we get re-created on demand. This means thousands of idle
    // collaborators cost essentially nothing.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Broadcast every incoming frame to every other peer in the same room.
  // The relay never inspects or stores the bytes -- Yjs sync + awareness
  // messages are pure binary and are forwarded verbatim.
  webSocketMessage(sender: WebSocket, msg: ArrayBuffer | string) {
    for (const peer of this.state.getWebSockets()) {
      if (peer === sender) continue;
      try {
        peer.send(msg);
      } catch {
        // peer is mid-disconnect; ignore
      }
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    try { ws.close(1000, "bye"); } catch {}
    // Y.Awareness will time out the departed peer's cursor on its own --
    // no extra notification needed because we're a dumb relay.
  }

  webSocketError(ws: WebSocket, _err: unknown) {
    try { ws.close(1011, "error"); } catch {}
  }
}
