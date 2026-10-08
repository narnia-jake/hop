// 새 메모를 달 자리 — 에디터의 선택/커서에서 엔진 insertMemo 인자로.
//
// 엔진은 한 문단 안의 범위만 받는다. 선택이 문단을 넘으면 첫 문단 끝까지만 단다
// (끝 글자 위치를 크게 주면 엔진이 문단 끝으로 자른다). 선택이 없으면 커서 뒤 한 글자.

import type { MemoLocation, MemoTarget } from '@/core/tauri-bridge';

/** DocumentPosition 중 여기서 쓰는 것만. */
export interface MemoCaret {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  cellPath?: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;
  isTextBox?: boolean;
}

/** 문단 끝까지 — 엔진이 문단 글자 수로 자른다 (u32). */
const TO_PARAGRAPH_END = 0x7fff_ffff;

function cellPathOf(pos: MemoCaret): MemoTarget['cellPath'] {
  if (pos.cellPath?.length) return pos.cellPath.map((e) => ({ ...e }));
  if (pos.parentParaIndex !== undefined && pos.controlIndex !== undefined) {
    return [{ controlIndex: pos.controlIndex, cellIndex: pos.cellIndex ?? 0, cellParaIndex: pos.cellParaIndex ?? 0 }];
  }
  return [];
}

function sameParagraph(a: MemoCaret, b: MemoCaret): boolean {
  return a.sectionIndex === b.sectionIndex
    && (a.parentParaIndex ?? a.paragraphIndex) === (b.parentParaIndex ?? b.paragraphIndex)
    && JSON.stringify(cellPathOf(a)) === JSON.stringify(cellPathOf(b))
    && (cellPathOf(a).length > 0 || a.paragraphIndex === b.paragraphIndex);
}

/** 글상자 안이면 null (엔진이 아직 셀 경로만 받는다). */
export function memoTargetFrom(
  selection: { start: MemoCaret; end: MemoCaret } | null,
  caret: MemoCaret,
): MemoTarget | null {
  const start = selection?.start ?? caret;
  if (start.isTextBox) return null;
  const cellPath = cellPathOf(start);
  let end: number;
  if (!selection) end = start.charOffset + 1;
  else if (sameParagraph(start, selection.end)) end = selection.end.charOffset;
  else end = TO_PARAGRAPH_END;
  return {
    sectionIdx: start.sectionIndex,
    paraIdx: cellPath.length ? (start.parentParaIndex ?? start.paragraphIndex) : start.paragraphIndex,
    cellPath,
    start: start.charOffset,
    end: Math.max(end, start.charOffset),
  };
}

/** 새 메모 초안을 그릴 때 쓰는 앵커 위치 (getFieldList 꼴). */
export function locationOf(target: MemoTarget): MemoLocation {
  const location: MemoLocation = { sectionIndex: target.sectionIdx, paraIndex: target.paraIdx };
  if (target.cellPath.length) {
    location.path = target.cellPath.map((e) => ({
      controlIndex: e.controlIndex,
      cellIndex: e.cellIndex,
      paraIndex: e.cellParaIndex,
    }));
  }
  return location;
}
