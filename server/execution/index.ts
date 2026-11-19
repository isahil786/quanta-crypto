// Execution adapter registry. Wire brokers here; the engine looks up adapters by broker id.
import { BrokerAdapterRegistry, ExecutionAdapter } from './types.js';
import { BinanceAdapter } from './binance.js';

export class ExecutionRegistry implements BrokerAdapterRegistry {
  private adapters = new Map<string, ExecutionAdapter>();

  register(adapter: ExecutionAdapter) {
    this.adapters.set(adapter.broker, adapter);
  }

  get(brokerId: string): ExecutionAdapter | undefined {
    return this.adapters.get(brokerId);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
