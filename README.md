# Agent Desk

TweetDeck처럼 여러 컬럼에서 CLI 에이전트(Claude Code, Codex) 작업을 보고, 지시하고, 승인하고, 이어서 진행하는 로컬 우선 데스크입니다. 같은 네트워크의 폰에서도 열 수 있고, macOS 데스크톱 앱(Tauri)으로도 띄울 수 있습니다.

## 구성

| 위치 | 역할 |
| --- | --- |
| `hub/` | HTTP 서버(기본 `:4317`). 프로젝트·작업·이벤트를 SQLite(`node:sqlite`)에 저장하고, SSE로 화면에 실시간 전달합니다. 빌드한 웹 화면도 함께 제공합니다. |
| `hub/src/runner/` | 러너 데몬(`127.0.0.1:4318`). 에이전트 세션(Claude Agent SDK, `codex app-server`)을 실제로 실행합니다. 허브와 분리되어 있어 허브를 재시작해도 실행 중인 세션이 끊기지 않습니다. |
| `web/` | React + Vite 화면. 컬럼, 스레드, 작성 서랍, 승인 대기열, 검색, 스킬 관리. |
| `desktop/` | 허브 화면을 창 하나로 띄우는 Tauri v2 셸. Finder에서 끌어다 놓은 파일의 절대 경로를 전달합니다. 자세한 내용은 [`desktop/README.md`](desktop/README.md). |

## 설치

### 1. 준비물

| 항목 | 용도 | 설치 |
| --- | --- | --- |
| Node.js 26 이상 | 허브·러너 실행 (TypeScript를 빌드 없이 직접 실행하고 `node:sqlite`를 씀) | https://nodejs.org 또는 `brew install node` |
| Claude Code | Claude 작업. 앱이 띄우는 세션은 이 로그인 정보를 씀 | `npm install -g @anthropic-ai/claude-code` 후 `claude`를 한 번 실행해 로그인 |
| Codex CLI (선택) | Codex 작업 | `npm install -g @openai/codex` 후 `codex login` |
| Xcode Command Line Tools, Rust (선택) | macOS 데스크톱 앱 빌드 | `xcode-select --install`, https://rustup.rs |

`node -v`가 `v26` 이상인지 확인합니다. Codex를 쓰지 않으면 Codex CLI 없이도 동작합니다(Codex 작업만 실패).

### 2. 받아서 빌드

```sh
git clone https://github.com/moohnam/agent-desk.git
cd agent-desk
npm install
npm run build    # web/dist 생성
```

### 3. 실행

```sh
npm start        # http://127.0.0.1:4317 에서 허브 + 화면
```

브라우저로 http://127.0.0.1:4317 을 엽니다. 처음 실행하면 `data/`에 DB와 접속 토큰이 생깁니다.

- 허브는 러너(에이전트 세션을 실행하는 프로세스, `127.0.0.1:4318`)가 없으면 따로 띄웁니다. 러너는 허브와 별개 프로세스라 허브를 꺼도 실행 중인 작업이 계속됩니다.
- 터미널을 닫아도 허브를 유지하려면 백그라운드로 띄웁니다: `nohup npm start >> data/hub.log 2>&1 &`

### 4. 끄기

| 대상 | 방법 |
| --- | --- |
| 허브 | 실행한 터미널에서 `Ctrl+C`, 백그라운드면 `pkill -f "node src/index.ts"` |
| 러너 | `npm run runner:stop`. 실행 중인 세션도 함께 끝나며, 다시 띄운 뒤 다음 메시지에서 이전 대화를 resume으로 이어감 |

### 5. 업데이트

```sh
git pull
npm install
npm run build
```

이후 허브를 재시작합니다. 열려 있는 화면은 새로고침(`⌘R`)만 하면 됩니다. `hub/src/runner/`가 바뀌었으면 작업이 없을 때 러너도 재시작합니다(`npm run runner:stop` 후 허브가 다시 띄움, 또는 `npm run runner`).

### 6. 데스크톱 앱 (macOS, 선택)

허브 화면을 별도 창으로 띄우고, Finder에서 끌어다 놓은 파일의 실제 경로를 넘겨 줍니다. 앱을 열 때 허브가 꺼져 있으면 빌드한 저장소에서 허브를 띄웁니다.

```sh
cd desktop
npm install --workspaces=false
npm run deploy   # 빌드 후 /Applications/Agent Desk.app 을 교체 (애드혹 서명). 실행 중인 앱은 먼저 종료
```

서명·공증하지 않은 앱이라 처음 실행 때 막히면 Finder에서 우클릭 후 "열기"를 고릅니다. 자세한 동작은 [`desktop/README.md`](desktop/README.md)를 봅니다.

### 개발

- `npm run hub`(파일 변경 시 허브 재시작)와 `npm run web`(Vite, http://127.0.0.1:5173)을 각각 띄웁니다.
- 타입 검사: `npm run typecheck`
- 실행 데이터(DB, 접속 토큰, 로그, 업로드, 스킬)는 모두 `data/`에 생기며 저장소에는 올리지 않습니다. `data/access-token`은 다른 사람에게 보이지 않게 둡니다.

### 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` / `HOST` | `4317` / `0.0.0.0` | 허브 주소. 네트워크에 열지 않으려면 `HOST=127.0.0.1` |
| `AGENT_DESK_DB` | `data/agent-desk.db` | SQLite DB |
| `AGENT_DESK_TOKEN_FILE` | `data/access-token` | 다른 기기 접속 토큰 |
| `AGENT_DESK_UPLOADS` | `data/uploads` | 첨부 파일 저장 위치 |
| `AGENT_DESK_SKILLS_HOME` | `data/desk-plugin` | 데스크 스킬(로컬 Claude Code 플러그인 `desk`) |
| `RUNNER_PORT` | `4318` | 러너 포트 |
| `RUNNER_IDLE_MS` | 30분 | 이 시간 동안 활동이 없는 세션을 닫음. 다음 메시지에서 resume |
| `RUNNER_LOG` / `RUNNER_PID_FILE` | `data/runner.log` / `data/runner.pid` | 러너 로그와 PID 파일 |
| `CODEX_BIN` | `codex` | Codex 실행 파일 |

### 다른 기기에서 열기

화면 상단의 **폰에서 열기**에 나오는 QR 코드(허브 시작 로그에도 나옴)를 스캔하면 접속 토큰이 쿠키로 저장됩니다. 이 Mac에서 `localhost`·`127.0.0.1`로 접속할 때는 토큰이 필요 없습니다. 토큰 파일을 지우고 허브를 재시작하면 새 토큰이 발급되고, 이전 기기는 다시 스캔해야 합니다. 로컬 파일 링크 열기는 Mac에서만 동작합니다.

## 기본 사용법

1. `npm start`로 허브를 띄우고 http://127.0.0.1:4317 (또는 데스크톱 앱)을 엽니다.
2. `i`로 작성 서랍을 열고 `@프로젝트이름:/작업/디렉터리 할 일`처럼 첫 작업을 보냅니다. 프로젝트가 등록되고 새 작업이 시작됩니다. 이후에는 `@프로젝트이름`만 쓰면 됩니다(`Tab`으로 완성).
3. 작업 글이 컬럼에 실시간으로 올라옵니다. `j`/`k`로 글을 고르고 `Enter`로 스레드를 열어 전체 흐름을 봅니다.
4. 도구 승인 요청이나 질문이 오면 글에서 바로 누르거나 `y`/`n`으로 답합니다. 여러 작업의 대기 건은 `a`(응답 대기열)에서 한꺼번에 처리합니다.
5. 스레드에서 `r`로 후속 지시를 보냅니다. 실행 중에 보낸 메시지는 대기열에 쌓였다가 턴이 끝나면 보내집니다.
6. `c`로 컬럼을 추가해 프로젝트·작업·상태별로 나눠 봅니다. 스레드에서 `p`를 누르면 그 작업을 컬럼으로 고정합니다.

### 대상 지정 (`@`)

| 입력 | 의미 |
| --- | --- |
| `@프로젝트:/절대/경로` | 프로젝트를 등록(이미 있으면 재사용)하고 새 작업 시작 |
| `@프로젝트` | 그 프로젝트의 가장 최근 작업에 이어서 보내기 |
| `@프로젝트#2` | 그 프로젝트의 2번 작업에 보내기 (번호는 스레드 머리에 표시) |

스레드에서 답글로 보낼 때는 `@`가 필요 없습니다.

### 태그 (`#`)

태그는 메시지 어디에 써도 되고, 보낼 때 본문에서 빠집니다. 모르는 태그는 글자 그대로 남습니다. `#`을 치면 완성 목록이 뜹니다.

| 태그 | 의미 | 유지 범위 |
| --- | --- | --- |
| `#ask` / `#auto` | 도구 실행을 매번 확인(기본) / 자동 승인 | 다른 쪽 태그를 쓸 때까지 |
| `#claude` / `#codex` | 새 작업의 엔진 (기본 Claude). 기존 작업은 엔진을 바꾸지 않음 | 작업 |
| `#opus` `#sonnet` `#haiku` | Claude 모델 | 작업 (다른 모델 태그까지) |
| `#sol` `#astra` `#terra` `#luna` | Codex 모델 계열(그 계열의 최신 버전) | 작업 (다른 모델 태그까지) |
| `#low` `#medium` `#high` `#xhigh` `#max` | reasoning effort. 모델이 지원하지 않는 단계면 가장 가까운 단계로. `#ultra`는 Codex 전용 | 작업 |
| `#later` / `#now` | 실행 중일 때 지금 턴이 끝난 뒤 보내기(기본) / 지금 턴에 끼워 넣기 | 이 메시지 |
| `#new` | 같은 프로젝트에서 새 작업 시작 (이전 대화 없이) | 이 메시지 |
| `#fork` | 지금까지의 대화를 복사해 이어가는 새 작업 (원래 작업과 동시에 진행) | 이 메시지 |
| `#스킬이름` | 그 데스크 스킬을 이 메시지에만 적용 | 이 메시지 |

모델 태그는 새 작업의 엔진도 정합니다(`#sol`이면 Codex). 태그가 없는 새 작업은 데스크의 기본 모델 설정(상단 모델 버튼)을 따릅니다.

예:

```text
@agent-desk:/Users/me/src/agent-desk #codex #high 검색 컬럼에 날짜 필터를 추가해줘
@agent-desk #auto 린트 오류를 모두 고쳐줘
@agent-desk#2 #now 테스트는 건너뛰고 빌드만 확인해
@agent-desk #fork 같은 내용을 다른 방식으로 구현해봐
@agent-desk #new #review 최근 변경을 리뷰해줘   # review라는 데스크 스킬이 있을 때
```

`⌘ Enter`로 보냅니다. 입력란에서는 Emacs 식 커서 이동·삭제 키(Ctrl+A/E/F/B/N/P/D/H/K/W, Alt+F/B/D 등)를 씁니다.

### 주요 단축키

| 키 | 동작 |
| --- | --- |
| `j` / `k` | 아래 / 위 글 |
| `J` / `K` | 다음 / 이전 작업의 글로 |
| `h` / `l` | 왼쪽 / 오른쪽 컬럼 |
| `gg` / `G` / `gr` | 맨 위 / 맨 아래 / 전체 컬럼의 가장 최근 글 |
| `Enter` / `q` | 스레드 열기 / 닫기 |
| `r` / `i` | 답글 쓰기 / 새 작업 |
| `` Ctrl ` `` | 작성 서랍 열기·닫기 |
| `y` / `n` / `s` | 승인 / 거절 / 작업 중단 |
| `a` | 응답 대기열 |
| `/` | 검색 |
| `c` / `e` / `p` / `D D` | 컬럼 추가 / 편집 / 작업 고정 / 삭제 |
| `H` / `L`, `<` / `>` | 컬럼 옮기기, 폭 조절 |
| `?` | 전체 단축키 도움말 |

## 기능

- **작업**: 프로젝트(작업 디렉터리)마다 Claude Code 또는 Codex 세션을 띄우고, 후속 지시·중단·resume을 합니다. 작업마다 `프로젝트#번호`가 붙습니다.
- **승인과 질문**: 도구 실행 승인/거절, 에이전트 질문(선택지 포함)에 답하기. 응답을 기다리는 작업은 승인 대기열(`a`)에 모입니다.
- **메시지 대기열**: 실행 중에 보낸 메시지는 턴이 끝난 뒤 보내며(`#later`, 기본), `#now`는 지금 턴에 끼워 넣습니다. 대기 중인 메시지는 수정·순서 변경·바로 보내기가 됩니다.
- **컬럼**: 작업·프로젝트·종류·상태·검색어로 컬럼을 구성하고, 이름 변경(제목 더블클릭)·폭 조절·순서 변경을 합니다. 설정은 브라우저에 저장합니다.
- **검색**: `/`로 검색 컬럼을 열고 `#project:`, `#status:`, `#kind:`, `#task:` 필터를 씁니다.
- **첨부**: 파일·이미지를 끌어다 놓거나 붙여 넣으면 `data/uploads`에 저장해 경로를 넘깁니다. 폰에서도 올릴 수 있습니다.
- **스킬**: 상단 스킬 버튼에서 데스크 스킬을 만들고 고칩니다. 메시지에 `#스킬이름`을 쓰면 그 메시지에만 적용합니다.
- **터미널 세션 붙이기(MCP)**: 허브의 `/mcp`(Streamable HTTP)를 `agent-desk` MCP 서버로 등록하면, 터미널에서 돌던 Claude Code·Codex 세션이 `desk_attach`, `desk_post`, `desk_checkpoint`, `desk_ask`, `desk_finish`로 데스크에 진행을 올리고 질문할 수 있습니다.

  ```sh
  claude mcp add --scope user --transport http agent-desk http://127.0.0.1:4317/mcp
  ```

  Codex는 `~/.codex/config.toml`에 다음을 추가합니다.

  ```toml
  [mcp_servers.agent-desk]
  url = "http://127.0.0.1:4317/mcp"
  ```

## API (일부)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/state` | 프로젝트, 작업, 대기 중 승인·질문 |
| GET | `/api/stream` | SSE 실시간 갱신 |
| GET | `/api/feed` | 전체 작업의 글 피드 |
| POST | `/api/projects` | `{name, root_path}` |
| POST | `/api/tasks` | 새 작업 |
| POST | `/api/compose` | 작성창 문법(`@프로젝트#번호`, `#new` 등)을 해석해 보내기 |
| GET | `/api/tasks/:id/events` | 작업 타임라인 페이지 |
| POST | `/api/tasks/:id/messages` | 후속 지시 (세션이 없으면 resume) |
| PUT·DELETE | `/api/tasks/:id/queue/:id` | 대기 중인 메시지 수정·삭제 (`POST …/send`: 바로 보내기) |
| POST | `/api/tasks/:id/interrupt` | 진행 중인 턴 중단 |
| POST | `/api/approvals/:id` | 승인 / 거절 |
| POST | `/api/questions/:id` | 질문에 답하기 |
| POST | `/api/uploads` | 첨부 업로드 |
| GET·PUT | `/api/settings` | 기본 모델 등 설정 |
| … | `/api/skills` | 데스크 스킬 관리 |

앱에서 띄운 세션도 사용자 전역 설정(`~/.claude/CLAUDE.md`, settings 등)을 그대로 읽습니다.
