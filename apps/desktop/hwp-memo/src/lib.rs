//! HWP/HWPX 메모(주석) — 읽기와 되살리기.
//!
//! rhwp(문서 엔진)는 메모를 그리지 않고, 본문 글을 꺼내 주는 API 도 없다. 게다가 **문서를
//! 한 글자라도 고치고 HWP 로 저장하면 메모 본문을 통째로 버린다** (v0.8.4·v0.8.7 실측).
//! 고친 구역을 모델에서 다시 쓰는데 모델에 메모 목록이 없기 때문이다. 본문 속 앵커
//! (`%unk` 필드 컨트롤)는 남고, 구역 끝의 메모 블록만 빠진다.
//!
//! 이 크레이트는 rhwp 를 고치지 않고 그 둘레에서 메운다.
//!
//! - [`extract_memos`] — 문서 바이트에서 메모 글·작성자·앵커 위치를 읽는다.
//! - [`restore_memos`] — 저장본에 원본 구역 끝의 메모 블록을 다시 붙인다.
//!
//! # HWP 5.0 의 메모 구조
//!
//! ```text
//! 구역 끝 :  HWPTAG_MEMO_LIST(93)  payload 4바이트 = 메모 id
//!            → LIST_HEADER(72) + PARA_HEADER/PARA_TEXT … 가 메모 내용 (레벨 1 이상)
//! 본문 안 :  CTRL_HEADER(71) ctrl id `%unk`
//!            → payload 에 UTF-16LE 로 `MEMO/65535/<메모id>/…/<작성자>/…`
//!            → 같은 문단 글자 속 k번째 확장 컨트롤(필드 시작)이 짝이다
//! ```

use std::io::{Cursor, Read, Write};

use serde::Serialize;

const TAG_PARA_HEADER: u16 = 66;
const TAG_PARA_TEXT: u16 = 67;
const TAG_CTRL_HEADER: u16 = 71;
const TAG_MEMO_LIST: u16 = 93;

/// 문단 글자 안 확장 컨트롤 — 8 WCHAR 를 차지하고 CTRL_HEADER 레코드와 짝을 이룬다.
const EXTENDED_CONTROL: &[u16] = &[1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23];
/// inline 컨트롤 — 8 WCHAR 를 차지하지만 CTRL_HEADER 는 없다.
const INLINE_CONTROL: &[u16] = &[4, 5, 6, 7, 8, 9, 19, 20];
const FIELD_END: u16 = 4;
const TAB: u16 = 9;

/// 메모 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: u32,
    pub text: String,
    pub author: Option<String>,
    pub section_idx: usize,
    /// 앵커가 놓인 **최상위** 문단 번호 (표 안이면 그 표를 품은 문단).
    pub para_idx: Option<usize>,
    /// 앵커 문단 안에서 필드 시작 앞의 글자 수. rhwp 와 같은 규칙으로 센다
    /// (강제 줄바꿈·탭·고정 공백은 한 글자, 필드 시작·끝은 0 글자).
    pub char_offset: Option<usize>,
    /// 필드 시작부터 필드 끝(또는 문단 끝)까지의 글자. 위치를 검색으로 찾을 때 쓴다.
    pub anchor_text: String,
}

// ---------------------------------------------------------------- 레코드

struct Record<'a> {
    tag: u16,
    level: u16,
    payload: &'a [u8],
    /// 헤더 포함 원본 바이트 — 되살릴 때 인코딩을 그대로 옮기려고.
    raw: &'a [u8],
}

fn split_records(buf: &[u8]) -> Vec<Record<'_>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= buf.len() {
        let start = i;
        let header = u32::from_le_bytes(buf[i..i + 4].try_into().unwrap());
        let tag = (header & 0x3ff) as u16;
        let level = ((header >> 10) & 0x3ff) as u16;
        let mut size = ((header >> 20) & 0xfff) as usize;
        i += 4;
        if size == 0xfff {
            if i + 4 > buf.len() {
                break;
            }
            size = u32::from_le_bytes(buf[i..i + 4].try_into().unwrap()) as usize;
            i += 4;
        }
        if i + size > buf.len() {
            break;
        }
        out.push(Record {
            tag,
            level,
            payload: &buf[i..i + size],
            raw: &buf[start..i + size],
        });
        i += size;
    }
    out
}

fn u16_at(buf: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([buf[i], buf[i + 1]])
}

fn ctrl_id(payload: &[u8]) -> Option<[u8; 4]> {
    if payload.len() < 4 {
        return None;
    }
    // ctrl id 는 거꾸로 저장된다 ("%unk" → "knu%")
    Some([payload[3], payload[2], payload[1], payload[0]])
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// `MEMO/65535/<id>/<n>/<n>/<작성자>/…` 에서 id·작성자를 꺼낸다.
fn parse_memo_command(text: &str) -> Option<(u32, Option<String>)> {
    let start = text.find("MEMO/")?;
    let parts: Vec<&str> = text[start..].split('/').collect();
    // parts: ["MEMO", "65535", id, n, n, 작성자, ...]
    let id: u32 = parts.get(2)?.trim().parse().ok()?;
    let author = parts
        .get(5)
        .map(|s| s.trim_matches(char::from(0)).trim())
        .filter(|s| !s.is_empty() && parts.len() > 6)
        .map(str::to_string);
    Some((id, author))
}

/// 필드 컨트롤 payload 에서 메모 명령을 읽는다.
///
/// 필드 컨트롤은 ctrl id(4) + 속성(4) + **1바이트** 뒤에 명령 문자열이 와서 UTF-16 경계가
/// 홀수로 밀린다. 통째로 UTF-16 으로 읽으면 깨지므로 짝·홀 정렬을 다 시도한다.
fn memo_from_anchor(payload: &[u8]) -> Option<(u32, Option<String>)> {
    for offset in [11usize, 10, 9, 8, 0, 1] {
        if offset >= payload.len() {
            continue;
        }
        let end = offset + (payload.len() - offset) / 2 * 2;
        if let Some(found) = parse_memo_command(&decode_utf16le(&payload[offset..end])) {
            return Some(found);
        }
    }
    None
}

/// 문단 글자를 사람이 읽는 글로 푼다 (메모 본문용).
fn para_text(payload: &[u8]) -> String {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 1 < payload.len() {
        let code = u16_at(payload, i);
        if code < 32 {
            if EXTENDED_CONTROL.contains(&code) || INLINE_CONTROL.contains(&code) {
                if code == TAB {
                    out.push(u16::from(b'\t'));
                }
                i += 16;
            } else {
                if code == 10 || code == 13 {
                    out.push(u16::from(b'\n'));
                }
                i += 2;
            }
            continue;
        }
        out.push(code);
        i += 2;
    }
    String::from_utf16_lossy(&out)
}

/// 문단 글자에서 k번째 확장 컨트롤(= 메모 필드 시작)을 찾아 위치와 걸린 글자를 준다.
fn locate_in_paragraph(payload: &[u8], k: usize) -> Option<(usize, String)> {
    let mut i = 0usize;
    let mut visible = 0usize;
    let mut seen = 0usize;
    let mut start: Option<usize> = None;
    let mut after: Vec<u16> = Vec::new();
    while i + 1 < payload.len() {
        let code = u16_at(payload, i);
        if code < 32 {
            if EXTENDED_CONTROL.contains(&code) {
                if start.is_none() && seen == k {
                    start = Some(visible);
                }
                seen += 1;
                i += 16;
            } else if INLINE_CONTROL.contains(&code) {
                if start.is_some() && code == FIELD_END {
                    break;
                }
                // 탭은 rhwp 글자 모델에서 한 글자다.
                if code == TAB {
                    visible += 1;
                    if start.is_some() {
                        after.push(u16::from(b'\t'));
                    }
                }
                i += 16;
            } else {
                if code == 13 {
                    break; // 문단 끝
                }
                // 강제 줄바꿈(10)·하이픈·고정 공백(24~31)은 rhwp 가 한 글자로 센다.
                if code == 10 || code >= 24 {
                    visible += 1;
                    if start.is_some() {
                        after.push(u16::from(b' '));
                    }
                }
                i += 2;
            }
            continue;
        }
        if start.is_some() {
            after.push(code);
        }
        visible += 1;
        i += 2;
    }
    let start = start?;
    let text: String = String::from_utf16_lossy(&after).chars().take(60).collect();
    Some((start, text))
}

// ---------------------------------------------------------------- CFB

struct HeaderFlags {
    compressed: bool,
    encrypted: bool,
    distribution: bool,
}

fn read_stream<F: Read + std::io::Seek>(
    comp: &mut cfb::CompoundFile<F>,
    path: &str,
) -> Option<Vec<u8>> {
    let mut stream = comp.open_stream(path).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// FileHeader 속성 비트 (서명 32 + 버전 4 뒤 offset 36): bit0 압축 · bit1 암호 · bit2 배포용
fn header_flags<F: Read + std::io::Seek>(comp: &mut cfb::CompoundFile<F>) -> Option<HeaderFlags> {
    let header = read_stream(comp, "/FileHeader")?;
    if header.len() < 40 {
        return None;
    }
    let flags = u32::from_le_bytes(header[36..40].try_into().ok()?);
    Some(HeaderFlags {
        compressed: flags & 1 != 0,
        encrypted: flags & 2 != 0,
        distribution: flags & 4 != 0,
    })
}

fn section_paths<F: Read + std::io::Seek>(comp: &cfb::CompoundFile<F>) -> Vec<(usize, String)> {
    let mut out: Vec<(usize, String)> = match comp.read_storage("/BodyText") {
        Ok(entries) => entries
            .filter_map(|e| {
                let name = e.name();
                let index = name.strip_prefix("Section")?.parse::<usize>().ok()?;
                Some((index, format!("/BodyText/{}", name)))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort();
    out
}

fn inflate(data: &[u8], compressed: bool) -> Option<Vec<u8>> {
    if !compressed {
        return Some(data.to_vec());
    }
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

fn deflate(data: &[u8], compressed: bool) -> Option<Vec<u8>> {
    if !compressed {
        return Some(data.to_vec());
    }
    let mut encoder =
        flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

fn is_unk(r: &Record<'_>) -> bool {
    r.tag == TAG_CTRL_HEADER && ctrl_id(r.payload).map(|id| &id == b"%unk").unwrap_or(false)
}

// ---------------------------------------------------------------- 읽기

fn extract_from_hwp(bytes: &[u8]) -> Option<Vec<Memo>> {
    let mut comp = cfb::CompoundFile::open(Cursor::new(bytes)).ok()?;
    let flags = header_flags(&mut comp)?;
    // 암호·배포용 문서는 본문이 암호화돼 있다. 레코드로 읽으면 쓰레기 바이트에서 가짜 메모가
    // 튀어나올 수 있으므로 '못 읽음' 으로 답한다.
    if flags.encrypted || flags.distribution {
        return None;
    }

    struct Body {
        id: u32,
        section_idx: usize,
        parts: Vec<String>,
    }
    struct Anchor {
        section_idx: usize,
        para_idx: usize,
        author: Option<String>,
        located: Option<(usize, String)>,
    }

    let mut bodies: Vec<Body> = Vec::new();
    let mut anchors: Vec<(u32, Anchor)> = Vec::new();

    for (section_idx, path) in section_paths(&comp) {
        let raw = read_stream(&mut comp, &path)?;
        let buf = inflate(&raw, flags.compressed)?;
        let records = split_records(&buf);

        let mut para_idx: isize = -1;
        let mut in_memo_block = false;
        // 레벨별 '지금 문단' 상태. PARA_HEADER(L) 의 자식(PARA_TEXT·CTRL_HEADER)은 L+1 이다.
        let mut para_text_at: Vec<Option<&[u8]>> = vec![None; 64];
        let mut ctrl_count_at: Vec<usize> = vec![0; 64];

        for r in &records {
            let level = r.level as usize;
            if level + 1 >= para_text_at.len() {
                continue;
            }
            match r.tag {
                TAG_PARA_HEADER => {
                    if r.level == 0 {
                        para_idx += 1;
                    }
                    para_text_at[level + 1] = None;
                    ctrl_count_at[level + 1] = 0;
                }
                TAG_PARA_TEXT if !in_memo_block => para_text_at[level] = Some(r.payload),
                TAG_PARA_TEXT => {
                    if let Some(body) = bodies.last_mut() {
                        body.parts.push(para_text(r.payload));
                    }
                }
                TAG_CTRL_HEADER => {
                    let k = ctrl_count_at[level];
                    ctrl_count_at[level] += 1;
                    if is_unk(r) {
                        if let Some((id, author)) = memo_from_anchor(r.payload) {
                            if !anchors.iter().any(|(existing, _)| *existing == id) {
                                let located = para_text_at[level]
                                    .and_then(|text| locate_in_paragraph(text, k));
                                anchors.push((
                                    id,
                                    Anchor {
                                        section_idx,
                                        para_idx: para_idx.max(0) as usize,
                                        author,
                                        located,
                                    },
                                ));
                            }
                        }
                    }
                }
                TAG_MEMO_LIST => {
                    in_memo_block = true;
                    let id = if r.payload.len() >= 4 {
                        u32::from_le_bytes(r.payload[0..4].try_into().unwrap())
                    } else {
                        bodies.len() as u32 + 1
                    };
                    bodies.push(Body {
                        id,
                        section_idx,
                        parts: Vec::new(),
                    });
                }
                _ => {}
            }
        }
    }

    let memos = bodies
        .into_iter()
        .filter_map(|body| {
            let text = tidy(&body.parts.join("\n"));
            if text.is_empty() {
                return None;
            }
            let anchor = anchors
                .iter()
                .find(|(id, _)| *id == body.id)
                .map(|(_, a)| a);
            Some(Memo {
                id: body.id,
                text,
                author: anchor.and_then(|a| a.author.clone()),
                section_idx: anchor.map(|a| a.section_idx).unwrap_or(body.section_idx),
                para_idx: anchor.map(|a| a.para_idx),
                char_offset: anchor.and_then(|a| a.located.as_ref().map(|(offset, _)| *offset)),
                anchor_text: anchor
                    .and_then(|a| a.located.as_ref().map(|(_, t)| t.clone()))
                    .unwrap_or_default(),
            })
        })
        .collect();
    Some(memos)
}

fn tidy(text: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out.trim().to_string()
}

fn decode_xml(s: &str) -> String {
    let mut out = s
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'");
    // 숫자 문자 참조
    while let Some(start) = out.find("&#") {
        let Some(end) = out[start..].find(';') else {
            break;
        };
        let code = &out[start + 2..start + end];
        let ch = if let Some(hex) = code.strip_prefix('x') {
            u32::from_str_radix(hex, 16).ok()
        } else {
            code.parse::<u32>().ok()
        }
        .and_then(char::from_u32);
        match ch {
            Some(c) => out.replace_range(start..start + end + 1, &c.to_string()),
            None => break,
        }
    }
    out.replace("&amp;", "&")
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {}=\"", name);
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')?;
    Some(&tag[start..start + end])
}

/// HWPX: `<hp:memo id=…>` 본문과 `<hp:fieldBegin type="MEMO" …>` 앵커를 잇는다.
fn extract_from_hwpx(bytes: &[u8]) -> Option<Vec<Memo>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let mut names: Vec<(usize, String)> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            let index = name
                .strip_prefix("Contents/section")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((index, name))
        })
        .collect();
    names.sort();

    let mut memos = Vec::new();
    for (section_idx, name) in names {
        let mut xml = String::new();
        archive.by_name(&name).ok()?.read_to_string(&mut xml).ok()?;

        // 최상위 문단 번호 — <hp:p> 의 깊이가 1 인 것만 센다 (표 안 문단은 빼고).
        let mut anchors: Vec<(u32, usize, Option<String>)> = Vec::new();
        let mut depth = 0usize;
        let mut top_para: isize = -1;
        let mut cursor = 0usize;
        while let Some(rel) = xml[cursor..].find('<') {
            let at = cursor + rel;
            let rest = &xml[at..];
            let close = rest.find('>').map(|e| at + e + 1).unwrap_or(xml.len());
            let tag = &xml[at..close];
            if tag.starts_with("<hp:p ") || tag.starts_with("<hp:p>") {
                if !tag.ends_with("/>") {
                    depth += 1;
                }
                if depth == 1 || tag.ends_with("/>") && depth == 0 {
                    top_para += 1;
                }
            } else if tag.starts_with("</hp:p>") {
                depth = depth.saturating_sub(1);
            } else if tag.starts_with("<hp:fieldBegin") && attr(tag, "type") == Some("MEMO") {
                // 명령은 속성이 아니라 안쪽 <hp:parameters> 의 Command 에 들어 있는 경우가 많다
                // (한글 2024 저장본). 요소가 닫힐 때까지 통째로 본다.
                let body_end = if tag.ends_with("/>") {
                    close
                } else {
                    xml[close..]
                        .find("</hp:fieldBegin>")
                        .map(|e| close + e)
                        .unwrap_or(close)
                };
                let decoded = decode_xml(&xml[at..body_end]);
                if let Some((id, author)) = parse_memo_command(&decoded) {
                    anchors.push((id, top_para.max(0) as usize, author));
                }
            }
            cursor = close;
        }

        let mut search = 0usize;
        while let Some(rel) = xml[search..].find("<hp:memo ") {
            let start = search + rel;
            let Some(end_rel) = xml[start..].find("</hp:memo>") else {
                break;
            };
            let block = &xml[start..start + end_rel];
            let open_end = block.find('>').unwrap_or(0);
            let id: u32 = attr(&block[..open_end + 1], "id")
                .and_then(|v| v.parse().ok())
                .unwrap_or(memos.len() as u32 + 1);
            let mut parts = Vec::new();
            let mut t = 0usize;
            while let Some(r) = block[t..].find("<hp:t") {
                let s = t + r;
                let Some(gt) = block[s..].find('>') else {
                    break;
                };
                let body_start = s + gt + 1;
                if block[s..body_start].ends_with("/>") {
                    t = body_start;
                    continue;
                }
                let Some(e) = block[body_start..].find("</hp:t>") else {
                    break;
                };
                parts.push(decode_xml(&block[body_start..body_start + e]));
                t = body_start + e;
            }
            let text = tidy(&parts.join("\n"));
            if !text.is_empty() {
                let anchor = anchors.iter().find(|(a, _, _)| *a == id);
                memos.push(Memo {
                    id,
                    text,
                    author: anchor.and_then(|(_, _, a)| a.clone()),
                    section_idx,
                    para_idx: anchor.map(|(_, p, _)| *p),
                    char_offset: None,
                    anchor_text: String::new(),
                });
            }
            search = start + end_rel + "</hp:memo>".len();
        }
    }
    Some(memos)
}

/// 문서 바이트에서 메모를 읽는다.
///
/// `None` 은 **읽지 못했다**는 뜻이다 (암호·배포용 문서, 깨진 파일). 빈 목록(= 메모 없음)과
/// 구분해야 화면에서 "메모 없음" 과 "모르겠음" 을 다르게 알릴 수 있다.
pub fn extract_memos(bytes: &[u8], is_hwpx: bool) -> Option<Vec<Memo>> {
    if is_hwpx {
        extract_from_hwpx(bytes)
    } else {
        extract_from_hwp(bytes)
    }
}

// ---------------------------------------------------------------- 되살리기

/// [`restore_memos`] 결과.
#[derive(Debug)]
pub struct Restore {
    pub bytes: Vec<u8>,
    /// 되살린 메모 수.
    pub restored: usize,
    /// 손대지 않은 이유 (손댔거나, 손댈 필요가 없었으면 `None`).
    pub skipped: Option<String>,
}

fn unchanged(exported: &[u8], why: Option<&str>) -> Restore {
    Restore {
        bytes: exported.to_vec(),
        restored: 0,
        skipped: why.map(str::to_string),
    }
}

struct Block {
    id: Option<u32>,
    raw: Vec<u8>,
}

/// 구역 레코드에서 메모 블록들을 떼어 낸다. 구조가 예상과 다르면 `None`.
fn memo_blocks(records: &[Record<'_>]) -> Option<Vec<Block>> {
    let Some(first) = records.iter().position(|r| r.tag == TAG_MEMO_LIST) else {
        return Some(Vec::new());
    };
    let tail = &records[first..];
    // 메모 블록 뒤에 최상위 문단이 또 나오면 우리가 아는 구조가 아니다.
    if tail.iter().any(|r| r.level == 0) {
        return None;
    }
    let mut blocks: Vec<Block> = Vec::new();
    for r in tail {
        if r.tag == TAG_MEMO_LIST {
            let id = (r.payload.len() >= 4)
                .then(|| u32::from_le_bytes(r.payload[0..4].try_into().unwrap()));
            blocks.push(Block {
                id,
                raw: Vec::new(),
            });
        }
        if let Some(block) = blocks.last_mut() {
            block.raw.extend_from_slice(r.raw);
        }
    }
    Some(blocks)
}

/// 엔진이 저장 때 버린 메모 본문을 원본에서 되살린다.
///
/// - 저장본에 앵커가 남은 메모만 붙인다 (편집하다 지운 메모는 되살리지 않는다).
/// - 저장본에 이미 메모 본문이 있으면 그 구역은 손대지 않는다 (엔진이 보존한 경우).
/// - 암호·배포용이거나 구조가 예상과 다르면 저장본을 그대로 돌려준다.
pub fn restore_memos(original: &[u8], exported: &[u8]) -> Restore {
    let Ok(mut src) = cfb::CompoundFile::open(Cursor::new(original)) else {
        return unchanged(exported, Some("원본이 HWP 5.0 이 아님"));
    };
    let Ok(mut dst) = cfb::CompoundFile::open(Cursor::new(exported.to_vec())) else {
        return unchanged(exported, Some("저장본이 HWP 5.0 이 아님"));
    };
    let (Some(sf), Some(df)) = (header_flags(&mut src), header_flags(&mut dst)) else {
        return unchanged(exported, Some("FileHeader 없음"));
    };
    if sf.encrypted || sf.distribution || df.encrypted || df.distribution {
        return unchanged(exported, Some("암호·배포용 문서"));
    }

    let dst_sections: Vec<(usize, String)> = section_paths(&dst);
    let mut restored = 0usize;
    let mut rewrites: Vec<(String, Vec<u8>)> = Vec::new();

    for (index, path) in section_paths(&src) {
        let Some((_, dst_path)) = dst_sections.iter().find(|(i, _)| *i == index) else {
            continue;
        };
        let Some(src_buf) =
            read_stream(&mut src, &path).and_then(|raw| inflate(&raw, sf.compressed))
        else {
            return unchanged(exported, Some("원본 구역을 풀 수 없음"));
        };
        let src_records = split_records(&src_buf);
        let Some(blocks) = memo_blocks(&src_records) else {
            return unchanged(
                exported,
                Some(&format!("구역 {} 구조가 예상과 다름", index)),
            );
        };
        if blocks.is_empty() {
            continue;
        }

        let Some(dst_buf) =
            read_stream(&mut dst, dst_path).and_then(|raw| inflate(&raw, df.compressed))
        else {
            return unchanged(exported, Some("저장본 구역을 풀 수 없음"));
        };
        let dst_records = split_records(&dst_buf);
        if dst_records.iter().any(|r| r.tag == TAG_MEMO_LIST) {
            continue; // 엔진이 이미 보존했다
        }
        let alive: Vec<u32> = dst_records
            .iter()
            .filter(|r| is_unk(r))
            .filter_map(|r| memo_from_anchor(r.payload).map(|(id, _)| id))
            .collect();
        let wanted: Vec<&Block> = blocks
            .iter()
            .filter(|b| b.id.map(|id| alive.contains(&id)).unwrap_or(false))
            .collect();
        if wanted.is_empty() {
            continue;
        }

        let mut next = dst_buf.clone();
        for block in &wanted {
            next.extend_from_slice(&block.raw);
        }
        let Some(packed) = deflate(&next, df.compressed) else {
            return unchanged(exported, Some("다시 압축할 수 없음"));
        };
        rewrites.push((dst_path.clone(), packed));
        restored += wanted.len();
    }

    if restored == 0 {
        return unchanged(exported, None);
    }
    for (path, packed) in rewrites {
        let Ok(mut stream) = dst.open_stream(&path) else {
            return unchanged(exported, Some("저장본 구역을 쓸 수 없음"));
        };
        if stream.set_len(0).is_err() || stream.write_all(&packed).is_err() {
            return unchanged(exported, Some("저장본 구역을 쓸 수 없음"));
        }
    }
    if dst.flush().is_err() {
        return unchanged(exported, Some("저장본을 마무리할 수 없음"));
    }
    Restore {
        bytes: dst.into_inner().into_inner(),
        restored,
        skipped: None,
    }
}

#[cfg(test)]
mod tests;
