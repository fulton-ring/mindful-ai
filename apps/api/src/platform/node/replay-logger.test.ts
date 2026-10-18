import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { expect, it } from 'vitest';

const host = await import('./execution-host');

it('propagates native Redis replay cleanup failures instead of acknowledging deletion', async () => {
  const client = {
    isOpen: false,
    connect: async () => {
      client.isOpen = true;
    },
    on: () => client,
    del: async () => {
      throw new Error('disposable transport failure');
    },
    xRange: async () => {
      throw new Error('disposable transport failure');
    },
  };
  type Client = NonNullable<ConstructorParameters<typeof RedisStreamsPubSub>[0]>['client'];
  const pubsub = new RedisStreamsPubSub({
    client: client as unknown as Client,
    logger: host.replayPubSubLogger,
  });
  await expect(pubsub.clearTopic('topic')).rejects.toThrow();
  await expect(pubsub.trimTopic('topic', { runId: 'turn' })).rejects.toThrow();
});
