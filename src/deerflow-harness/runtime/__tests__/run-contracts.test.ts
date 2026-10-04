import { describe, expect, it } from 'vitest';

import { InMemoryRunRegistry } from '../run-registry/in-memory';
import { InMemoryRunEventBus } from '../event-bus/in-memory';
import { StreamBridge } from '../stream-bridge';
import { describeRunRegistryContract, describeRunEventBusContract } from './contract-cases';

// 进程内实现的契约一致性（跨进程实现接入后在实现清单追加一行即可复用同一组用例）
describeRunRegistryContract({
  name: 'InMemoryRunRegistry',
  make: () => new InMemoryRunRegistry(),
  distributed: false,
});

describeRunEventBusContract({
  name: 'InMemoryRunEventBus',
  make: () => new InMemoryRunEventBus(new StreamBridge()),
  distributed: false,
});

// 进程内实现特有语义（不进契约用例）：requestCancel 回报即本进程 handler 命中数之和
describe('InMemoryRunRegistry 实现语义', () => {
  it('多个 handler 的命中数求和', async () => {
    const r = new InMemoryRunRegistry();
    r.onCancelRequest(() => 1);
    r.onCancelRequest(() => 1);
    r.onCancelRequest(() => 0);
    expect(await r.requestCancel('r1', 'why')).toBe(2);
  });
});
