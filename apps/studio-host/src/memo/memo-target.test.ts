import { describe, expect, it } from 'vitest';
import { locationOf, memoTargetFrom, type MemoCaret } from './memo-target';

const body = (para: number, offset: number): MemoCaret => ({ sectionIndex: 0, paragraphIndex: para, charOffset: offset });
const cell = (offset: number, cellPara = 1): MemoCaret => ({
  sectionIndex: 0,
  paragraphIndex: cellPara,
  charOffset: offset,
  parentParaIndex: 7,
  controlIndex: 0,
  cellIndex: 3,
  cellParaIndex: cellPara,
  cellPath: [{ controlIndex: 0, cellIndex: 3, cellParaIndex: cellPara }],
});

describe('memoTargetFrom', () => {
  it('uses the selection inside one paragraph', () => {
    expect(memoTargetFrom({ start: body(4, 2), end: body(4, 9) }, body(4, 9)))
      .toEqual({ sectionIdx: 0, paraIdx: 4, cellPath: [], start: 2, end: 9 });
  });

  it('cuts a selection across paragraphs at the end of the first one', () => {
    const t = memoTargetFrom({ start: body(4, 2), end: body(6, 1) }, body(6, 1))!;
    expect(t.start).toBe(2);
    expect(t.end).toBeGreaterThan(1_000_000);
  });

  it('takes one character after the caret without a selection', () => {
    expect(memoTargetFrom(null, body(3, 5))).toMatchObject({ paraIdx: 3, start: 5, end: 6 });
  });

  it('addresses a table cell by its parent paragraph and path', () => {
    const t = memoTargetFrom({ start: cell(1), end: cell(4) }, cell(4))!;
    expect(t).toEqual({
      sectionIdx: 0, paraIdx: 7, cellPath: [{ controlIndex: 0, cellIndex: 3, cellParaIndex: 1 }], start: 1, end: 4,
    });
    expect(locationOf(t)).toEqual({ sectionIndex: 0, paraIndex: 7, path: [{ controlIndex: 0, cellIndex: 3, paraIndex: 1 }] });
    // 같은 셀의 다른 문단까지 고르면 첫 문단 끝까지
    expect(memoTargetFrom({ start: cell(1, 1), end: cell(2, 2) }, cell(2, 2))!.end).toBeGreaterThan(1_000_000);
  });

  it('refuses text boxes', () => {
    expect(memoTargetFrom(null, { ...body(0, 0), isTextBox: true })).toBeNull();
  });
});
