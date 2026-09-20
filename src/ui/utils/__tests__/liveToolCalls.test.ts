import { describe, expect, it } from 'vitest';
import { fitToolsToBudget, partitionCompletedToolCalls } from '../liveToolCalls.js';

const at = (startTime: number) => ({ id: `t${startTime}`, startTime });

describe('partitionCompletedToolCalls', () => {
  const completed = [at(10), at(20), at(30), at(40)];

  it('keeps calls later than the last committed item live while the turn runs', () => {
    const partition = partitionCompletedToolCalls(completed, 25, true);
    expect(partition.live.map((call) => call.id)).toEqual(['t30', 't40']);
    expect(partition.committed.map((call) => call.id)).toEqual(['t10', 't20']);
  });

  it('commits everything once the turn is over', () => {
    const partition = partitionCompletedToolCalls(completed, 25, false);
    expect(partition.live).toEqual([]);
    expect(partition.committed).toHaveLength(4);
  });

  it('bounds the live window to the newest calls', () => {
    const partition = partitionCompletedToolCalls(completed, 0, true, 2);
    expect(partition.live.map((call) => call.id)).toEqual(['t30', 't40']);
    expect(partition.committed.map((call) => call.id)).toEqual(['t10', 't20']);
  });
});

describe('fitToolsToBudget', () => {
  const rows = (tool: { rows: number }) => tool.rows;

  it('keeps the newest tools that fit, in order', () => {
    const tools = [{ id: 'a', rows: 3 }, { id: 'b', rows: 1 }, { id: 'c', rows: 2 }];
    expect(fitToolsToBudget(tools, 3, rows).map((tool) => tool.id)).toEqual(['b', 'c']);
    expect(fitToolsToBudget(tools, 6, rows).map((tool) => tool.id)).toEqual(['a', 'b', 'c']);
  });

  it('always keeps the newest tool even when it alone exceeds the budget', () => {
    expect(fitToolsToBudget([{ id: 'a', rows: 1 }, { id: 'b', rows: 9 }], 2, rows).map((tool) => tool.id)).toEqual(['b']);
  });
});
