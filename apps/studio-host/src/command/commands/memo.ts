import type { CommandDef } from '@/upstream/commands';
import { NEW_MEMO_EVENT, TOGGLE_MEMOS_EVENT } from '../../memo/events';

/**
 * HOP 메모 명령. 한글의 '보기 › 메모'·'입력 › 메모' 에 해당한다.
 * 메모 칸과 편집은 memo-layer.ts 가 맡고, 명령은 신호만 보낸다.
 */
export const memoCommands: CommandDef[] = [
  {
    id: 'view:toggle-memos',
    label: '메모 보이기/숨기기',
    canExecute: (ctx) => ctx.hasDocument,
    execute(services) {
      services.eventBus.emit(TOGGLE_MEMOS_EVENT);
    },
  },
  {
    id: 'insert:memo',
    label: '새 메모',
    canExecute: (ctx) => ctx.hasDocument && ctx.isEditable,
    execute(services) {
      services.eventBus.emit(NEW_MEMO_EVENT);
    },
  },
];
