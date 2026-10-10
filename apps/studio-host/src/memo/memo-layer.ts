// 메모(주석)를 한글처럼 그리고 고친다 — 걸린 글자에 형광, 오른쪽 메모 칸에 풍선, 둘을 점선으로.
//
// rhwp-studio 는 메모를 그리지 않는다. 상류를 고치지 않고 바깥에서 얹는다.
//
// - 형광·점선(앞부분) : #scroll-content 안에 그린다 → 문서와 같이 스크롤된다.
// - 풍선            : #editor-area 의 오른쪽 셋째 칸(메모 칸)에 그리고 스크롤에 맞춰 옮긴다.
// - 메모 칸 자리     : 메모가 보이는 동안 #editor-area 에 칸을 하나 더한다. 그러면 스크롤
//   영역이 좁아지고, 에디터가 스스로 폭을 다시 재므로(ResizeObserver) 가운데 정렬·폭 맞춤·
//   클릭 → 쪽 좌표 변환이 모두 그대로 맞는다. 스크롤 내용을 임의로 넓히면 이게 어긋난다.
//
// 메모 목록과 추가·고치기·지우기는 엔진(포크한 rhwp 의 getMemoList/insertMemo/…)이 맡는다.
// 바꾸는 일은 에디터의 snapshot 연산으로 돌려 되돌리기(Ctrl+Z)에 걸리게 한다.
// 엔진에 메모 API 가 없으면 네이티브가 파일에서 읽은 목록을 보여 주기만 한다.
//
// 쪽 위치는 CanvasView 의 공개 API(getVirtualScroll·getViewportManager)로 구한다.

import type { CanvasView } from '@/upstream/view';
import type { DocumentPosition, EventBus, WasmBridge } from '@/upstream/core';
import type { DocumentMemo, MemoTarget } from '@/core/tauri-bridge';
import { layoutMemos, stackBalloons, type MemoDocument, type MemoPlacement } from './memo-layout';
import { locationOf, memoTargetFrom } from './memo-target';
import { NEW_MEMO_EVENT, TOGGLE_MEMOS_EVENT } from './events';
import './memo.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BALLOON_INSET = 12; // 메모 칸 왼쪽 끝 ~ 풍선
/** 마지막으로 고른 보이기/숨기기를 기억한다 (창마다가 아니라 앱 전체). */
const VISIBLE_KEY = 'hop.memos.visible';
/** 아직 엔진에 없는 새 메모(초안)의 번호. */
const DRAFT_ID = -1;
/** 새 메모 작성자 — 사용자가 마지막으로 쓴 이름. 없으면 OS 사용자 이름. */
const AUTHOR_KEY = 'hop.memos.author';

function readAuthorPreference(): string | null {
  try {
    return localStorage.getItem(AUTHOR_KEY);
  } catch {
    return null;
  }
}

function writeAuthorPreference(author: string): void {
  try {
    localStorage.setItem(AUTHOR_KEY, author);
  } catch {
    /* 저장소를 못 쓰면 이번 실행 동안만 유지한다 */
  }
}

function readVisiblePreference(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeVisiblePreference(visible: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, String(visible));
  } catch {
    /* 저장소를 못 쓰면 이번 실행 동안만 유지한다 */
  }
}

/** InputHandler 중 여기서 쓰는 것만. */
interface MemoInputHandler {
  getSelection(): { start: DocumentPosition; end: DocumentPosition } | null;
  getCursorPosition(): DocumentPosition;
  executeOperation(desc: { kind: 'snapshot'; operationType: string; operation: () => DocumentPosition | null }): void;
  focus?(): void;
}

/** TauriBridge 의 메모 메서드. 브라우저 개발 모드(WasmBridge)에는 없다. */
interface MemoSource {
  documentMemos?: () => Promise<DocumentMemo[] | null>;
  engineMemos?: () => DocumentMemo[] | null;
  insertMemo?: (target: MemoTarget, text: string, author: string) => number;
  updateMemo?: (id: number, text: string) => void;
  setMemoAuthor?: (id: number, author: string) => void;
  deleteMemo?: (id: number) => void;
  memoAuthor?: () => Promise<string>;
}

interface MemoLayerDependencies {
  wasm: WasmBridge;
  eventBus: EventBus;
  getCanvasView: () => CanvasView | null;
  getInputHandler: () => MemoInputHandler | null;
}

interface Editing {
  id: number;
  value: string;
  author: string;
  target?: MemoTarget;
  /** 다시 그린 뒤 포커스를 돌려줄 칸 */
  field?: 'author' | 'text';
}

export class MemoLayer {
  private memos: DocumentMemo[] = [];
  private visible = readVisiblePreference();
  private placements: MemoPlacement[] = [];
  private focused: number | null = null;
  private editing: Editing | null = null;
  private author: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  /** 지금 목록이 엔진에서 왔는가 (아니면 네이티브가 파일에서 읽은 읽기 전용 목록). */
  private fromEngine = false;

  private readonly editorArea: HTMLElement;
  private readonly container: HTMLElement;
  private readonly content: HTMLElement;
  private readonly marks: HTMLDivElement;
  private readonly column: HTMLDivElement;
  private readonly columnInner: HTMLDivElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly newButton: HTMLButtonElement;

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

    // 상태 표시줄: '+ 메모'(새 메모) 와 '메모 N'(보이기/숨기기 — 메뉴 View › Show/Hide Memos 와 같다)
    this.newButton = statusButton('+ 메모', '선택한 글자에 메모 달기', () => this.startNewMemo());
    this.toggleButton = statusButton('', '메모 보이기/숨기기', () => this.toggle());
    const right = document.querySelector('#status-bar .stb-right');
    right?.prepend(this.newButton, this.toggleButton);

    this.container.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    const later = () => this.schedule();
    deps.eventBus.on('document-changed', () => {
      this.refreshFromEngine();
      this.schedule(180);
    });
    deps.eventBus.on('document-layout-refreshed', later);
    deps.eventBus.on('zoom-changed', later);
    deps.eventBus.on('viewport-resize', later);
    deps.eventBus.on('create-new-document', () => {
      this.editing = null;
      this.setMemos([]);
    });
    deps.eventBus.on(TOGGLE_MEMOS_EVENT, () => this.toggle());
    deps.eventBus.on(NEW_MEMO_EVENT, () => this.startNewMemo());
    void this.loadDefaultAuthor();
    this.applyVisibility();
  }

  private get source(): MemoSource {
    return this.deps.wasm as unknown as MemoSource;
  }

  /** 엔진이 메모를 고칠 수 있는가 (포크한 rhwp + 데스크톱). 목록을 엔진에서 받았을 때만. */
  get canEdit(): boolean {
    return this.fromEngine && typeof this.source.insertMemo === 'function';
  }

  /** 문서를 연 뒤 부른다. 엔진(없으면 네이티브)에서 메모를 받아 그린다. */
  async reload(): Promise<void> {
    const token = ++this.loadToken;
    this.editing = null;
    const fromEngine = this.engineList();
    this.fromEngine = fromEngine !== null;
    if (fromEngine) {
      this.setMemos(fromEngine);
      return;
    }
    let memos: DocumentMemo[] | null = [];
    try {
      memos = (await this.source.documentMemos?.()) ?? [];
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
    if (this.focused !== null && !memos.some((m) => m.id === this.focused)) this.focused = null;
    if (this.editing && this.editing.id !== DRAFT_ID && !memos.some((m) => m.id === this.editing!.id)) {
      this.editing = null; // 되돌리기 등으로 고치던 메모가 사라졌다
    }
    this.applyVisibility();
    this.schedule(0);
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    writeVisiblePreference(this.visible);
    this.applyVisibility();
    this.schedule(0);
  }

  get count(): number {
    return this.memos.length;
  }

  get isVisible(): boolean {
    return (this.visible && this.memos.length > 0) || this.editing?.id === DRAFT_ID;
  }

  private engineList(): DocumentMemo[] | null {
    try {
      return this.source.engineMemos?.() ?? null;
    } catch (error) {
      console.warn('[memo] 엔진 메모 목록을 읽지 못했습니다', error);
      return null;
    }
  }

  /** 편집·되돌리기 뒤 엔진 목록으로 다시 맞춘다. 엔진 API 가 없으면 그대로 둔다. */
  private refreshFromEngine(): void {
    const list = this.engineList();
    if (!list) return;
    this.fromEngine = true;
    this.setMemos(list);
  }

  private applyVisibility(): void {
    // 칸이 생기거나 사라지면 스크롤 영역 폭이 바뀌고, 에디터가 viewport-resize 로 다시 잰다.
    this.editorArea.classList.toggle('hop-memos', this.isVisible);
    this.toggleButton.hidden = this.memos.length === 0;
    this.toggleButton.textContent = `메모 ${this.memos.length}`;
    this.toggleButton.setAttribute('aria-pressed', String(this.visible));
    this.newButton.hidden = !this.canEdit || this.deps.wasm.pageCount === 0;
  }

  // ── 고치기 ──────────────────────────────────────────────

  /** 지금 선택(없으면 커서 뒤 한 글자)에 새 메모 초안을 연다. */
  startNewMemo(): void {
    if (!this.canEdit) return;
    const ih = this.deps.getInputHandler();
    if (!ih) return;
    const target = memoTargetFrom(ih.getSelection(), ih.getCursorPosition());
    if (!target) {
      console.warn('[memo] 글상자 안에는 아직 메모를 달 수 없습니다');
      return;
    }
    this.editing = { id: DRAFT_ID, value: '', author: this.author ?? '', target };
    this.focused = DRAFT_ID;
    this.applyVisibility();
    this.schedule(0);
  }

  private startEdit(memo: DocumentMemo): void {
    if (!this.canEdit) return;
    this.editing = { id: memo.id, value: memo.text, author: memo.author ?? '' };
    this.focused = memo.id;
    this.schedule(0);
  }

  private cancelEdit(): void {
    this.editing = null;
    this.applyVisibility();
    this.schedule(0);
    this.deps.getInputHandler()?.focus?.();
  }

  private async commitEdit(): Promise<void> {
    const editing = this.editing;
    if (!editing) return;
    const text = editing.value.replace(/\s+$/, '');
    this.editing = null;
    try {
      const author = editing.author.trim();
      if (editing.id === DRAFT_ID) {
        if (text && editing.target) {
          const target = editing.target;
          this.rememberAuthor(author);
          this.run('insertMemo', () => {
            this.focused = this.source.insertMemo!(target, text, author);
          });
        }
      } else {
        const before = this.memos.find((m) => m.id === editing.id);
        const textChanged = before !== undefined && before.text !== text;
        const authorChanged = before !== undefined && (before.author ?? '') !== author
          && typeof this.source.setMemoAuthor === 'function';
        if (!text) this.run('deleteMemo', () => this.source.deleteMemo!(editing.id));
        else if (textChanged || authorChanged) {
          // 글과 작성자를 한 번에 — 되돌리기도 한 번
          this.run('updateMemo', () => {
            if (textChanged) this.source.updateMemo!(editing.id, text);
            if (authorChanged) this.source.setMemoAuthor!(editing.id, author);
          });
        }
      }
    } catch (error) {
      console.warn('[memo] 메모를 저장하지 못했습니다', error);
    }
    this.refreshFromEngine();
    this.applyVisibility();
    this.schedule(0);
    this.deps.getInputHandler()?.focus?.();
  }

  private deleteMemo(id: number): void {
    if (!this.canEdit) return;
    if (this.editing?.id === id) this.editing = null;
    try {
      this.run('deleteMemo', () => this.source.deleteMemo!(id));
    } catch (error) {
      console.warn('[memo] 메모를 지우지 못했습니다', error);
    }
    this.refreshFromEngine();
  }

  /** 에디터의 snapshot 연산으로 — 되돌리기 기록·다시 그리기·저장 표시가 같이 된다. */
  private run(operationType: string, apply: () => void): void {
    const ih = this.deps.getInputHandler();
    if (!ih) {
      apply();
      this.deps.eventBus.emit('document-changed');
      return;
    }
    let failure: unknown = null;
    ih.executeOperation({
      kind: 'snapshot',
      operationType,
      operation: () => {
        try {
          apply();
        } catch (error) {
          failure = error;
          return null; // 무변경 — 기록하지 않는다
        }
        return ih.getCursorPosition();
      },
    });
    if (failure) throw failure;
  }

  /** 새 메모 기본 작성자를 미리 정해 둔다: 마지막으로 쓴 이름 → OS 사용자 이름. */
  private async loadDefaultAuthor(): Promise<void> {
    const saved = readAuthorPreference();
    if (saved !== null) {
      this.author = saved;
      return;
    }
    this.author = (await this.source.memoAuthor?.().catch(() => '')) ?? '';
  }

  private rememberAuthor(author: string): void {
    if (author === this.author) return;
    this.author = author;
    writeAuthorPreference(author);
  }

  // ── 그리기 ──────────────────────────────────────────────

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

  /** 그릴 메모 — 초안이 있으면 그것까지. */
  private shownMemos(): DocumentMemo[] {
    const draft = this.editing?.id === DRAFT_ID ? this.editing.target : undefined;
    if (!draft) return this.memos;
    return [...this.memos, {
      id: DRAFT_ID,
      text: '',
      sectionIdx: draft.sectionIdx,
      paraIdx: draft.paraIdx,
      anchorText: '',
      location: locationOf(draft),
      startCharIdx: draft.start,
      endCharIdx: draft.end,
    }];
  }

  private draw(): void {
    // 에디터가 문서를 바꿀 때 스크롤 내용을 비우므로 층이 빠졌을 수 있다.
    if (!this.marks.isConnected) this.content.append(this.marks);
    this.marks.replaceChildren();
    this.columnInner.replaceChildren();
    this.syncScroll();
    this.newButton.hidden = !this.canEdit || this.deps.wasm.pageCount === 0;
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

    this.placements = layoutMemos(this.deps.wasm as unknown as MemoDocument, this.shownMemos());
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
    const balloons = shown.map((p) => this.balloon(p.memo));
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
    this.focusEditor();
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

  private balloon(memo: DocumentMemo): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'hop-memo-balloon';
    el.dataset.memo = String(memo.id);
    const editing = this.editing?.id === memo.id ? this.editing : null;

    const head = document.createElement('div');
    head.className = 'hop-memo-head';
    const meta = document.createElement('span');
    meta.className = 'hop-memo-meta';
    meta.textContent = memo.id === DRAFT_ID
      ? '새 메모'
      : [memo.author || `메모 ${memo.id}`, formatDate(memo.createdAt)].filter(Boolean).join(' · ');
    head.append(meta);
    if (this.canEdit && !editing) {
      head.append(
        iconButton('✎', '메모 고치기', () => this.startEdit(memo)),
        iconButton('×', '메모 지우기', () => this.deleteMemo(memo.id)),
      );
    }
    el.append(head);

    if (editing) {
      el.classList.add('is-editing');
      const who = document.createElement('input');
      who.className = 'hop-memo-author';
      who.type = 'text';
      who.value = editing.author;
      who.placeholder = '작성자';
      who.title = '작성자 — 새 메모는 마지막으로 쓴 이름이 기본값';
      who.addEventListener('input', () => {
        editing.author = who.value;
      });
      const area = document.createElement('textarea');
      area.className = 'hop-memo-input';
      area.value = editing.value;
      area.rows = Math.min(Math.max(editing.value.split('\n').length, 3), 12);
      area.placeholder = '메모 내용 — Ctrl+Enter 저장, Esc 취소';
      area.addEventListener('input', () => {
        editing.value = area.value;
      });
      const onKey = (event: KeyboardEvent) => {
        event.stopPropagation(); // 에디터 단축키로 새지 않게
        if (event.key === 'Escape') {
          event.preventDefault();
          this.cancelEdit();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void this.commitEdit();
        } else if (event.key === 'Enter' && event.target === who) {
          event.preventDefault();
          area.focus(); // 작성자 칸에서 Enter → 내용 칸으로
        }
      };
      area.addEventListener('keydown', onKey);
      who.addEventListener('keydown', onKey);
      who.addEventListener('focus', () => {
        editing.field = 'author';
      });
      area.addEventListener('focus', () => {
        editing.field = 'text';
      });
      const actions = document.createElement('div');
      actions.className = 'hop-memo-actions';
      actions.append(
        textButton('취소', () => this.cancelEdit()),
        textButton('저장', () => void this.commitEdit(), true),
      );
      el.append(who, area, actions);
    } else {
      const body = document.createElement('div');
      body.className = 'hop-memo-text';
      body.textContent = memo.text;
      el.append(body);
      el.addEventListener('click', () => this.toggleFocus(memo.id));
      el.addEventListener('dblclick', () => this.startEdit(memo));
    }
    return el;
  }

  /** 다시 그려도 입력 중인 칸의 포커스·커서를 지킨다. */
  private focusEditor(): void {
    if (!this.editing) return;
    const selector = this.editing.field === 'author' ? '.hop-memo-author' : '.hop-memo-input';
    const area = this.columnInner.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!area) return;
    const end = area.value.length;
    area.focus({ preventScroll: true });
    area.setSelectionRange(end, end);
    // 메모 칸은 overflow:hidden — 풍선이 보이도록 문서를 굴린다
    const top = area.closest<HTMLElement>('.hop-memo-balloon')?.offsetTop ?? 0;
    const view = this.container;
    if (top < view.scrollTop || top > view.scrollTop + view.clientHeight - 120) {
      view.scrollTop = Math.max(top - view.clientHeight / 3, 0);
    }
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

function statusButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hop-memo-toggle';
  button.textContent = text;
  button.title = title;
  button.hidden = true;
  button.addEventListener('click', onClick);
  return button;
}

function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hop-memo-icon';
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  button.addEventListener('dblclick', (event) => event.stopPropagation());
  return button;
}

function textButton(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'hop-memo-button is-primary' : 'hop-memo-button';
  button.textContent = text;
  // 누르는 순간 textarea 가 포커스를 잃어도 값은 editing 에 남아 있다
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
