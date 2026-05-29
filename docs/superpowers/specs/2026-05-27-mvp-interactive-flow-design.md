# MVP — 인터랙티브 플로우 슬라이스 설계

## 한 줄 요약

백엔드·STT·OAuth 없이 클라이언트만으로 "웹 서비스처럼" 클릭·입력 흐름이 자연스럽게 이어지는 Electron 프로토타입. 회의 보조 사이드바(폭 400px)까지 포함.

## 목표

- 사용자가 앱을 켜서 로그인 → 그룹 생성 → 회의 참여 → 보조 사이드바 사용 → 회의 종료 → 정리 화면 → 홈 복귀까지 끊김 없이 클릭으로 이동할 수 있다.
- 사용자가 입력한 데이터(그룹·결정사항·태스크·안건·액션)는 화면을 옮겨도 보존된다(세션 동안).
- 회의 진행 중 보조 사이드바와 메인 화면이 같은 데이터를 본다(한쪽 변경 → 양쪽 즉시 반영).

## 비목표

- 실제 마이크 캡처, STT 추론, Python 사이드카
- 카카오 OAuth, JWT 발급, 백엔드 서버, RDS
- WebSocket, 다인 동시 접속
- LLM 호출(요약은 고정 텍스트)
- PDF 실제 생성(클릭 시 토스트만)
- 인앱·이메일 알림
- 새로고침/앱 재시작 후 데이터 영속화(세션 한정)

## 기술 스택

- 기존 그대로: Electron 33 + Vite + React 18 + TypeScript 5
- 신규: **Zustand**(단일 의존성 추가) — docs `01-아키텍처.md`에서 권장된 옵션
- CSS: 기존 `index.css` / `screens/*.css` 그대로 사용. 사이드바용 `widget.css` 신규.
- 라우터: 도입하지 않음(현재 `useState<Screen>` 유지)

## 화면 흐름

```
login ──카카오/둘러보기──▶ home
home ──"새 그룹"────────▶ onboard ──3단계 완료──▶ dashboard
home ──그룹 카드 클릭───▶ dashboard
home ──"live" 회의 카드 "회의 참여"──▶ dashboard + 사이드바 동시 오픈
home ──초대코드 참가────▶ store에 그룹 추가, home 그대로 머묾(토스트)
dashboard / dash ──"회의 참여하기"──▶ 사이드바 오픈(보조창)
dashboard / meeting ──회의 카드 선택──▶ 디테일 영역 갱신
dashboard 어디서든 사이드바의 "회의 종료" 또는 pin 토글──▶ 사이드바 닫힘
dashboard / meeting "회의 종료" 클릭──▶ summary 화면(신규)
summary ──"홈으로"──▶ home
사이드바 우측 상단 logout 영역(현재 없음, 추후 P1) — 이번 슬라이스에선 home 좌측 상단 로고 영역에서 "로그아웃"(작은 텍스트)으로 login 복귀
```

신규 화면 1개: `summary` (회의 종료 직후 정리 화면). 7번 화면이 아닌 dashboard 안의 페이지(`'dpage-summary'`)가 아니라 **앱 셸 레벨 스크린**으로 둠 — 회의가 끝났음을 강하게 인식시키기 위함.

## 데이터 모델 (Zustand store)

```ts
type ID = string

type ScreenName = 'login' | 'onboard' | 'home' | 'dashboard' | 'summary'
type DashboardPage = 'dash' | 'meeting' | 'tasks' | 'report'
type MeetingTab = 'agenda' | 'speak' | 'decision' | 'summary'

interface User { id: ID; name: string; av: 'a1'|'a2'|'a3'|'a4' }

interface Group {
  id: ID
  name: string
  subjectType: '캡스톤'|'전공'|'스터디'|null
  deadline: string | null     // ISO date
  inviteCode: string
  memberIds: ID[]
  myContribution: number      // 0~100, 데모용
  status: '진행 중'|'활동 중'
  stripeColor: 'green'|'blue'|'gray'
}

interface Meeting {
  id: ID
  groupId: ID
  name: string
  scheduledAt: string         // ISO datetime
  expectedMin: number
  status: '예정'|'진행'|'완료'
  startedAt?: string
  endedAt?: string
  agendaIds: ID[]
  decisionIds: ID[]
  taskIds: ID[]               // 회의 중 만들어진 액션 아이템
}

interface Agenda {
  id: ID
  meetingId: ID
  text: string
  expectedMin: number
  status: '대기'|'진행'|'완료'
  startedAt?: string
  endedAt?: string
  summary?: string            // 완료 시 고정 텍스트 stub
}

interface Decision {
  id: ID
  meetingId: ID
  text: string
  createdAt: string
}

interface Task {
  id: ID
  groupId: ID
  meetingId?: ID
  title: string
  assigneeId: ID
  due?: string                // ISO date or null
  status: '할 일'|'진행 중'|'완료'
  severity?: 'danger'|'warn'  // 임박/지연 표시 (mock)
}

interface UiState {
  screen: ScreenName
  dashboardPage: DashboardPage
  meetingTab: MeetingTab
  taskView: 'board'|'list'
  sidebarOpen: boolean        // 회의 보조 사이드바 표시 여부
  activeMeetingId: ID | null  // 사이드바·회의 페이지가 보는 회의
  activeGroupId: ID | null
  theme: 'light'|'dark'
  toast: string | null
}

interface Store extends UiState {
  // 정규화된 도메인 데이터
  currentUserId: ID
  usersById: Record<ID, User>
  groupsById: Record<ID, Group>
  meetingsById: Record<ID, Meeting>
  agendasById: Record<ID, Agenda>
  decisionsById: Record<ID, Decision>
  tasksById: Record<ID, Task>

  // 액션 (도메인별 묶음)
  navigate(s: ScreenName): void
  setDashboardPage(p: DashboardPage): void
  setMeetingTab(t: MeetingTab): void
  setTaskView(v: 'board'|'list'): void
  toggleTheme(): void
  showToast(msg: string): void

  login(): void
  logout(): void

  createGroup(input: { name: string; subjectType: Group['subjectType']; deadline?: string }): ID
  joinGroupByCode(code: string): { ok: true; groupId: ID } | { ok: false; reason: string }
  enterGroup(groupId: ID): void
  leaveToHome(): void

  startMeeting(meetingId: ID): void
  endMeeting(meetingId: ID): void
  openSidebarFor(meetingId: ID): void
  closeSidebar(): void

  addAgenda(meetingId: ID, text: string, expectedMin: number): ID
  advanceAgenda(meetingId: ID): void        // 다음 안건으로 진행
  completeCurrentAgenda(meetingId: ID): void // 현재 안건 완료 + 고정 summary 부착

  addDecision(meetingId: ID, text: string): ID
  editDecision(id: ID, text: string): void
  deleteDecision(id: ID): void

  addTask(input: Omit<Task, 'id'>): ID
  updateTaskStatus(id: ID, status: Task['status']): void
  toggleTaskDone(id: ID): void
}
```

**시드 데이터**: 앱 시작 시 store에 다음 mock을 채워 둠 (현재 화면들이 보여주고 있는 데이터 그대로 옮긴 것):

- 사용자: 김민준(나, a1), 이서연(a2), 박지호(a3), 최유나(a4) 등 5명
- 그룹: 캡스톤 설계 팀 A, 마케팅원론 조별과제, 알고리즘 스터디 — 총 3개
- 회의: "발표 준비 회의"(진행 중), "최종 발표 리허설"(예정), "중간 점검"·"킥오프"(완료) — 캡스톤 팀 A에 4개
- 안건/결정/태스크: 발표 준비 회의 기준 현재 mockup이 보여주는 양

스토어 구조는 Zustand `create<Store>()(set, get) => ({ ... })` 한 파일 (`client/src/stores/app.ts`)에 작성. selector hook은 `useAppStore(state => state.x)` 형태로 화면들이 직접 사용.

## 컴포넌트 변화

| 파일 | 변경 |
|------|------|
| `client/src/App.tsx` | screen/theme/toast/sidebar를 store에서 읽음. 화면별 props 대신 store 직접 구독 |
| `client/src/screens/LoginScreen.tsx` | navigate 대신 `store.login()` 호출 → home으로 이동 |
| `client/src/screens/OnboardingScreen.tsx` | 입력 폼이 실제로 그룹을 만들고 store에 추가. `enterGroup` 시 새로 만든 그룹으로 진입 |
| `client/src/screens/HomeScreen.tsx` | mock 카드 대신 store의 groups 렌더링. join box / "내 태스크" / "최근 활동" / "예정된 회의"도 store 기반. "회의 참여" 버튼 = 대시보드 진입 + 사이드바 오픈. 우상단 아바타 클릭 = 로그아웃 popover 토글 |
| `client/src/screens/DashboardScreen.tsx` | hard-coded 데이터 → store. 결정/태스크/안건 CRUD 액션 모두 store 호출. 회의 종료 버튼 → `endMeeting` + `navigate('summary')`. "회의 참여하기" 버튼 → `openSidebarFor(activeMeetingId)` |
| `client/src/screens/SummaryScreen.tsx` (신규) | 최근 종료된 회의의 결정·태스크·기여도 표를 정리 형태로 표시. AI 종합 정리는 고정 텍스트 안내. "홈으로" 버튼 |
| `client/src/widget/MeetingSidebar.tsx` (신규) | design HTML `<aside class="widget">` 이식. store 구독으로 sidebarOpen·activeMeetingId·decisions·agendas 등 렌더 |
| `client/src/widget/widget.css` (신규) | design HTML의 `.widget` ~ `.w-recent-*` 까지 CSS 이식 |
| `client/src/stores/app.ts` (신규) | Zustand 스토어 단일 파일 |
| `client/src/stores/seed.ts` (신규) | 초기 mock 데이터 |

## 회의 종료 / 안건 완료 / 로그아웃 진입점 (명세)

- **회의 종료**: dashboard / meeting 페이지 우상단 "회의 종료" 버튼이 유일한 진입점. 사이드바에는 없음(사이드바는 보조 뷰).
- **안건 완료**: dashboard / meeting / 아젠다 탭에서 현재 안건(`.ag-item.cur`) 옆에 "완료" 버튼을 신설하여 `completeCurrentAgenda` 호출. 사이드바에서는 진행 중 안건의 시간 게이지·경과만 표시, 상태 전환은 dashboard에서만.
- **로그아웃**: home의 우상단 아바타(`.av.a1.av-md`) 클릭 시 단순 메뉴(이름 + "로그아웃" 한 줄)를 토글로 띄움. "로그아웃" 클릭 → `store.logout()` → login. 단일 인터랙션이라 별도 컴포넌트가 아닌 home 내부 작은 popover로 처리.

## 레이아웃 (사이드바 포함)

- 기존: `body` → `.app` 하나
- 변경: `body` → flex 컨테이너로 `.app`(가변) + `.widget`(사이드바, 폭 400 고정, sidebarOpen일 때만 렌더). design HTML의 body flex 정렬과 동일.
- `index.css`의 `.app { max-width: 1360px; height: calc(100vh - 52px); }`는 그대로. sidebarOpen일 땐 `.app` width가 자연스럽게 줄어들고, 옆에 widget이 같은 높이로 자리잡음.
- 사이드바 트리거:
  - home의 진행 중 회의 카드 "회의 참여" 버튼
  - dashboard / dash 페이지의 "회의 참여하기" 버튼
  - dashboard / meeting 페이지의 진행 중 회의 카드(`mcard.sel`)
- 사이드바 닫기:
  - 사이드바 상단 pin 토글 → 사이드바 닫힘 + 토스트
  - dashboard / meeting 페이지 "회의 종료" → 사이드바 닫힘 + summary 화면 진입

## 인터랙션 매핑 (현재 → store)

| 현재 | 변경 |
|------|------|
| LoginScreen "카카오로 시작하기" / "둘러보기" | `store.login()` (현재 user를 김민준으로 세팅) → home |
| OnboardingScreen 3단계 "대시보드로 이동" | `createGroup(...)` → `enterGroup(newId)` → dashboard |
| HomeScreen "새 그룹" / `new-group` 카드 | `navigate('onboard')` |
| HomeScreen 그룹 카드 클릭 | `enterGroup(group.id)` → dashboard |
| HomeScreen 진행 중 회의 "회의 참여" | `enterGroup(group.id) + setDashboardPage('dash') + openSidebarFor(meeting.id)` |
| HomeScreen 초대코드 입력 → "참가하기" | `joinGroupByCode(code)`. ok면 그룹 추가 + 토스트, 아니면 토스트 |
| HomeScreen "내 태스크" 체크 | `toggleTaskDone(taskId)` (현재처럼 leaving 애니메이션 그대로) |
| DashboardScreen "회의 참여하기" 버튼 | `openSidebarFor(activeMeetingId)` |
| DashboardScreen 결정/태스크/안건 CRUD | 모두 store 액션 |
| DashboardScreen "회의 종료" | `endMeeting(activeMeetingId) → closeSidebar() → navigate('summary')` |
| DashboardScreen "내 그룹으로" | `leaveToHome()` (사이드바도 닫음) |
| SummaryScreen "홈으로" | `navigate('home')` |
| MeetingSidebar pin 토글 | `closeSidebar()` + 토스트 |
| MeetingSidebar 안건 요약 토글 | 로컬 UI 상태(어느 안건이 펼쳐졌는지)는 사이드바 컴포넌트 내부 |
| MeetingSidebar 빠른 입력 결정사항 Enter | `addDecision(activeMeetingId, text)` |
| MeetingSidebar 액션 추가 버튼 | task 모달 열기(현재 dashboard task 모달 재사용) |

## 흐름이 동작하지 않는 항목 (의도적 stub)

- 회의 경과 타이머는 dashboard 진입 시점부터 1초 단위로 증가(현재 구현 그대로). 사이드바도 같은 store 값을 본다.
- 발화량(글자수)·기여도 바 자동 증가는 없음. 현재 mock 비율 유지.
- 안건 상태 자동 전환 없음. "안건 완료" 액션은 dashboard / meeting 안건 패널의 안건 클릭으로 수동 전환(`completeCurrentAgenda`) — 완료 시 고정 텍스트 summary가 부착되어 사이드바에서 "요약 보기"로 펼침 가능.
- 사이드바 "역할 수행도" 탭은 현재 store의 task 완료율로 계산해 표시(자동 갱신은 task 완료/체크 시점).
- AI 회의 종합 정리, PDF 출력은 토스트만 표시.

## 에러·엣지 처리

- 초대코드 형식: 정규식 `^[A-Z]{3}-\d{3}$` 검증. 미충족 시 토스트 "올바른 초대코드를 입력해주세요".
- 초대코드 충돌: 이미 가입된 그룹 코드면 토스트 "이미 가입된 그룹입니다".
- 그룹 이름 빈 값: "그룹 이름을 입력해주세요" 토스트.
- 결정사항 빈 값: 기존 동작 그대로(토스트).
- "회의 참여" / "회의 종료" 클릭 시 `activeMeetingId`가 없으면(예: 회의가 모두 완료된 그룹) 토스트로 안내.
- 사이드바 트리거가 발생했는데 진행 중 회의가 없으면 → 가장 가까운 예정 회의를 임시로 시작하지는 않음. 토스트 "진행 중인 회의가 없습니다".
- "회의 종료" 클릭 시 현재 안건이 `진행` 상태로 남아 있어도 강제로 `완료` 처리하지 않음. summary 화면에는 종료 시점의 상태 그대로 표시.

## 테스트

이번 슬라이스는 인터랙티브 흐름이 산출물이라 자동화 테스트보다 **수동 시나리오 통과**를 기준으로 한다. 다음 5개 시나리오가 통과해야 한다:

1. **신규 사용자 골든 패스**: 로그인 → 둘러보기 → "새 그룹" → 온보딩 3단계 → dashboard 진입 → 새 그룹이 사이드바 팀 정보와 home의 그룹 목록에 보임.
2. **회의 시작 + 사이드바**: home의 진행 중 회의 "회의 참여" 클릭 → dashboard로 이동 + 사이드바 자동 오픈 → 사이드바에서 결정사항 한 줄 입력 Enter → dashboard / meeting / 결정 사항 탭에도 그 줄이 즉시 보임.
3. **안건 완료 → 요약 펼침**: dashboard 안건 패널에서 "현재 안건 완료" → 사이드바 안건 항목이 "완료"로 바뀌고 "요약 보기" 버튼이 생김 → 클릭 시 고정 텍스트 펼침.
4. **태스크 보드 인터랙션**: 태스크 모달로 새 태스크 추가 → 보드 "할 일" 칸에 등장 → status 셀렉트로 "완료" 변경 → "완료" 칸으로 이동.
5. **회의 종료 → 정리 → 홈**: dashboard "회의 종료" → summary 화면 진입(해당 회의의 결정·태스크·기여도 요약 보임) → "홈으로" → home의 해당 회의 카드 상태가 "완료"로 변함.

각 시나리오의 클릭/입력 경로와 기대 결과를 PR 본문 체크리스트로 명시.

자동화 테스트는 store 액션 단위로 1~2개만 vitest로 작성(`createGroup` 후 `groupsById`에 추가되는지, `endMeeting` 후 meeting.status가 '완료'가 되는지) — over-engineering 방지를 위해 최소 범위.

## 작업 분할

이 spec은 다음 4개의 PR/슬라이스로 쪼개진다 (writing-plans 단계에서 더 세분화):

1. **store 도입** — Zustand 추가, `stores/app.ts`·`stores/seed.ts` 작성, 기존 컴포넌트들이 store에서 읽도록 1차 치환(데이터만, 액션은 다음 PR)
2. **흐름 액션** — login/logout, createGroup/joinGroupByCode/enterGroup/leaveToHome, decision·task CRUD store 연결, 화면 전환 액션 모두 store 경유로 변경
3. **회의 진행 + summary 화면** — `Meeting`·`Agenda` 액션, summary 신규 화면, 회의 종료 흐름
4. **회의 보조 사이드바** — `MeetingSidebar` 컴포넌트 + `widget.css`, App 셸 레이아웃 변경, 트리거 5곳 연결

## 향후 (이번 슬라이스 밖)

- localStorage `persist` 미들웨어 1줄 추가로 새로고침 후 데이터 유지
- 실제 백엔드 fetch로 액션 내부만 교체(store 인터페이스 유지)
- 사이드바를 별도 BrowserWindow로 분리 (docs `07-Electron-구현.md`의 권장 형태) — IPC 동기화 슬라이스 추가
- STT 사이드카 통합(1주차 PoC)
- 카카오 OAuth 실연동
