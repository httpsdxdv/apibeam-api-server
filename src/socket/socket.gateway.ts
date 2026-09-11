import {
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';

type PendingResponse = {
  roomId: string;
  resolve: (msg: any) => void;
  reject: (error: unknown) => void;
};

type RelayRequest = {
  requestId: string;
  [key: string]: any;
};

@WebSocketGateway({ cors: { origin: '*' } })
export class SocketGateway {
  @WebSocketServer()
  server: Server;

  private pendingResponses = new Map<string, PendingResponse>();
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();
  private httpBridgeLastSeen = new Map<string, number>();
  private httpQueues = new Map<string, RelayRequest[]>();
  private get requestTimeoutMs() {
    const configured = Number(process.env.APIBEAM_REQUEST_TIMEOUT_MS || 180000);
    return Number.isFinite(configured) && configured > 0 ? configured : 180000;
  }

  private get httpBridgeTtlMs() {
    return 15000;
  }

  private isSocketRoomConnected(roomId: string) {
    return (this.server?.sockets.adapter.rooms.get(roomId)?.size || 0) > 0;
  }

  private isHttpBridgeConnected(roomId: string) {
    const lastSeen = this.httpBridgeLastSeen.get(roomId) || 0;
    return Date.now() - lastSeen <= this.httpBridgeTtlMs;
  }

  isRoomConnected(roomId: string) {
    return this.isSocketRoomConnected(roomId) || this.isHttpBridgeConnected(roomId);
  }

  touchHttpBridge(roomId: string) {
    this.httpBridgeLastSeen.set(roomId, Date.now());
  }

  getNextHttpRequest(roomId: string) {
    this.touchHttpBridge(roomId);
    const queue = this.httpQueues.get(roomId) || [];
    return queue.shift() || null;
  }
  private enqueueHttpRequest(roomId: string, request: RelayRequest) {
    const queue = this.httpQueues.get(roomId) || [];
    queue.push(request);
    this.httpQueues.set(roomId, queue);
  }

  private removeQueuedHttpRequest(roomId: string, requestId: string) {
    const queue = this.httpQueues.get(roomId);
    if (!queue) return;
    const index = queue.findIndex((request) => request.requestId === requestId);
    if (index >= 0) queue.splice(index, 1);
  }

  private resolvePendingResponse(data: {
    roomId: string;
    requestId?: string;
    message: any;
  }) {
    const { roomId, message } = data;
    let requestId = data.requestId;

    if (!requestId) {
      requestId = Array.from(this.pendingResponses.entries()).find(
        ([, pending]) => pending.roomId === roomId,
      )?.[0];
    }

    if (!requestId) {
      console.warn('ApiBeam received a response without a matching requestId');
      return { success: false, reason: 'missing_request_id' };
    }
    const pending = this.pendingResponses.get(requestId);
    if (!pending || pending.roomId !== roomId) {
      console.warn(`Ignoring late or unknown ApiBeam response ${requestId}`);
      return { success: false, reason: 'unknown_request' };
    }

    const timeout = this.pendingTimeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(requestId);
    }

    pending.resolve(message);
    this.pendingResponses.delete(requestId);
    return { success: true };
  }

  respondFromHttpBridge(data: {
    roomId: string;
    requestId?: string;
    message: any;
  }) {
    this.touchHttpBridge(data.roomId);
    return this.resolvePendingResponse(data);
  }

  async sendToRoomAndWait(roomId: string, message: any): Promise<any> {
    if (!this.isRoomConnected(roomId)) {
      throw new ServiceUnavailableException(
        'No ApiBeam browser extension is connected to this room.',
      );
    }
    const requestId = randomUUID();
    const relayRequest = { ...message, requestId };

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(requestId, { roomId, resolve, reject });

      const timeout = setTimeout(() => {
        const pending = this.pendingResponses.get(requestId);
        if (!pending) return;

        this.pendingResponses.delete(requestId);
        this.pendingTimeouts.delete(requestId);
        this.removeQueuedHttpRequest(roomId, requestId);

        if (this.isSocketRoomConnected(roomId)) {
          this.server.to(roomId).emit('cancelRequest', { requestId });
        }

        reject(
          new GatewayTimeoutException(
            `ApiBeam request ${requestId} timed out after ${this.requestTimeoutMs}ms while waiting for the browser response.`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pendingTimeouts.set(requestId, timeout);

      // Prefer the persistent HTTP bridge when the dedicated provider tab is alive.
      // Firefox MV3 background workers may be evicted at any time, so an active
      // Socket.IO connection is only the fallback transport for this room.
      if (this.isHttpBridgeConnected(roomId)) {
        this.enqueueHttpRequest(roomId, relayRequest);
      } else if (this.isSocketRoomConnected(roomId)) {
        this.server.to(roomId).emit('serverMessage', relayRequest);
      } else {
        this.enqueueHttpRequest(roomId, relayRequest);
      }
    });
  }
  @SubscribeMessage('clientResponse')
  handleClientResponse(
    @MessageBody()
    data: { roomId: string; requestId?: string; message: any },
  ) {
    return this.resolvePendingResponse(data);
  }

  joinRoom(client: Socket, roomId: string) {
    client.join(roomId);
    console.log(`Client ${client.id} joined room: ${roomId}`);
    this.server.to(roomId).emit('roomJoined', { roomId });
  }

  handleConnection(socket: Socket) {
    console.log('Client connected:', socket.id);
  }

  handleDisconnect(socket: Socket) {
    console.log('Client disconnected:', socket.id);
  }
}

