import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SocketGateway } from './socket.gateway';

@Controller('connect')
export class SocketController {
  constructor(private readonly gateway: SocketGateway) {}

  @Get(':roomId')
  connectUser(
    @Param('roomId') roomId: string,
    @Query('socketId') socketId: string,
  ) {
    const client = this.gateway.server.sockets.sockets.get(socketId);

    if (!client) {
      return { success: false, message: 'Invalid socketId' };
    }

    this.gateway.joinRoom(client, roomId);

    return {
      success: true,
      joined: roomId,
      socketId,
    };
  }

  @Get(':roomId/next')
  next(@Param('roomId') roomId: string) {
    return { request: this.gateway.getNextHttpRequest(roomId) };
  }

  @Post(':roomId/response')
  response(
    @Param('roomId') roomId: string,
    @Body() body: { requestId?: string; message: any },
  ) {
    return this.gateway.respondFromHttpBridge({ roomId, ...body });
  }
}
