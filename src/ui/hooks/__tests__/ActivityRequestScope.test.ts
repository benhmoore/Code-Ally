import { describe, expect, it } from 'vitest';
import { ActivityRequestScope } from '../activity/ActivityRequestScope.js';

describe('activity publication ownership', () => {
  it('rejects stale completion after another request, route, or unmount', () => {
    const scope = new ActivityRequestScope();
    scope.updateRoute('library:first');
    const first = scope.capture();
    scope.invalidate();
    expect(first()).toBe(false);
    const second = scope.capture();
    scope.updateRoute('model:next');
    expect(second()).toBe(false);
    const third = scope.capture();
    scope.close();
    expect(third()).toBe(false);
    scope.open();
    expect(third()).toBe(false);
  });

  it('permits publication after intentionally closing the initiating modal', () => {
    const scope = new ActivityRequestScope();
    scope.updateRoute('library:first');
    const current = scope.capture();
    scope.updateRoute(undefined);
    expect(current()).toBe(true);
  });
});
