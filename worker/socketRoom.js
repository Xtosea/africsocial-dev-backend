import { withFreshDatabase } from "./utils/db.js";

const TICKET_TTL_MS = 60 * 1000;
const CALL_RING_TIMEOUT_MS = 30 * 1000;
const MISSED_CALL_RETRY_MS = 30 * 1000;

export class SocketRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (
      url.pathname === "/ticket" &&
      request.method === "POST"
    ) {
      return this.createTicket(request);
    }

    if (
      url.pathname === "/connect" &&
      request.method === "GET"
    ) {
      return this.handleWebSocket(request);
    }

    return new Response("SocketRoom OK", {
      status: 200,
    });
  }

  async createTicket(request) {
    let body;

    try {
      body = await request.json();
    } catch {
      return new Response("Invalid request body", {
        status: 400,
      });
    }

    const userId = body?.userId;

    if (!userId) {
      return new Response("Missing user ID", {
        status: 401,
      });
    }

    const ticketBytes = new Uint8Array(32);

    crypto.getRandomValues(ticketBytes);

    const ticket = Array.from(
      ticketBytes,
      byte => byte.toString(16).padStart(2, "0")
    ).join("");

    await this.ctx.storage.put(
      `ticket:${ticket}`,
      {
        userId,
        createdAt: Date.now(),
      },
      {
        expirationTtl: 60,
      }
    );

    return Response.json({
      ticket,
      expiresIn: TICKET_TTL_MS,
    });
  }

  async handleWebSocket(request) {
    if (
      request.headers.get("Upgrade") !== "websocket"
    ) {
      return new Response(
        "Expected WebSocket upgrade",
        { status: 426 }
      );
    }

    const url = new URL(request.url);
    const ticket = url.searchParams.get("ticket");

    if (!ticket) {
      return new Response(
        "Missing WebSocket ticket",
        { status: 401 }
      );
    }

    const key = `ticket:${ticket}`;

    const stored = await this.ctx.storage.get(key);

    if (!stored) {
      return new Response(
        "Invalid or expired WebSocket ticket",
        { status: 401 }
      );
    }

    // One-time ticket.
    await this.ctx.storage.delete(key);

    const pair = new WebSocketPair();

    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      userId: stored.userId,
      connectedAt: Date.now(),
    });

    server.send(JSON.stringify({
      event: "connected",
      data: {
        message: "WebSocket connected",
      },
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  getOnlineUsers() {
    const sockets = this.ctx.getWebSockets();

    return [
      ...new Set(
        sockets
          .map(ws => {
            const attachment = ws.deserializeAttachment();

            return attachment?.userId || null;
          })
          .filter(Boolean)
      )
    ];
  }

  broadcast(event, data) {
    const message = JSON.stringify({
      event,
      data,
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (error) {
        console.error(
          "SOCKET BROADCAST ERROR:",
          error
        );
      }
    }
  }

  async persistMissedCall(call) {
    if (
      !call?.callId ||
      !call?.callerId ||
      !call?.recipientId ||
      !["voice", "video"].includes(call?.callType)
    ) {
      throw new Error("Invalid missed-call record");
    }

    return withFreshDatabase(this.env, async (db) => {
      const notifications = db.collection("notifications");

      await notifications.createIndex(
        { recipient: 1, type: 1, createdAt: -1 },
        { name: "notifications_recipient_type_createdAt" }
      );

      await notifications.createIndex(
        { callId: 1 },
        {
          unique: true,
          partialFilterExpression: {
            type: "MISSED_CALL",
            callId: { $type: "string" },
          },
          name: "missed_calls_unique_callId",
        }
      );

      const now = new Date();
      const text = call.callType === "video"
        ? "You missed a video call"
        : "You missed a voice call";

      await notifications.updateOne(
        {
          type: "MISSED_CALL",
          callId: String(call.callId),
        },
        {
          $setOnInsert: {
            recipient: String(call.recipientId),
            sender: String(call.callerId),
            senders: [String(call.callerId)],
            count: 1,
            type: "MISSED_CALL",
            text,
            post: null,
            read: false,
            callId: String(call.callId),
            callType: call.callType,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true }
      );

      return notifications.findOne({
        type: "MISSED_CALL",
        callId: String(call.callId),
      });
    });
  }

  async scheduleNextCallAlarm() {
    const calls = await this.ctx.storage.list({
      prefix: "call:",
    });

    let nextAlarm = null;

    for (const call of calls.values()) {
      if (
        call?.status !== "ringing" ||
        !Number.isFinite(call?.expiresAt)
      ) {
        continue;
      }

      if (nextAlarm === null || call.expiresAt < nextAlarm) {
        nextAlarm = call.expiresAt;
      }
    }

    const currentAlarm = await this.ctx.storage.getAlarm();

    if (nextAlarm === null) {
      if (currentAlarm !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    if (currentAlarm !== nextAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async alarm() {
    const calls = await this.ctx.storage.list({
      prefix: "call:",
    });

    const now = Date.now();

    for (const [key, call] of calls.entries()) {
      if (
        call?.status !== "ringing" ||
        !Number.isFinite(call?.expiresAt) ||
        call.expiresAt > now
      ) {
        continue;
      }

      try {
        const notification = await this.persistMissedCall({
          callId: call.callId,
          callerId: call.callerId,
          recipientId: call.recipientId,
          callType: call.callType,
        });

        this.sendToUser(
          call.recipientId,
          "new-notification",
          notification
        );

        this.sendToUser(
          call.callerId,
          "call-no-answer",
          {
            callId: call.callId,
            to: call.recipientId,
          }
        );

        await this.ctx.storage.delete(key);
      } catch (error) {
        console.error("MISSED CALL PROCESSING ERROR:", error);

        const retryAt = Date.now() + MISSED_CALL_RETRY_MS;

        await this.ctx.storage.put(key, {
          ...call,
          expiresAt: retryAt,
        });
      }
    }

    await this.scheduleNextCallAlarm();
  }

  async handleCallEvent(ws, event, payload = {}) {
    const attachment = ws.deserializeAttachment();
    const actorId = String(attachment?.userId || "");

    if (!actorId) {
      this.sendToSocket(ws, "error", {
        message: "Socket user identity missing",
      });
      return;
    }

    const callId = String(payload.callId || "");

    if (event === "call-user") {
      const recipientId = String(payload.to || "");
      const callType = payload.callType;

      if (
        !callId ||
        callId.length > 128 ||
        !recipientId ||
        recipientId.length > 128 ||
        recipientId === actorId ||
        !["voice", "video"].includes(callType) ||
        !payload.signal
      ) {
        this.sendToSocket(ws, "error", {
          message: "Invalid call request",
        });
        return;
      }

      const existingCalls = await this.ctx.storage.list({
        prefix: "call:",
      });

      for (const existing of existingCalls.values()) {
        if (
          ["ringing", "active"].includes(existing?.status) &&
          (
            existing.callerId === actorId ||
            existing.recipientId === actorId ||
            existing.callerId === recipientId ||
            existing.recipientId === recipientId
          )
        ) {
          this.sendToSocket(ws, "call-busy", {
            callId,
            to: recipientId,
          });
          return;
        }
      }

      const key = `call:${callId}`;
      const duplicate = await this.ctx.storage.get(key);

      if (duplicate) {
        this.sendToSocket(ws, "error", {
          message: "Call ID already exists",
        });
        return;
      }

      const now = Date.now();

      const call = {
        callId,
        callerId: actorId,
        recipientId,
        callType,
        status: "ringing",
        createdAt: now,
        expiresAt: now + CALL_RING_TIMEOUT_MS,
      };

      // Store call metadata only. Never store SDP or ICE candidates.
      await this.ctx.storage.put(key, call);
      await this.scheduleNextCallAlarm();

      // The offer is forwarded only to a currently connected recipient.
      this.sendToUser(recipientId, "incoming-call", {
        from: actorId,
        signal: payload.signal,
        callType,
        name: payload.name || "",
        profilePic: payload.profilePic || "",
        callId,
      });

      return;
    }

    if (!callId) {
      this.sendToSocket(ws, "error", {
        message: "Missing call ID",
      });
      return;
    }

    const key = `call:${callId}`;
    const call = await this.ctx.storage.get(key);

    if (!call) {
      this.sendToSocket(ws, "error", {
        message: "Call not found or no longer active",
      });
      return;
    }

    const isCaller = call.callerId === actorId;
    const isRecipient = call.recipientId === actorId;

    if (!isCaller && !isRecipient) {
      this.sendToSocket(ws, "error", {
        message: "You are not a participant in this call",
      });
      return;
    }

    if (event === "answer-call") {
      if (
        !isRecipient ||
        call.status !== "ringing" ||
        call.expiresAt <= Date.now() ||
        !payload.signal
      ) {
        this.sendToSocket(ws, "error", {
          message: "This call cannot be answered",
        });
        return;
      }

      await this.ctx.storage.put(key, {
        ...call,
        status: "active",
        acceptedAt: Date.now(),
        expiresAt: null,
      });

      await this.scheduleNextCallAlarm();

      this.sendToUser(call.callerId, "call-accepted", {
        signal: payload.signal,
        callId,
      });

      return;
    }

    if (event === "ice-candidate") {
      if (
        !["ringing", "active"].includes(call.status) ||
        !payload.candidate
      ) {
        return;
      }

      const peerId = isCaller
        ? call.recipientId
        : call.callerId;

      this.sendToUser(peerId, "ice-candidate", {
        candidate: payload.candidate,
        callId,
      });

      return;
    }

    if (event === "reject-call") {
      if (!isRecipient || call.status !== "ringing") {
        return;
      }

      await this.ctx.storage.delete(key);
      await this.scheduleNextCallAlarm();

      this.sendToUser(call.callerId, "call-rejected", {
        callId,
        from: actorId,
      });

      return;
    }

    if (event === "end-call") {
      await this.ctx.storage.delete(key);
      await this.scheduleNextCallAlarm();

      const peerId = isCaller
        ? call.recipientId
        : call.callerId;

      this.sendToUser(peerId, "call-ended", {
        callId,
        from: actorId,
      });
    }
  }

  sendToUser(userId, event, data) {
    const targetUserId = String(userId);
    const message = JSON.stringify({ event, data });
    let delivered = 0;

    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = ws.deserializeAttachment();

        if (String(attachment?.userId || "") !== targetUserId) {
          continue;
        }

        ws.send(message);
        delivered++;
      } catch (error) {
        console.error("PRIVATE SOCKET DELIVERY ERROR:", error);
      }
    }

    return delivered;
  }

  sendToSocket(ws, event, data) {
    try {
      ws.send(JSON.stringify({ event, data }));
      return true;
    } catch (error) {
      console.error("SOCKET DELIVERY ERROR:", error);
      return false;
    }
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      if (data.event === "ping") {
        ws.send(JSON.stringify({
          event: "pong",
          data: {
            timestamp: Date.now(),
          },
        }));

        return;
      }

      if (data.event === "join") {
        const attachment = ws.deserializeAttachment();

        if (!attachment?.userId) {
          ws.send(JSON.stringify({
            event: "error",
            data: {
              message: "Socket user identity missing",
            },
          }));

          return;
        }

        const onlineUsers = this.getOnlineUsers();

        this.broadcast(
          "online-users",
          onlineUsers
        );

        return;
      }

      const callEvents = [
          "call-user",
          "answer-call",
          "ice-candidate",
          "reject-call",
          "end-call",
        ];

        if (callEvents.includes(data.event)) {
          await this.handleCallEvent(
            ws,
            data.event,
            data.data || {}
          );
          return;
        }

          if (data.event === "send-message") {
        this.broadcast(
          "receive-message",
          data.data
        );

        return;
      }

      if (data.event === "message-edited") {
        this.broadcast(
          "message-edited",
          data.data
        );

        return;
      }

      if (data.event === "message-deleted") {
        this.broadcast(
          "message-deleted",
          data.data
        );

        return;
      }

      ws.send(JSON.stringify({
        event: "message",
        data,
      }));

    } catch (error) {
      console.error(
        "SOCKET MESSAGE ERROR:",
        error
      );

      try {
        ws.send(JSON.stringify({
          event: "error",
          data: {
            message: "Invalid WebSocket message",
          },
        }));
      } catch {}
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {}

    this.broadcast(
      "online-users",
      this.getOnlineUsers()
    );
  }

  async webSocketError(ws) {
    try {
      ws.close();
    } catch {}

    this.broadcast(
      "online-users",
      this.getOnlineUsers()
    );
  }
}
