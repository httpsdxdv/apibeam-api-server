import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SocketGateway } from './socket/socket.gateway';

const getTrimRoute = (route: string) => {
  const match = route.match(/^\/app\/[^/]+\/(.+)$/);
  return match?.[1] || route;
};

@Controller('app')
export class AppController {
  constructor(private readonly gateway: SocketGateway) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'apibeam-api-server',
      timestamp: new Date().toISOString(),
    };
  }

  private getConfiguredModels() {
    const configured = (process.env.APIBEAM_MODELS || 'gpt-5.6-sol,gpt-4o')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);

    return {
      object: 'list',
      data: configured.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'apibeam',
      })),
    };
  }

  @Get(':roomId/models')
  models() {
    return this.getConfiguredModels();
  }

  @Get(':roomId/v1/models')
  v1Models() {
    return this.getConfiguredModels();
  }

  @Get(':roomId/status')
  roomStatus(@Param('roomId') roomId: string) {
    return {
      roomId,
      ...this.gateway.getRoomTransportStatus(roomId),
    };
  }

  private extractText(value: any): string | null {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;

    if (typeof value.text === 'string') return value.text;
    if (typeof value.output_text === 'string') return value.output_text;

    const choiceContent = value.choices?.[0]?.message?.content;
    if (typeof choiceContent === 'string') return choiceContent;
    if (Array.isArray(choiceContent)) {
      const text = choiceContent
        .map((part: any) =>
          typeof part === 'string'
            ? part
            : typeof part?.text === 'string'
              ? part.text
              : '',
        )
        .join('');
      if (text) return text;
    }

    const output = value.output;
    if (Array.isArray(output)) {
      const chunks: string[] = [];
      for (const item of output) {
        if (!Array.isArray(item?.content)) continue;
        for (const part of item.content) {
          if (typeof part?.text === 'string') chunks.push(part.text);
        }
      }
      if (chunks.length) return chunks.join('');
    }

    return null;
  }

  private normalizeResponse(route: string, requestBody: any, response: any) {
    if (response?.error) return response;

    const normalizedRoute = route.replace(/^\/+/, '');
    const model = requestBody?.model || response?.model || 'gpt-5.6-sol';

    if (normalizedRoute.endsWith('chat/completions')) {
      if (Array.isArray(response?.choices)) return response;

      const text = this.extractText(response);
      return {
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text ?? JSON.stringify(response ?? {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
    }

    if (normalizedRoute.endsWith('responses')) {
      if (response?.object === 'response' && Array.isArray(response?.output)) {
        return response;
      }

      const text = this.extractText(response) ?? JSON.stringify(response ?? {});
      return {
        id: `resp_${Date.now()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model,
        output: [
          {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text }],
          },
        ],
      };
    }

    return response;
  }

  private async handleHttpRequest(
    roomId: string,
    payload: any,
    res: Response,
  ) {
    try {
      const response = await this.gateway.sendToRoomAndWait(roomId, payload);
      const normalized = this.normalizeResponse(
        payload.route || '',
        payload.body,
        response,
      );
      res.status(200).json(normalized);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const message = error instanceof Error ? error.message : String(error);

      res.status(status).json({
        error: {
          message,
          type: status === 504 ? 'gateway_timeout' : 'apibeam_relay_error',
          code: status === 504 ? 'apibeam_timeout' : 'apibeam_relay_error',
        },
      });
    }
  }

  @Get(':roomId/test-me')
  async test(
    @Param('roomId') roomId: string,
    @Query('message') message: string,
    @Res() res: Response,
  ) {
    return this.handleHttpRequest(
      roomId,
      {
        model: 'gpt-5.6-sol',
        instructions:
          'You are a personal assistant who is here to help me with my problems',
        body: message,
        route: 'responses',
      },
      res,
    );
  }

  @Get(':roomId/*')
  async getSendMessage(
    @Param('roomId') roomId: string,
    @Query() body: any,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const route = getTrimRoute(request.path);
    return this.handleHttpRequest(
      roomId,
      {
        body,
        route,
      },
      res,
    );
  }

  @Post(':roomId/*')
  async sendMessage(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const route = getTrimRoute(request.path);
    return this.handleHttpRequest(
      roomId,
      {
        body,
        route,
      },
      res,
    );
  }

  @Patch(':roomId/*')
  async patchSendMessage(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const route = getTrimRoute(request.path);
    return this.handleHttpRequest(roomId, { body, route }, res);
  }

  @Put(':roomId/*')
  async putSendMessage(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const route = getTrimRoute(request.path);
    return this.handleHttpRequest(roomId, { body, route }, res);
  }

  @Delete(':roomId/*')
  async deleteSendMessage(
    @Param('roomId') roomId: string,
    @Body() body: any,
    @Req() request: Request,
    @Res() res: Response,
  ) {
    const route = getTrimRoute(request.path);
    return this.handleHttpRequest(roomId, { body, route }, res);
  }
}
