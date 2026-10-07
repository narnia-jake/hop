import { describe, expect, it, vi } from 'vitest';
import { memoCommands } from './memo';
import { TOGGLE_MEMOS_EVENT } from '../../memo/events';

describe('memoCommands', () => {
  it('toggles the memo column through the event bus, only with a document', () => {
    const [toggle] = memoCommands;
    expect(toggle.id).toBe('view:toggle-memos');
    expect(toggle.canExecute?.({ hasDocument: false } as never)).toBe(false);
    expect(toggle.canExecute?.({ hasDocument: true } as never)).toBe(true);
    const emit = vi.fn();
    toggle.execute({ eventBus: { emit } } as never);
    expect(emit).toHaveBeenCalledWith(TOGGLE_MEMOS_EVENT);
  });
});
