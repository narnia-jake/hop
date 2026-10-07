// 메모(주석)를 한글처럼 그린다 — 걸린 글자에 형광, 오른쪽 메모 칸에 풍선, 둘을 점선으로.
//
// rhwp-studio 는 메모를 그리지 않는다. 상류를 고치지 않고 바깥에서 얹는다.
//
// - 형광·점선(앞부분) : #scroll-content 안에 그린다 → 문서와 같이 스크롤된다.
// - 풍선            : #editor-area 의 오른쪽 셋째 칸(메모 칸)에 그리고 스크롤에 맞춰 옮긴다.
// - 메모 칸 자리     : 메모가 보이는 동안 #editor-area 에 칸을 하나 더한다. 그러면 스크롤
//   영역이 좁아지고, 에디터가 스스로 폭을 다시 재므로(ResizeObserver) 가운데 정렬·폭 맞춤·
//   클릭 → 쪽 좌표 변환이 모두 그대로 맞는다. 스크롤 내용을 임의로 넓히면 이게 어긋난다.
//
// 쪽 위치는 CanvasView 의 공개 API(getVirtualScroll·getViewportManager)로 구한다.

import type { CanvasView } from '@/upstream/view';
import type { EventBus, WasmBridge } from '@/upstream/core';
import type { DocumentMemo } from '@/core/tauri-bridge';
import { layoutMemos, stackBalloons, type MemoDocument, type MemoPlacement } from './memo-layout';
import { TOGGLE_MEMOS_EVENT } from './events';
import './memo.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BALLOON_INSET = 12; // 메모 칸 왼쪽 끝 ~ 풍선

interface MemoLayerDependencies {
  wasm: WasmBridge;
  eventBus: EventBus;
  getCanvasView: () => CanvasView | null;
}

type MemoSource = { documentMemos?: () => Promise<DocumentMemo[] | null> };

export class MemoLayer {
  private memos: DocumentMemo[] = [];
  private visible = true;
  private placements: MemoPlacement[] = [];
  private focused: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;

  private readonly editorArea: HTMLElement;
  private readonly container: HTMLElement;
  private readonly content: HTMLElement;
  private readonly marks: HTMLDivElement;
  private readonly column: HTMLDivElement;
  private readonly columnInner: HTMLDivElement;

  constructor(private readonly deps: MemoLayerDependencies) {
    this.editorArea = document.getElementById('editor-area')!;
    this.container = document.getElementById('scroll-container')!;
    this.content = document.getElementById('scroll-content')!;

    this.marks = document.createElement('div');
    this.marks.className = 'hop-memo-marks';

    this.column = document.createElement('div');
    this.column.className = 'hop-memo-column';
    this.columnInner = document.createElement('div');
    this.columnInner.className = 'hop-memo-column-inner';
    this.column.append(this.columnInner);
    this.editorArea.append(this.column);

    this.container.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    const later = () => this.schedule();
    deps.eventBus.on('document-changed', () => this.schedule(180));
    deps.eventBus.on('document-layout-refreshed', later);
    deps.eventBus.on('zoom-changed', later);
    deps.eventBus.on('viewport-resize', later);
    deps.eventBus.on('create-new-document', () => this.setMemos([]));
    deps.eventBus.on(TOGGLE_MEMOS_EVENT, () => this.toggle());
  }

  /** 문서를 연 뒤 부른다. 네이티브에서 메모를 받아 그린다. */
  async reload(): Promise<void> {
    const token = ++this.loadToken;
    const source = this.deps.wasm as unknown as MemoSource;
    let memos: DocumentMemo[] | null = [];
    try {
      memos = (await source.documentMemos?.()) ?? [];
    } catch (error) {
      console.warn('[memo] 메모를 가져오지 못했습니다', error);
      memos = [];
    }
    if (token !== this.loadToken) return; // 그새 다른 문서가 열렸다
    if (memos === null) console.warn('[memo] 이 문서의 메모를 읽지 못했습니다 (암호·배포용 문서 등)');
    this.setMemos(memos ?? []);
  }

  setMemos(memos: DocumentMemo[]): void {
    this.memos = memos;
    this.focused = null;
    this.applyVisibility();
    this.schedule(0);
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.applyVisibility();
    this.schedule(0);
  }

  get count(): number {
    return this.memos.length;
  }

  get isVisible(): boolean {
    return this.visible && this.memos.length > 0;
  }

  private applyVisibility(): void {
    // 칸이 생기거나 사라지면 스크롤 영역 폭이 바뀌고, 에디터가 viewport-resize 로 다시 잰다.
    this.editorArea.classList.toggle('hop-memos', this.isVisible);
  }

  private schedule(delay = 120): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, delay);
  }

  private syncScroll(): void {
    this.columnInner.style.transform = `translateY(${-this.container.scrollTop}px)`;
  }

  private draw(): void {
    // 에디터가 문서를 바꿀 때 스크롤 내용을 비우므로 층이 빠졌을 수 있다.
    if (!this.marks.isConnected) this.content.append(this.marks);
    this.marks.replaceChildren();
    this.columnInner.replaceChildren();
    this.syncScroll();
    if (!this.isVisible) return;

    const view = this.deps.getCanvasView();
    if (!view || this.deps.wasm.pageCount === 0) return;
    const vs = view.getVirtualScroll();
    const zoom = view.getViewportManager().getZoom();
    const totalWidth = vs.getTotalWidth();
    const geometry = new Map<number, { left: number; top: number; width: number; height: number }>();
    const pageGeometry = (page: number) => {
      if (!geometry.has(page)) {
        const info = this.deps.wasm.getPageInfo(page);
        geometry.set(page, {
          left: vs.getPageLeftResolved(page, totalWidth),
          top: vs.getPageOffset(page),
          width: info.width * zoom,
          height: info.height * zoom,
        });
      }
      return geometry.get(page)!;
    };

    this.placements = layoutMemos(this.deps.wasm as unknown as MemoDocument, this.memos);
    const pageCount = this.deps.wasm.pageCount;

    // 형광 표시 — 사각형이 놓인 쪽마다
    for (const p of this.placements) {
      for (const r of p.rects) {
        if (r.pageIndex < 0 || r.pageIndex >= pageCount) continue;
        const g = pageGeometry(r.pageIndex);
        const mark = document.createElement('div');
        mark.className = 'hop-memo-mark';
        mark.dataset.memo = String(p.memo.id);
        Object.assign(mark.style, {
          left: `${g.left + r.x * zoom}px`,
          top: `${g.top + r.y * zoom}px`,
          width: `${Math.max(r.width * zoom, 3)}px`,
          height: `${r.height * zoom}px`,
        });
        this.marks.append(mark);
      }
    }

    // 풍선 — 걸린 글자 높이에 맞추고 겹치면 아래로 민다 (문서 좌표 = 메모 칸 좌표)
    const shown = this.placements.filter((p) => p.pageIndex !== null && p.pageIndex < pageCount);
    const anchors = shown.map((p) => this.anchorPoint(p, pageGeometry, zoom));
    const balloons = shown.map((p) => this.balloon(p));
    for (const b of balloons) this.columnInner.append(b);
    const tops = stackBalloons(anchors.map((a) => a.y - 6), balloons.map((b) => b.offsetHeight));
    balloons.forEach((b, i) => {
      b.style.top = `${tops[i]}px`;
    });

    // 점선 — 글자 끝 → 쪽 오른쪽 끝 → 스크롤 영역 오른쪽 끝(여기서 메모 칸으로 넘어간다)
    const contentLeft = this.content.offsetLeft;
    const rightEdge = this.container.clientWidth - contentLeft + this.container.scrollLeft;
    const wireA = document.createElementNS(SVG_NS, 'svg');
    wireA.setAttribute('class', 'hop-memo-wire');
    const wireB = document.createElementNS(SVG_NS, 'svg');
    wireB.setAttribute('class', 'hop-memo-wire');
    let maxY = 0;
    shown.forEach((p, i) => {
      const a = anchors[i];
      if (!a.hasText) return;
      const y = tops[i] + 10;
      maxY = Math.max(maxY, a.y, y);
      const pageRight = a.pageRight;
      wireA.append(polyline(`${a.x},${a.y} ${pageRight},${a.y} ${rightEdge},${y}`, p.memo.id));
      wireB.append(polyline(`0,${y} ${BALLOON_INSET},${y}`, p.memo.id));
    });
    for (const w of [wireA, wireB]) {
      w.setAttribute('width', String(Math.max(rightEdge, 1) + 2));
      w.setAttribute('height', String(maxY + 4));
    }
    this.marks.prepend(wireA);
    this.columnInner.prepend(wireB);

    if (this.focused !== null) this.applyFocus(this.focused);
  }

  private anchorPoint(
    p: MemoPlacement,
    pageGeometry: (page: number) => { left: number; top: number; width: number },
    zoom: number,
  ): { x: number; y: number; pageRight: number; hasText: boolean } {
    const g = pageGeometry(p.pageIndex!);
    const first = p.rects.find((r) => r.pageIndex === p.pageIndex);
    if (!first) return { x: g.left + g.width, y: g.top, pageRight: g.left + g.width, hasText: false };
    return {
      x: g.left + (first.x + first.width) * zoom,
      y: g.top + (first.y + first.height) * zoom,
      pageRight: g.left + g.width,
      hasText: true,
    };
  }

  private balloon(p: MemoPlacement): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'hop-memo-balloon';
    el.dataset.memo = String(p.memo.id);
    const meta = document.createElement('span');
    meta.className = 'hop-memo-meta';
    meta.textContent = p.memo.author || `메모 ${p.memo.id}`;
    el.append(meta, document.createTextNode(p.memo.text));
    el.addEventListener('click', () => this.toggleFocus(p.memo.id));
    return el;
  }

  private toggleFocus(id: number): void {
    this.focused = this.focused === id ? null : id;
    this.applyFocus(this.focused);
  }

  private applyFocus(id: number | null): void {
    for (const root of [this.marks, this.columnInner]) {
      for (const node of root.querySelectorAll('.is-focus')) node.classList.remove('is-focus');
      if (id !== null) for (const node of root.querySelectorAll(`[data-memo="${id}"]`)) node.classList.add('is-focus');
    }
  }
}

function polyline(points: string, id: number): SVGPolylineElement {
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('data-memo', String(id));
  return line;
}
