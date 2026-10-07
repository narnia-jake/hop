import type { CommandDef } from '@/upstream/commands';
import { TOGGLE_MEMOS_EVENT } from '../../memo/events';

/**
 * HOP 메모 명령. 한글의 '보기 › 메모' 에 해당한다.
 * 메모 칸은 memo-layer.ts 가 그리고, 이 명령은 켜고 끄는 신호만 보낸다.
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
];
