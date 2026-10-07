//! 메모 읽기·되살리기 테스트.
//!
//! 공개 저장소에 실제 문서를 넣을 수 없어서(검토 의견이 담긴 실문서) 메모 레코드를 직접
//! 조립한 HWP 로 검증한다. 실문서 검증은 `#[ignore]` 테스트로, 경로를 환경변수로 준다.

use super::*;

// ---------------------------------------------------------------- 조립 도구

fn rec(tag: u16, level: u16, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let size = payload.len();
    let head = |s: u32| (tag as u32) | ((level as u32) << 10) | (s << 20);
    if size < 0xfff {
        out.extend_from_slice(&head(size as u32).to_le_bytes());
    } else {
        out.extend_from_slice(&head(0xfff).to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
    }
    out.extend_from_slice(payload);
    out
}

enum Piece<'a> {
    Text(&'a str),
    FieldBegin,
    FieldEnd,
    LineBreak,
}

fn para_text_bytes(pieces: &[Piece<'_>]) -> Vec<u8> {
    let mut units: Vec<u16> = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Text(t) => units.extend(t.encode_utf16()),
            Piece::FieldBegin => units.extend([3, 0, 0, 0, 0, 0, 0, 3]),
            Piece::FieldEnd => units.extend([4, 0, 0, 0, 0, 0, 0, 4]),
            Piece::LineBreak => units.push(10),
        }
    }
    units.push(13);
    units.iter().flat_map(|u| u.to_le_bytes()).collect()
}

/// `%unk` 필드 컨트롤 — ctrl id(4) + 속성(4) + 1바이트 + 길이(2) + UTF-16 명령
fn memo_anchor(id: u32, author: &str) -> Vec<u8> {
    let command = format!("MEMO/65535/{}/0/0/{}/\\;;", id, author);
    let mut payload = b"knu%".to_vec();
    payload.extend_from_slice(&0u32.to_le_bytes());
    payload.push(0);
    payload.extend_from_slice(&(command.encode_utf16().count() as u16).to_le_bytes());
    payload.extend(command.encode_utf16().flat_map(|u| u.to_le_bytes()));
    payload
}

fn memo_block(id: u32, text: &str) -> Vec<u8> {
    let mut out = rec(TAG_MEMO_LIST, 1, &id.to_le_bytes());
    out.extend(rec(72, 1, &[0u8; 16]));
    out.extend(rec(TAG_PARA_HEADER, 1, &[0u8; 24]));
    out.extend(rec(
        TAG_PARA_TEXT,
        2,
        &para_text_bytes(&[Piece::Text(text)]),
    ));
    out
}

struct Para<'a> {
    pieces: Vec<Piece<'a>>,
    anchors: Vec<(u32, &'a str)>,
}

fn section(paras: &[Para<'_>], memos: &[(u32, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in paras {
        out.extend(rec(TAG_PARA_HEADER, 0, &[0u8; 24]));
        out.extend(rec(TAG_PARA_TEXT, 1, &para_text_bytes(&p.pieces)));
        for (id, author) in &p.anchors {
            out.extend(rec(TAG_CTRL_HEADER, 1, &memo_anchor(*id, author)));
        }
    }
    for (id, text) in memos {
        out.extend(memo_block(*id, text));
    }
    out
}

fn hwp(sections: &[Vec<u8>], flags: u32) -> Vec<u8> {
    let mut comp = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    let mut header = vec![0u8; 256];
    header[..17].copy_from_slice(b"HWP Document File");
    header[32..36].copy_from_slice(&0x0500_0300u32.to_le_bytes());
    header[36..40].copy_from_slice(&flags.to_le_bytes());
    comp.create_stream("/FileHeader")
        .unwrap()
        .write_all(&header)
        .unwrap();
    comp.create_storage("/BodyText").unwrap();
    for (i, s) in sections.iter().enumerate() {
        let packed = deflate(s, flags & 1 != 0).unwrap();
        comp.create_stream(format!("/BodyText/Section{}", i))
            .unwrap()
            .write_all(&packed)
            .unwrap();
    }
    comp.flush().unwrap();
    comp.into_inner().into_inner()
}

const COMPRESSED: u32 = 1;

fn sample_paras() -> Vec<Para<'static>> {
    vec![
        Para {
            pieces: vec![
                Piece::Text("앞글 "),
                Piece::FieldBegin,
                Piece::Text("앵커"),
                Piece::FieldEnd,
                Piece::Text(" 뒤"),
            ],
            anchors: vec![(1, "테스터")],
        },
        Para {
            pieces: vec![
                Piece::Text("가"),
                Piece::LineBreak,
                Piece::Text("나"),
                Piece::FieldBegin,
                Piece::Text("둘째"),
                Piece::FieldEnd,
            ],
            anchors: vec![(2, "검토자")],
        },
        Para {
            pieces: vec![Piece::Text("마지막 문단")],
            anchors: vec![],
        },
    ]
}

fn original() -> Vec<u8> {
    hwp(
        &[section(
            &sample_paras(),
            &[(1, "첫 메모"), (2, "둘째 메모\n두 줄")],
        )],
        COMPRESSED,
    )
}

/// 엔진이 편집 후 저장한 모습 — 앵커는 남고 메모 블록만 빠졌다.
fn exported_without_memos() -> Vec<u8> {
    hwp(&[section(&sample_paras(), &[])], COMPRESSED)
}

// ---------------------------------------------------------------- 읽기

#[test]
fn reads_memo_text_author_and_anchor() {
    let memos = extract_memos(&original(), false).unwrap();
    assert_eq!(memos.len(), 2);
    let first = &memos[0];
    assert_eq!(first.id, 1);
    assert_eq!(first.text, "첫 메모");
    assert_eq!(first.author.as_deref(), Some("테스터"));
    assert_eq!(first.para_idx, Some(0));
    assert_eq!(first.char_offset, Some(3)); // "앞글 "
    assert_eq!(first.anchor_text, "앵커");
}

#[test]
fn line_break_counts_as_one_character_like_rhwp() {
    let memos = extract_memos(&original(), false).unwrap();
    let second = memos.iter().find(|m| m.id == 2).unwrap();
    // "가" + 줄바꿈 + "나" = 3 글자 (줄바꿈을 빼면 rhwp 의 getFieldList 와 1 어긋난다)
    assert_eq!(second.char_offset, Some(3));
    assert_eq!(second.para_idx, Some(1));
    assert_eq!(second.text, "둘째 메모\n두 줄");
}

#[test]
fn no_memos_is_empty_not_unreadable() {
    let plain = hwp(
        &[section(
            &[Para {
                pieces: vec![Piece::Text("글")],
                anchors: vec![],
            }],
            &[],
        )],
        COMPRESSED,
    );
    assert_eq!(extract_memos(&plain, false), Some(vec![]));
}

#[test]
fn encrypted_or_distribution_documents_are_unreadable() {
    let s = section(&sample_paras(), &[(1, "첫 메모")]);
    assert_eq!(
        extract_memos(&hwp(std::slice::from_ref(&s), COMPRESSED | 2), false),
        None
    );
    assert_eq!(extract_memos(&hwp(&[s], COMPRESSED | 4), false), None);
}

#[test]
fn garbage_is_unreadable() {
    assert_eq!(extract_memos(b"not a hwp", false), None);
}

#[test]
fn reads_uncompressed_sections() {
    let doc = hwp(&[section(&sample_paras(), &[(1, "첫 메모")])], 0);
    assert_eq!(extract_memos(&doc, false).unwrap().len(), 1);
}

#[test]
fn parses_memo_command_author() {
    assert_eq!(
        parse_memo_command("MEMO/65535/18/100000001/200000002/검토자/\\;;"),
        Some((18, Some("검토자".into())))
    );
    assert_eq!(parse_memo_command("MEMO/65535/3/"), Some((3, None)));
    assert_eq!(parse_memo_command("CLICKHERE/1/"), None);
}

// ---------------------------------------------------------------- 되살리기

#[test]
fn restores_memo_bodies_dropped_by_engine() {
    let result = restore_memos(&original(), &exported_without_memos());
    assert_eq!(result.restored, 2);
    assert_eq!(result.skipped, None);
    let memos = extract_memos(&result.bytes, false).unwrap();
    assert_eq!(
        memos
            .iter()
            .map(|m| (m.id, m.text.as_str()))
            .collect::<Vec<_>>(),
        vec![(1, "첫 메모"), (2, "둘째 메모\n두 줄")]
    );
}

#[test]
fn leaves_file_untouched_when_engine_kept_memos() {
    let exported = original();
    let result = restore_memos(&original(), &exported);
    assert_eq!(result.restored, 0);
    assert_eq!(result.bytes, exported);
}

#[test]
fn does_not_resurrect_memos_whose_anchor_was_deleted() {
    // 둘째 문단(메모 2 앵커)을 지운 편집본
    let mut paras = sample_paras();
    paras.remove(1);
    let exported = hwp(&[section(&paras, &[])], COMPRESSED);
    let result = restore_memos(&original(), &exported);
    assert_eq!(result.restored, 1);
    let ids: Vec<u32> = extract_memos(&result.bytes, false)
        .unwrap()
        .iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, vec![1]);
}

#[test]
fn restoring_twice_is_stable() {
    let once = restore_memos(&original(), &exported_without_memos()).bytes;
    // 되살린 파일을 원본 삼아 다시 편집·저장한 경우
    let again = restore_memos(&once, &exported_without_memos());
    assert_eq!(again.restored, 2);
    assert_eq!(extract_memos(&again.bytes, false).unwrap().len(), 2);
}

#[test]
fn skips_encrypted_documents() {
    let s = section(&sample_paras(), &[(1, "첫 메모")]);
    let enc = hwp(&[s], COMPRESSED | 2);
    let result = restore_memos(&enc, &exported_without_memos());
    assert_eq!(result.restored, 0);
    assert!(result.skipped.is_some());
}

#[test]
fn skips_unexpected_structure() {
    // 메모 블록 뒤에 최상위 문단이 또 있는 구역 — 모르는 구조면 손대지 않는다
    let mut s = section(&sample_paras(), &[(1, "첫 메모")]);
    s.extend(rec(TAG_PARA_HEADER, 0, &[0u8; 24]));
    let result = restore_memos(&hwp(&[s], COMPRESSED), &exported_without_memos());
    assert_eq!(result.restored, 0);
    assert!(result.skipped.unwrap().contains("구조"));
}

#[test]
fn keeps_other_streams_intact() {
    let mut comp = cfb::CompoundFile::open(Cursor::new(exported_without_memos())).unwrap();
    comp.create_stream("/DocInfo")
        .unwrap()
        .write_all(b"docinfo-bytes")
        .unwrap();
    comp.flush().unwrap();
    let exported = comp.into_inner().into_inner();
    let result = restore_memos(&original(), &exported);
    let mut out = cfb::CompoundFile::open(Cursor::new(result.bytes)).unwrap();
    assert_eq!(read_stream(&mut out, "/DocInfo").unwrap(), b"docinfo-bytes");
}

// ---------------------------------------------------------------- HWPX

#[test]
fn reads_hwpx_memos() {
    let xml = r#"<hs:sec><hp:p id="0"><hp:run><hp:ctrl><hp:fieldBegin type="MEMO" command="MEMO/65535/7/0/0/작성자/"/></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p><hp:p id="1"><hp:run><hp:tbl><hp:tc><hp:subList><hp:p id="9"><hp:run><hp:t>셀</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tbl></hp:run></hp:p><hp:memo id="7"><hp:subList><hp:p><hp:run><hp:t>HWPX 메모 &amp; 확인</hp:t></hp:run></hp:p></hp:subList></hp:memo></hs:sec>"#;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file(
            "Contents/section0.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    let memos = extract_memos(&buf.into_inner(), true).unwrap();
    assert_eq!(memos.len(), 1);
    assert_eq!(memos[0].id, 7);
    assert_eq!(memos[0].text, "HWPX 메모 & 확인");
    assert_eq!(memos[0].author.as_deref(), Some("작성자"));
    assert_eq!(memos[0].para_idx, Some(0));
}

#[test]
fn reads_hwpx_memo_command_from_parameters_child() {
    // 한글 2024 SaveAs HWPX 모양 (rhwp #6005 에 기록된 실측 형상)
    let xml = r#"<hs:sec><hp:p id="0"><hp:run><hp:ctrl><hp:fieldBegin id="1" type="MEMO" name=""><hp:parameters cnt="3"><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">MEMO/65535/3/1/1/홍길동/\;;</hp:stringParam><hp:stringParam name="Author">홍길동</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>대상</hp:t></hp:run></hp:p><hp:memo id="3"><hp:subList><hp:p><hp:run><hp:t>매개변수 안 명령</hp:t></hp:run></hp:p></hp:subList></hp:memo></hs:sec>"#;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file(
            "Contents/section0.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    let memos = extract_memos(&buf.into_inner(), true).unwrap();
    assert_eq!(memos.len(), 1);
    assert_eq!(memos[0].author.as_deref(), Some("홍길동"));
    assert_eq!(memos[0].para_idx, Some(0));
}

// ---------------------------------------------------------------- 실문서 (로컬 전용)
//
//   HWP_MEMO_SAMPLE=<메모 있는 원본.hwp> HWP_MEMO_EDITED=<엔진이 편집 후 저장한.hwp> \
//     cargo test -p hop-hwp-memo -- --ignored

#[test]
#[ignore]
fn real_document_round_trip() {
    let Ok(sample) = std::env::var("HWP_MEMO_SAMPLE") else {
        return;
    };
    let original = std::fs::read(sample).unwrap();
    let memos = extract_memos(&original, false).unwrap();
    let expected: usize = std::env::var("HWP_MEMO_EXPECTED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(memos.len());
    assert_eq!(memos.len(), expected);
    assert!(
        memos.iter().all(|m| m.para_idx.is_some()),
        "모든 메모에 앵커가 있어야 한다"
    );
    eprintln!(
        "메모 {}개: {}",
        memos.len(),
        serde_json::to_string(&memos[0]).unwrap()
    );

    if let Ok(edited) = std::env::var("HWP_MEMO_EDITED") {
        let edited = std::fs::read(edited).unwrap();
        assert_eq!(
            extract_memos(&edited, false).unwrap().len(),
            0,
            "편집본은 메모가 빠져 있어야 한다"
        );
        let result = restore_memos(&original, &edited);
        assert_eq!(result.restored, expected);
        let back = extract_memos(&result.bytes, false).unwrap();
        let texts = |m: &[Memo]| {
            let mut v: Vec<_> = m.iter().map(|x| (x.id, x.text.clone())).collect();
            v.sort();
            v
        };
        assert_eq!(
            texts(&back),
            texts(&memos),
            "되살린 메모 글이 원본과 같아야 한다"
        );
        if let Ok(out) = std::env::var("HWP_MEMO_OUT") {
            std::fs::write(out, &result.bytes).unwrap();
        }
    }
}
