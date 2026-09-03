const assert = require('assert');

// 模拟文档数据库中的一个未触发标的
let dbDoc = {
  _id: 'test_watch_001',
  code: '601137',
  name: '博威合金',
  buyPrice: 18.0,
  sellPrice: 21.0,
  buyTriggered: false,
  sellTriggered: false,
  currentPrice: 18.5,
  previousPrice: 18.5,
};

let touchInsertCount = 0;
let alertDispatchCount = 0;

// 模拟带有 CAS 原子锁的 where().update()
const mockDb = {
  command: {
    neq: (val) => ({ $neq: val }),
  },
  collection: (name) => ({
    where: (filter) => ({
      update: async (upd) => {
        // 原子检查条件
        if (filter._id === dbDoc._id) {
          if (filter.buyTriggered && filter.buyTriggered.$neq !== undefined) {
            if (dbDoc.buyTriggered === filter.buyTriggered.$neq) {
              return { updated: 0, stats: { updated: 0 } }; // 条件不匹配，抢占失败
            }
          }
          if (filter.sellTriggered && filter.sellTriggered.$neq !== undefined) {
            if (dbDoc.sellTriggered === filter.sellTriggered.$neq) {
              return { updated: 0, stats: { updated: 0 } };
            }
          }
          // 抢占成功，原子写入
          Object.assign(dbDoc, upd);
          return { updated: 1, stats: { updated: 1 } };
        }
        return { updated: 0, stats: { updated: 0 } };
      },
    }),
    doc: (id) => ({
      update: async (patch) => {
        Object.assign(dbDoc, patch);
        return { updated: 1 };
      },
    }),
  }),
};

// 模拟单个扫描任务运行
async function simulateScanWorker(workerId, currentPrice) {
  const w = { ...dbDoc };
  const triggers = [];
  if (w.buyPrice != null && currentPrice <= w.buyPrice && !w.buyTriggered) {
    triggers.push('buy');
  }

  if (!triggers.length) {
    return { workerId, triggers: 0, claimed: false };
  }

  const baseUpdate = { currentPrice, previousPrice: w.currentPrice };
  const upd = { ...baseUpdate, buyTriggered: true };

  const _ = mockDb.command;
  const casFilter = { _id: w._id };
  for (const t of triggers) {
    casFilter[`${t}Triggered`] = _.neq(true);
  }

  let claimed = false;
  try {
    const res = await mockDb.collection('ths_watchlist').where(casFilter).update(upd);
    const updatedCount = Number(res && res.updated != null ? res.updated : 0);
    claimed = updatedCount === 1;
  } catch (_) {
    claimed = false;
  }

  if (claimed) {
    touchInsertCount++;
    alertDispatchCount++;
  } else {
    await mockDb.collection('ths_watchlist').doc(w._id).update(baseUpdate);
  }

  return { workerId, triggers: triggers.length, claimed };
}

async function runConcurrencyTest() {
  console.log('--- 开始 CAS 并发竞争压力测试 (10 个并行 Worker) ---');
  touchInsertCount = 0;
  alertDispatchCount = 0;
  dbDoc.buyTriggered = false;

  // 10 个 Worker 同时在同一时刻以现价 17.80 (突破买入线 18.00) 并发运行
  const workers = Array.from({ length: 10 }, (_, i) => simulateScanWorker(`worker_${i + 1}`, 17.80));
  const results = await Promise.all(workers);

  const claimedWorkers = results.filter((r) => r.claimed);
  const rejectedWorkers = results.filter((r) => !r.claimed);

  console.log(`总并发数: ${results.length}`);
  console.log(`成功抢占数: ${claimedWorkers.length} (获胜者: ${claimedWorkers.map(w => w.workerId).join(', ')})`);
  console.log(`被拒绝数: ${rejectedWorkers.length}`);
  console.log(`触达事件写入数: ${touchInsertCount}`);
  console.log(`微信通知分发数: ${alertDispatchCount}`);
  console.log(`数据库最终 buyTriggered 状态: ${dbDoc.buyTriggered}`);

  assert.strictEqual(claimedWorkers.length, 1, '必须且只能有 1 个 worker 成功抢占');
  assert.strictEqual(rejectedWorkers.length, 9, '其余 9 个 worker 必须全部被拒绝');
  assert.strictEqual(touchInsertCount, 1, '触达事件写入次数必须且只能为 1');
  assert.strictEqual(alertDispatchCount, 1, '微信通知分发次数必须且只能为 1');
  assert.strictEqual(dbDoc.buyTriggered, true, '数据库必须被标记为已触发');

  console.log('✅ CAS 并发原子抢占测试 100% 通过！彻底杜绝重复触达与重复推送！');
}

runConcurrencyTest().catch((err) => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
