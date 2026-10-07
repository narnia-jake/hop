// 메모가 본문 어디에 걸려 있는지, 쪽 좌표(96dpi CSS px)로 구한다.
//
// rhwp 는 메모를 그리지 않는다. 메모 '글' 은 네이티브(apps/desktop/hwp-memo)가 파일에서 읽어
// 주고, 여기서는 '어디에' 를 지금 문서에서 매번 새로 구한다 — 편집으로 글이 밀려도 따라간다.
// DOM 은 건드리지 않는다.
//
//   1) getFieldList() 의 MEMO 필드 — 셀 경로·글자 범위까지 정확하다.
//      다만 한 문단 안에서 끝나는 필드만 나온다.
//   2) 문단을 넘어가는 메모는 1) 에 없다. 네이티브가 준 앵커 글자로 searchAllText 를 돌려
//      같은 최상위 문단·같은 글자 위치의 결과를 고른다.
//   3) 그래도 못 찾으면 쪽만 구해 사각형 없이 돌려준다.

import type { DocumentMemo } from '@/core/tauri-bridge';

export interface MemoRect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MemoPlacement {
  memo: DocumentMemo;
  pageIndex: number | null;
  rects: MemoRect[];
  how: 'field' | 'search' | 'page' | 'none';
}

interface FieldEntry {
  command: string;
  location: { sectionIndex: number; paraIndex: number; path?: Array<{ controlIndex: number; cellIndex: number; paraIndex: number }> };
  startCharIdx?: number;
  endCharIdx?: number;
}

interface SearchHitLike {
  sec: number;
  para: number;
  charOffset: number;
  cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number };
}

/** WasmBridge 중 이 모듈이 쓰는 공개 메서드만. 테스트에서 가짜로 갈아 끼운다. */
export interface MemoDocument {
  getFieldList(): FieldEntry[];
  getSelectionRects(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): MemoRect[];
  getSelectionRectsInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): MemoRect[];
  getSelectionRectsInCellByPath(sec: number, parentPara: number, path: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): MemoRect[];
  searchAllText(query: string, caseSensitive: boolean, includeCells?: boolean): SearchHitLike[];
  getPageOfPosition(sectionIdx: number, paraIdx: number): { ok: boolean; page?: number };
}

export function memoIdOf(command: string | undefined): number | null {
  const m = /^MEMO\/\d+\/(\d+)\//.exec(command ?? '');
  return m ? Number(m[1]) : null;
}

function rectsForField(doc: MemoDocument, field: FieldEntry): MemoRect[] {
  const loc = field.location;
  const path = loc.path ?? [];
  const start = field.startCharIdx ?? 0;
  const end = field.endCharIdx ?? start;
  if (!path.length) return doc.getSelectionRects(loc.sectionIndex, loc.paraIndex, start, loc.paraIndex, end);
  const last = path[path.length - 1];
  // getFieldList 는 paraIndex 로 주고 rect API 는 cellParaIndex 로 받는다.
  const rectPath = path.map((step) => ({
    controlIndex: step.controlIndex,
    cellIndex: step.cellIndex,
    cellParaIndex: step.paraIndex,
  }));
  return doc.getSelectionRectsInCellByPath(
    loc.sectionIndex, loc.paraIndex, JSON.stringify(rectPath), last.paraIndex, start, last.paraIndex, end,
  );
}

function rectsBySearch(doc: MemoDocument, memo: DocumentMemo): MemoRect[] {
  const anchor = (memo.anchorText ?? '').trim();
  if (!anchor || memo.paraIdx === null || memo.paraIdx === undefined) return [];
  // 긴 검색어는 줄바꿈·특수문자에서 어긋나기 쉽다. 앞부분만 쓴다.
  const hits = doc.searchAllText(anchor.slice(0, 24), true, true);
  const same = hits.filter((h) => h.sec === (memo.sectionIdx ?? 0)
    && (h.cellContext ? h.cellContext.parentPara : h.para) === memo.paraIdx);
  if (!same.length) return [];
  const hit = same.find((h) => h.charOffset === memo.charOffset) ?? same[0];
  const c = hit.cellContext;
  const end = hit.charOffset + anchor.length;
  return c
    ? doc.getSelectionRectsInCell(hit.sec, c.parentPara, c.ctrlIdx, c.cellIdx, c.cellPara, hit.charOffset, c.cellPara, end)
    : doc.getSelectionRects(hit.sec, hit.para, hit.charOffset, hit.para, end);
}

function pageOnly(doc: MemoDocument, memo: DocumentMemo): number | null {
  if (memo.paraIdx === null || memo.paraIdx === undefined) return null;
  try {
    const located = doc.getPageOfPosition(memo.sectionIdx ?? 0, memo.paraIdx);
    return located.ok && typeof located.page === 'number' ? located.page : null;
  } catch {
    return null; // 범위를 벗어난 문단이면 예외를 던진다 (ok:false 가 아니다)
  }
}

export function layoutMemos(doc: MemoDocument, memos: readonly DocumentMemo[]): MemoPlacement[] {
  if (!memos.length) return [];
  const fields = new Map<number, FieldEntry>();
  let fieldList: FieldEntry[] = [];
  try {
    fieldList = doc.getFieldList();
  } catch {
    fieldList = [];
  }
  for (const field of fieldList) {
    const id = memoIdOf(field.command);
    if (id !== null && !fields.has(id)) fields.set(id, field);
  }

  return memos.map((memo): MemoPlacement => {
    let rects: MemoRect[] = [];
    let how: MemoPlacement['how'] = 'none';
    try {
      const field = fields.get(memo.id);
      if (field) {
        rects = rectsForField(doc, field);
        how = 'field';
      }
      if (!rects.length) {
        rects = rectsBySearch(doc, memo);
        how = 'search';
      }
    } catch {
      rects = [];
    }
    if (rects.length) return { memo, pageIndex: rects[0].pageIndex, rects, how };
    const page = pageOnly(doc, memo);
    return { memo, pageIndex: page, rects: [], how: page === null ? 'none' : 'page' };
  });
}

/**
 * 풍선 세로 위치. 걸린 글자 높이에 맞추되, 앞 풍선과 겹치면 아래로 민다.
 * `wanted` 는 문서 좌표(스크롤 내용 기준) y, `heights` 는 풍선 높이.
 */
export function stackBalloons(wanted: readonly number[], heights: readonly number[], gap = 8): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const out = new Array<number>(wanted.length);
  let floor = -Infinity;
  for (const { y, i } of order) {
    const top = Math.max(y, floor);
    out[i] = top;
    floor = top + (heights[i] ?? 0) + gap;
  }
  return out;
}
