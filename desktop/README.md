# Agent Desk 데스크톱 앱 (macOS, 로컬 빌드)

Agent Desk 허브(`http://127.0.0.1:4317/`)를 창 하나로 띄우는 Tauri v2 셸입니다.
브라우저와 달리 Finder에서 끌어다 놓은 파일의 **실제 절대 경로**를 페이지에 전달합니다.
서명, 공증, 자동 업데이트는 없습니다.

## 준비물

- macOS, Xcode Command Line Tools (`xcode-select --install`)
- Rust (cargo/rustc), Node.js와 npm
- Node(로그인 셸의 PATH에서 찾음). 허브가 꺼져 있으면 앱이 띄웁니다.

## 빌드

```sh
cd desktop
npm install --workspaces=false   # 루트 워크스페이스와 섞이지 않게 desktop/에만 설치
npm run build                    # tauri build --bundles app
```

결과물은 `desktop/src-tauri/target/release/bundle/macos/Agent Desk.app`에 생깁니다.
`npm run deploy`는 빌드 후 `/Applications/Agent Desk.app`을 교체하고 애드혹 서명까지 합니다(실행 중인 앱은 먼저 종료).
서명하지 않은 앱이라 처음 실행 때 Gatekeeper가 막으면 Finder에서 우클릭 후 "열기"를 고릅니다.

개발 중에는 `npm run dev`로 실행합니다.

## 동작

- 허브 화면이 OS 알림을 띄울 수 있습니다(알림 플러그인, 허브 주소에만 알림 권한). 상단 종 버튼으로 켭니다. 앱 안에서는 권한 확인이 늘 허용으로 나오므로, 알림이 오지 않으면 macOS 시스템 설정 > 알림에서 Agent Desk를 확인하세요. 알림을 눌러도 앱이 앞으로 올 뿐 해당 스레드로 가지는 않습니다. 허브 주소가 IPv6(`[::1]`)이면 알림을 쓰지 않습니다.
- 접속 주소는 기본 `http://127.0.0.1:4317/`입니다. 환경 변수 `AGENT_DESK_URL`로 바꿀 수 있습니다.
- 시작할 때 로컬 허브(127.0.0.1·localhost)에 연결할 수 없으면 이 앱을 빌드한 저장소(`AGENT_DESK_HOME`으로 바꿀 수 있음)에서 `node src/index.ts`로 허브를 띄웁니다. 허브는 러너가 없으면 러너도 띄웁니다. 허브 출력은 `data/hub.log`에 이어 씁니다.
- 허브는 별도 프로세스 그룹으로 떠서 앱을 닫아도 계속 돕니다(폰 접속, 승인 대기 유지). 끌 때는 터미널에서 허브 프로세스를 종료합니다.
- 허브가 뜰 때까지 안내 페이지를 띄우고 1초마다(시작하지 않은 경우 3초마다) 다시 확인합니다. "다시 시도" 버튼도 있습니다. 허브가 뜨면 허브 화면으로 넘어갑니다.
- 허브와 출처(origin)가 다른 http(s) 링크와 `target=_blank` 링크는 시스템 기본 브라우저로 엽니다.

## 페이지에 전달하는 이벤트

모든 페이지 로드 때 다음을 먼저 실행합니다. 페이지는 이것으로 앱 안에서 실행 중인지 알 수 있습니다.

```js
window.__AGENT_DESK_APP__ = true;
window.dispatchEvent(new Event('desk-app'));
```

Finder에서 파일을 끌어다 놓으면 다음 이벤트가 `window`로 전달됩니다.

| 시점 | 이벤트 | `detail` |
| --- | --- | --- |
| 창 위로 들어옴 | `desk-drag` | `{ over: true }` |
| 창 밖으로 나감 | `desk-drag` | `{ over: false }` |
| 놓음 | `desk-drop` | `{ paths: ["/abs/path/a.txt", ...], url, html }` |

웹 페이지에서 끌어온 것(파일 없음)은 `paths`가 비고, 드래그 보드의 주소(`url`)와 마크업(`html`)이 옵니다. 웹 화면은 이미지면 허브가 내려받게 하고(`POST /api/uploads {url}`), 링크면 주소를 넣습니다. 주소 없이 그림 데이터만 있으면 앱이 `data/uploads/날짜/`에 PNG로 저장해 `paths`로 넘깁니다.
| 놓은 직후 | `desk-drag` | `{ over: false }` |

```js
window.addEventListener('desk-drop', (e) => console.log(e.detail.paths));
```

앱이 끌어다 놓기를 가로채므로 앱 안에서는 페이지의 HTML5 `drop` 이벤트에 기대지 말고 위 이벤트를 씁니다(HTML5 이벤트 발생 여부는 확인하지 않았습니다).
