import {
  ServiceUnavailableException,
  GatewayTimeoutException,
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

@WebSocketGateway({
  cors: { origin: '*' },
})
export class SocketGateway {
  @WebSocketServer()
  server: Server;

  private pendingResponses = new Map<string, PendingResponse>();
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();

  private get requestTimeoutMs() {
    const configured = Number(process.env.APIBEAM_REQUEST_TIMEOUT_MS || 180000);
    return Number.isFinite(configured) && configured > 0 ? configured : 180000;
  }

  isRoomConnected(roomId: string) {
    return (this.server?.sockets.adapter.rooms.get(roomId)?.size || 0) > 0;
  }

  /**
   * HTTP route calls this to emit a request and wait for the matching response.
   * Every request has its own requestId, so concurrent HTTP requests cannot
   * overwrite one another even when they use the same room.
   */
  async sendToRoomAndWait(roomId: string, message: any): Promise<any> {
    if (!this.isRoomConnected(roomId)) {
      throw new ServiceUnavailableException(
        'No ApiBeam browser extension is connected to this room. Open the extension and connect it before sending API requests.',
      );
    }

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(requestId, { roomId, resolve, reject });

      const timeout = setTimeout(() => {
        const pending = this.pendingResponses.get(requestId);
        if (!pending) return;

        this.pendingResponses.delete(requestId);
        this.pendingTimeouts.delete(requestId);

        // Tell the extension to abandon/reset this browser request so its queue
        // can continue instead of becoming permanently stuck.
        this.server.to(roomId).emit('cancelRequest', { requestId });

        reject(
          new GatewayTimeoutException(
            `ApiBeam request ${requestId} timed out after ${this.requestTimeoutMs}ms while waiting for the browser response.`,
          ),
        );
      }, this.requestTimeoutMs);

      this.pendingTimeouts.set(requestId, timeout);
      this.server.to(roomId).emit('serverMessage', {
        ...message,
        requestId,
      });
    });
  }

  @SubscribeMessage('clientResponse')
  handleClientResponse(
    @MessageBody()
    data: { roomId: string; requestId?: string; message: any },
  ) {
    const { roomId, message } = data;
    let requestId = data.requestId;

    // Backward-compatible fallback for an older extension. The patched
    // extension always sends requestId, but this lets one in-flight legacy
    // request still complete instead of failing outright.
    if (!requestId) {
      requestId = Array.from(this.pendingResponses.entries()).find(
        ([, pending]) => pending.roomId === roomId,
      )?.[0];
    }

    if (!requestId) {
      console.warn('ApiBeam received a response without a matching requestId');
      return;
    }

    const pending = this.pendingResponses.get(requestId);
    if (!pending || pending.roomId !== roomId) {
      console.warn(`Ignoring late or unknown ApiBeam response ${requestId}`);
      return;
    }

    const timeout = this.pendingTimeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(requestId);
    }

    pending.resolve(message);
    this.pendingResponses.delete(requestId);
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
