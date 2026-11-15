/** The coach's conversation store: LangGraph's Postgres checkpointer on the Supabase pooled URL. */
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPostgresPool } from './postgres.js';

/**
 * PostgresSaver that runs `setup()` (creating its own tables) once, on first use.
 * A small pool: on serverless each instance keeps at most 2 connections to the pooler.
 */
export class LazyPostgresSaver extends PostgresSaver {
  private ready: Promise<void> | null = null;
  private ensure() {
    this.ready ??= this.setup().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }
  override async getTuple(config: RunnableConfig) {
    await this.ensure();
    return super.getTuple(config);
  }
  override async *list(config: RunnableConfig, options?: CheckpointListOptions) {
    await this.ensure();
    yield* super.list(config, options);
  }
  override async put(...args: Parameters<PostgresSaver['put']>) {
    await this.ensure();
    return super.put(...args);
  }
  override async putWrites(...args: Parameters<PostgresSaver['putWrites']>) {
    await this.ensure();
    return super.putWrites(...args);
  }
  override async deleteThread(threadId: string) {
    await this.ensure();
    return super.deleteThread(threadId);
  }
}

export function createPostgresCheckpointer(url: string): LazyPostgresSaver {
  return new LazyPostgresSaver(createPostgresPool(url));
}
