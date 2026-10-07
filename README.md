# HOP

**HOP is Open HWP**

> **이 저장소는 [golbin/hop](https://github.com/golbin/hop) 의 포크입니다 — 메모(주석) 지원을 더했습니다.**
>
> - **메모가 한글처럼 보입니다.** 오른쪽 메모 칸에 풍선, 걸린 글자에 형광, 둘을 점선으로 잇습니다.
>   `View › Show/Hide Memos` 로 켜고 끕니다. (rhwp-studio 는 메모를 그리지 않습니다)
> - **편집 후 저장해도 메모가 남습니다.** rhwp(v0.8.4·v0.8.7 실측)는 문서를 한 글자라도 고치고
>   HWP 로 저장하면 메모 본문을 통째로 버립니다. 저장 직전에 원본에서 되살립니다.
> - 자동 업데이트는 이 포크의 릴리스만, 이 포크의 서명 키로만 받습니다 (원본으로 덮어쓰이지 않게).
>
> 구현: `apps/desktop/hwp-memo` (Rust — 메모 읽기·되살리기), `apps/studio-host/src/memo` (메모 칸),
> 저장 경로 `state.rs::restore_memos_from_source`. rhwp 서브모듈은 고치지 않았습니다.

HOP는 HWP/HWPX 문서를 보고 편집할 수 있는 오픈소스 macOS, Windows, Linux용 데스크탑 앱입니다.

문서 파싱과 렌더링의 기반은 [rhwp](https://github.com/edwardkim/rhwp)를 사용합니다. HOP는 그 위에 얇게 껍데기를 씌운 앱입니다. rhwp가 제공하는 기능을 바탕으로 파일 열기, 저장, PDF 내보내기, 인쇄, 파일 연결 같은 OS 통합 기능을 제공합니다.

![HOP editor](assets/screenshots/hop-editor.webp)

## 할 수 있는 일

현재 HOP는 다음 흐름을 지원합니다.

* HWP/HWPX 문서 열기
* HWP 문서 저장, 다른 이름으로 저장
* PDF로 내보내기
* 인쇄 다이얼로그 열기
* 파일 드래그 앤 드롭으로 열기
* `.hwp`, `.hwpx` 파일 연결
* 여러 창에서 문서 열기

## 다운로드

최신 릴리즈는 아래 링크에서 받을 수 있습니다.

* [macOS Apple Silicon (.dmg)](https://github.com/golbin/hop/releases/latest/download/HOP-macos-arm64.dmg)
* [macOS Intel (.dmg)](https://github.com/golbin/hop/releases/latest/download/HOP-macos-x64.dmg)
* [Windows x64 (.msi)](https://github.com/golbin/hop/releases/latest/download/HOP-windows-x64.msi)
* [Linux x64 (.deb, Ubuntu/Debian 계열 권장)](https://github.com/golbin/hop/releases/latest/download/HOP-linux-x64.deb)
* [Linux x64 (.rpm, Fedora/openSUSE 계열)](https://github.com/golbin/hop/releases/latest/download/HOP-linux-x64.rpm)
* [Linux x64 (AppImage, portable)](https://github.com/golbin/hop/releases/latest/download/HOP-linux-x64.AppImage)
* [Linux arm64 (.deb, Ubuntu/Debian 계열)](https://github.com/golbin/hop/releases/latest/download/HOP-linux-arm64.deb)
* [Arch Linux AUR (`hop-openhwp-bin`)](https://aur.archlinux.org/packages/hop-openhwp-bin)

macOS 빌드는 signed/notarized `.dmg`입니다. Homebrew를 통해서 설치할 수도 있습니다. Homebrew 패키지는 [daeho-ro](https://github.com/daeho-ro)님이 올려주셨습니다.

```sh
brew install hop
```

전체 릴리즈는 [GitHub Releases](https://github.com/golbin/hop/releases)에서 확인할 수 있습니다.

## 설치 유의사항

### Windows

Windows 빌드는 아직 서명되지 않아 Edge나 Windows SmartScreen에서 "일반적으로 다운로드되지 않습니다" 또는 실행 경고가 뜰 수 있습니다. 다운로드 항목의 `...` 메뉴에서 `유지`를 선택한 뒤 다운로드할 수 있습니다.

### Linux

Linux에서는 한글 IME와 WebKitGTK 런타임 안정성을 위해 배포판에 맞는 네이티브 패키지를 우선 사용해 주세요. arm64 Linux는 Ubuntu/Debian 계열 `.deb`를 먼저 지원합니다. AppImage는 portable 실행이 필요할 때만 권장하며, 일부 Wayland/IME 환경에서는 한영 전환이나 창 표시가 불안정할 수 있습니다.

Arch, CachyOS, EndeavourOS 계열은 AUR의 `hop-openhwp-bin` 패키지로 설치할 수 있습니다. 이 패키지는 [seunghun-kim](https://github.com/seunghun-kim)님이 올려주셨습니다.

```sh
yay -S hop-openhwp-bin
# 또는
paru -S hop-openhwp-bin
```

## 개발하기

개발 환경 준비, 실행 명령, 프로젝트 구조, `rhwp`와의 관계는 [개발 문서](docs/DEVELOPMENT.md)에 정리해 두었습니다.

## Credits

HOP는 [rhwp](https://github.com/edwardkim/rhwp)를 기반으로 합니다. HWP 엔진을 공개해 주신 개발자분께 감사드립니다.

License: MIT
