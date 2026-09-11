import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const chunks = (text: string, size = 64) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

@Injectable()
export class StreamMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const isStream =
      req.body?.stream === true ||
      req.body?.stream === 'true' ||
      req.query?.stream === 'true' ||
      (req.headers?.accept || '').includes('text/event-stream');

    if (isStream) {
      res.json = function (body: any) {
        if (body?.error) {
          res.setHeader('Content-Type', 'application/json');
          if (res.statusCode < 400) res.statusCode = 502;
          res.end(JSON.stringify(body));
          return this;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        if (req.originalUrl.includes('/chat/completions')) {
          const choice = body.choices?.[0] || {};
          const message = choice.message || {};
          const responseId = body.id || `chatcmpl_${Date.now()}`;
          const created = body.created || Math.floor(Date.now() / 1000);
          const model = body.model || req.body?.model || 'gpt-5.6-sol';

          const writeChunk = (delta: any, finishReason: string | null = null) => {
            res.write(
              `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: finishReason,
                  },
                ],
              })}\n\n`,
            );
          };

          writeChunk({ role: 'assistant' });

          if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
            message.tool_calls.forEach((toolCall: any, index: number) => {
              writeChunk({
                tool_calls: [
                  {
                    index,
                    id: toolCall.id,
                    type: toolCall.type || 'function',
                    function: {
                      name: toolCall.function?.name || '',
                      arguments: '',
                    },
                  },
                ],
              });

              const args = toolCall.function?.arguments || '';
              for (const part of chunks(args)) {
                writeChunk({
                  tool_calls: [
                    {
                      index,
                      function: { arguments: part },
                    },
                  ],
                });
              }
            });
            writeChunk({}, choice.finish_reason || 'tool_calls');
          } else {
            const content =
              typeof message.content === 'string' ? message.content : '';
            for (const part of chunks(content)) writeChunk({ content: part });
            writeChunk({}, choice.finish_reason || 'stop');
          }

          res.write('data: [DONE]\n\n');
          res.end();
          return this;
        }

        if (req.originalUrl.includes('/v1/responses')) {
          const responseId = body.id || `resp_${Date.now()}`;
          const createdAt = body.created_at || Math.floor(Date.now() / 1000);
          const model = body.model || req.body?.model || 'gpt-5.6-sol';

          const outputItem = body.output?.[0] || {
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '' }],
          };

          const itemId = outputItem.id;
          const fullText = outputItem.content?.[0]?.text || '';

          res.write(
            `data: ${JSON.stringify({
              type: 'response.created',
              response: {
                id: responseId,
                object: 'response',
                created_at: createdAt,
                model,
                status: 'in_progress',
              },
            })}\n\n`,
          );

          res.write(
            `data: ${JSON.stringify({
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: itemId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            })}\n\n`,
          );

          for (const part of chunks(fullText)) {
            res.write(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                item_id: itemId,
                delta: part,
              })}\n\n`,
            );
          }

          res.write(
            `data: ${JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item: outputItem,
            })}\n\n`,
          );

          res.write(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: body,
            })}\n\n`,
          );

          res.write('data: [DONE]\n\n');
          res.end();
          return this;
        }

        res.write(`data: ${JSON.stringify(body)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return this;
      };
    }

    next();
  }
}
