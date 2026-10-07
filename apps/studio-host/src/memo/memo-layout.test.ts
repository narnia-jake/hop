import { describe, expect, it } from 'vitest';
import type { DocumentMemo } from '@/core/tauri-bridge';
import { layoutMemos, memoIdOf, stackBalloons, type MemoDocument, type MemoRect } from './memo-layout';

const memo = (over: Partial<DocumentMemo> & { id: number }): DocumentMemo => ({
  text: `메모 ${over.id}`,
  author: '검토자',
  sectionIdx: 0,
  paraIdx: 0,
  charOffset: 0,
  anchorText: '',
  ...over,
});

const rect = (pageIndex: number, y: number): MemoRect => ({ pageIndex, x: 10, y, width: 50, height: 12 });

function fakeDoc(over: Partial<MemoDocument> = {}): MemoDocument & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getFieldList: () => [],
    getSelectionRects: (...args) => { calls.push(`rects:${args.join(',')}`); return [rect(0, 100)]; },
    getSelectionRectsInCell: (...args) => { calls.push(`cell:${args.join(',')}`); return [rect(2, 300)]; },
    getSelectionRectsInCellByPath: (...args) => { calls.push(`path:${args.join(',')}`); return [rect(1, 200)]; },
    searchAllText: () => [],
    getPageOfPosition: () => ({ ok: true, page: 5 }),
    ...over,
  };
}

describe('memoIdOf', () => {
  it('reads the memo id from a MEMO field command', () => {
    expect(memoIdOf('MEMO/65535/18/100000001/200000002/검토자/\\;;')).toBe(18);
    expect(memoIdOf('CLICKHERE/1/')).toBeNull();
    expect(memoIdOf(undefined)).toBeNull();
  });
});

describe('layoutMemos', () => {
  it('places memos whose field is listed, converting the cell path for the rect API', () => {
    const doc = fakeDoc({
      getFieldList: () => [{
        command: 'MEMO/65535/1/0/0/검토자/',
        location: { sectionIndex: 0, paraIndex: 43, path: [{ controlIndex: 0, cellIndex: 3, paraIndex: 5 }] },
        startCharIdx: 0,
        endCharIdx: 37,
      }],
    });
    const [placed] = layoutMemos(doc, [memo({ id: 1 })]);
    expect(placed.how).toBe('field');
    expect(placed.pageIndex).toBe(1);
    // getFieldList 의 paraIndex → rect API 의 cellParaIndex
    expect(doc.calls[0]).toBe('path:0,43,[{"controlIndex":0,"cellIndex":3,"cellParaIndex":5}],5,0,5,37');
  });

  it('falls back to searching the anchor text in the same top-level paragraph', () => {
    // 문단을 넘어가는 메모는 getFieldList 에 안 나온다
    const doc = fakeDoc({
      searchAllText: () => [
        { sec: 0, para: 99, charOffset: 0, cellContext: { parentPara: 99, ctrlIdx: 0, cellIdx: 1, cellPara: 0 } },
        { sec: 0, para: 65, charOffset: 0, cellContext: { parentPara: 65, ctrlIdx: 0, cellIdx: 7, cellPara: 2 } },
      ],
    });
    const [placed] = layoutMemos(doc, [memo({ id: 2, paraIdx: 65, anchorText: '1.01 ~ 1.09' })]);
    expect(placed.how).toBe('search');
    expect(placed.pageIndex).toBe(2);
    expect(doc.calls[0]).toBe('cell:0,65,0,7,2,0,2,11'); // 끝 = 시작 + 앵커 글자 수
  });

  it('prefers the search hit at the parsed character offset', () => {
    const doc = fakeDoc({
      searchAllText: () => [
        { sec: 0, para: 4, charOffset: 0 },
        { sec: 0, para: 4, charOffset: 9 },
      ],
    });
    layoutMemos(doc, [memo({ id: 3, paraIdx: 4, charOffset: 9, anchorText: '앵커' })]);
    expect(doc.calls[0]).toBe('rects:0,4,9,4,11');
  });

  it('falls back to the page only, and survives engine exceptions', () => {
    const doc = fakeDoc({ getFieldList: () => { throw new Error('no document'); } });
    const [placed] = layoutMemos(doc, [memo({ id: 4, paraIdx: 10 })]);
    expect(placed).toMatchObject({ how: 'page', pageIndex: 5, rects: [] });

    const throwing = fakeDoc({ getPageOfPosition: () => { throw new Error('out of range'); } });
    expect(layoutMemos(throwing, [memo({ id: 5, paraIdx: 999 })])[0]).toMatchObject({ how: 'none', pageIndex: null });
  });

  it('returns nothing for no memos', () => {
    expect(layoutMemos(fakeDoc(), [])).toEqual([]);
  });
});

describe('stackBalloons', () => {
  it('keeps balloons at their anchor but pushes overlapping ones down', () => {
    expect(stackBalloons([100, 105, 400], [40, 40, 40], 8)).toEqual([100, 148, 400]);
  });

  it('stacks by anchor order regardless of input order', () => {
    expect(stackBalloons([300, 100], [50, 250], 10)).toEqual([360, 100]);
  });
});
