# MVP 인터랙티브 플로우 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 와이어프레임으로만 존재하던 4개 화면을 Zustand 단일 스토어 위에 올려, 로그인 → 그룹 생성/참가 → 회의 진행(보조 사이드바 포함) → 회의 종료 → 정리 → 홈 복귀까지 클릭/입력이 끊김 없이 이어지는 Electron 인터랙티브 프로토타입으로 만든다. 백엔드·STT·OAuth·LLM·영속화는 이 슬라이스 범위 밖.

**Architecture:** 현재 `useState` 기반 화면별 mock 데이터를, 정규화된(by-id) 도메인 데이터와 액션을 한 곳에 두는 Zustand 스토어로 일괄 치환한다. 화면 전환·테마·토스트·사이드바·activeMeetingId 같은 UI 상태도 같은 스토어에서 관리한다. `MeetingSidebar`(폭 400 고정)와 `SummaryScreen`을 신규 추가하고, App 셸 레이아웃을 `<main>` + `<aside>` flex 구조로 바꾼다.

**Tech Stack:** Electron 33, Vite 5, React 18, TypeScript 5, Vitest 2 (기존). 신규: Zustand 4.

---

## 사전 참고

- **Spec**: `docs/superpowers/specs/2026-05-27-mvp-interactive-flow-design.md` — 이 plan과 동시에 보면서 작업할 것. 데이터 모델·인터랙션 매핑·엣지 처리 등 모든 의사결정의 출처.
- **디자인 와이어프레임**: `design/무임하차.html` — `MeetingSidebar`(`<aside class="widget">`)와 사이드바 CSS 이식 시 원본.
- **DRY/YAGNI 원칙**: spec 비목표 그대로. 새로고침 후 영속화, 실제 마이크/STT, 카카오 OAuth, 백엔드, PDF 실제 생성, LLM 호출은 이 plan 범위 밖. 시도하지 말 것.
- **자동화 테스트 범위**: spec에 명시된 대로 store 액션 단위로 1~2개만 vitest로 작성. 화면은 spec § 테스트의 5개 수동 시나리오로 검증한다. UI 단위 테스트를 새로 도입하지 않는다.
- **작업 디렉토리**: 모든 경로는 저장소 루트(`/Users/sungwo/Project/무임하차`) 기준.

---

## File Structure (이 plan으로 닿는 파일)

**Create:**

- `client/src/stores/app.ts` — Zustand 스토어 단일 파일 (도메인 상태 + UI 상태 + 액션)
- `client/src/stores/seed.ts` — 초기 mock 데이터 (사용자/그룹/회의/안건/결정/태스크)
- `client/src/stores/types.ts` — 도메인 타입 (`User`, `Group`, `Meeting`, `Agenda`, `Decision`, `Task`, `Store` 등)
- `client/src/screens/SummaryScreen.tsx` — 회의 종료 직후 정리 화면 (앱 셸 레벨)
- `client/src/screens/summary.css` — SummaryScreen 전용 스타일
- `client/src/widget/MeetingSidebar.tsx` — 회의 보조 사이드바 (폭 400px)
- `client/src/widget/widget.css` — design HTML `.widget` ~ `.w-recent-*` 이식
- `client/test/stores/app.test.ts` — 핵심 store 액션 vitest 1~2개

**Modify:**

- `client/package.json` — Zustand 추가
- `client/src/App.tsx` — screen/theme/toast/sidebar/title을 store에서 읽음, 셸 레이아웃에 `<aside>` 추가, props drilling 제거
- `client/src/screens/LoginScreen.tsx` — `navigate` props → `store.login()` 직접 호출
- `client/src/screens/OnboardingScreen.tsx` — 입력값을 모아 `store.createGroup()` → `enterGroup(newId)`
- `client/src/screens/HomeScreen.tsx` — mock 카드 → `store.groupsById` 렌더, 진행 중 회의 "회의 참여" 클릭 시 `enterGroup + openSidebarFor`, 우상단 아바타 popover 로그아웃
- `client/src/screens/DashboardScreen.tsx` — 모든 mock useState → store selector, 결정/태스크/안건 CRUD store 액션 경유, "회의 종료" → `endMeeting + closeSidebar + navigate('summary')`

**Untouched (참고용 — 이번에 변경하지 않는다):**

- `client/electron/**` — 메인 프로세스 코드
- `client/src/components/`, `client/src/demos/`, `client/src/type/`, `client/src/assets/`
- `client/src/index.css`, `client/src/App.css`, `client/src/screens/*.css` (단, SummaryScreen 신규 CSS는 생성)
- `server/**` — 백엔드는 이 slice에 포함되지 않음

---

## Phase 0: 사전 점검 (5분, 단일 task)

### Task 0: 현 상태 확인 + 브랜치 분리

**Files:** 변경 없음 (셸 명령만).

- [ ] **Step 1: 현재 git 상태 확인**

```bash
git status
git log --oneline -5
```

기대: 현재 브랜치는 `main`. `client/` 하위 untracked 변경(`client/src/screens/`, App.tsx 등)이 있을 수 있음. 이미 spec 파일(`docs/superpowers/specs/2026-05-27-mvp-interactive-flow-design.md`)이 untracked 상태로 존재해야 한다 — 없다면 spec부터 작성/확인 필요.

- [ ] **Step 2: 작업 브랜치 생성**

```bash
git checkout -b feat/mvp-interactive-flow
```

기대: `Switched to a new branch 'feat/mvp-interactive-flow'`

- [ ] **Step 3: spec과 plan을 먼저 commit**

```bash
git add docs/superpowers/specs/2026-05-27-mvp-interactive-flow-design.md \
        docs/superpowers/plans/2026-05-27-mvp-interactive-flow.md
git commit -m "docs: MVP 인터랙티브 플로우 spec + plan 추가"
```

기대: 신규 파일 2개가 한 커밋으로 들어감.

- [ ] **Step 4: dev 서버가 현 상태에서 뜨는지 확인 (회귀 베이스라인)**

```bash
cd client && npm install && npm run dev
```

기대: Vite dev 서버가 http://127.0.0.1:7777 에서 정상 기동. Electron 창이 떠서 로그인 화면이 보이고, "카카오로 시작하기" → home → "새 그룹" → onboard → "대시보드로 이동" → dashboard 까지 navigate가 동작. 동작 안 하면 이 plan을 시작하기 전에 먼저 회귀를 잡는다.

확인 후 `Ctrl+C`로 종료.

---

## Phase 1: 스토어 도입 (도메인 데이터 read-only 치환)

목표: Zustand를 설치하고, 도메인/UI 상태와 시드 데이터를 한 스토어에 모은다. 이 phase에서는 **읽기**만 치환한다 — 화면들은 여전히 props로 navigate를 받아 동작하지만, 표시되는 데이터는 스토어 셀렉터에서 온다. CRUD 액션은 Phase 2에서 연결.

### Task 1.1: Zustand 설치

**Files:**

- Modify: `client/package.json`

- [ ] **Step 1: 의존성 추가**

```bash
cd client && npm install zustand@^4.5.5
```

기대: `package.json`의 `dependencies`(또는 `devDependencies`)에 `"zustand": "^4.5.5"`가 추가되고, `package-lock.json`이 갱신됨. 다른 패키지 버전 변동은 없어야 함 — 있으면 `npm install` 대신 `npm install zustand@^4.5.5 --save-exact`로 다시.

- [ ] **Step 2: 설치 확인**

```bash
cd client && node -e "console.log(require('zustand/package.json').version)"
```

기대: `4.5.5` (또는 4.5.x).

- [ ] **Step 3: 커밋**

```bash
git add client/package.json client/package-lock.json
git commit -m "chore(client): add zustand dependency"
```

### Task 1.2: 도메인 타입 정의

**Files:**

- Create: `client/src/stores/types.ts`

- [ ] **Step 1: `client/src/stores/types.ts` 생성**

spec § 데이터 모델 (Zustand store) 를 그대로 옮긴다. spec의 `Store` 인터페이스 안의 액션 시그니처도 모두 포함. `interface UiState`와 `interface Store extends UiState`까지 그대로 옮긴 뒤, 파일 끝에 다음 좁은 도우미 타입을 추가한다 (Phase 3에서 쓰임):

```ts
export type AddTaskInput = Omit<Task, 'id'>
export type CreateGroupInput = {
  name: string
  subjectType: Group['subjectType']
  deadline?: string
}
export type JoinGroupResult =
  | { ok: true; groupId: ID }
  | { ok: false; reason: string }
```

**중요:** 타입만 정의하고 구현은 다음 task에 둔다. `export type` / `export interface` 키워드를 빠뜨리지 말 것 — 다른 파일이 모두 여기서 import 한다.

- [ ] **Step 2: TypeScript 컴파일 검증**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0. 만약 `cannot find name 'ID'` 같은 에러가 뜨면 `type ID = string` export를 빠뜨린 것.

- [ ] **Step 3: 커밋**

```bash
git add client/src/stores/types.ts
git commit -m "feat(client/store): add domain types"
```

### Task 1.3: 시드 데이터

**Files:**

- Create: `client/src/stores/seed.ts`

- [ ] **Step 1: `client/src/stores/seed.ts` 생성**

현재 화면들이 보여주는 mock을 모두 정규화해서 by-id 맵으로 모은다. spec § 시드 데이터 절에서 명시한 양:

- 사용자 5명: 김민준(`u1`, a1, 나) / 이서연(`u2`, a2) / 박지호(`u3`, a3) / 최유나(`u4`, a4) / 강민재(`u5`, a3) — 마지막 1명은 알고리즘 스터디용
- 그룹 3개:
  - `g1` 캡스톤 설계 팀 A (캡스톤, 마감 `2026-06-14`, 멤버 u1-u4, 내 기여도 38, stripeColor `green`, status `진행 중`, inviteCode `CAP-001`)
  - `g2` 마케팅원론 조별과제 (전공, 마감 `2026-06-20`, 멤버 u1, u2, u3, 내 기여도 52, stripeColor `blue`, status `진행 중`, inviteCode `MKT-002`)
  - `g3` 알고리즘 스터디 (스터디, 마감 null, 멤버 u1, u2, u4, u5, 내 기여도 29, stripeColor `gray`, status `활동 중`, inviteCode `ALG-003`)
- 회의 4개 (모두 `g1` 캡스톤 팀 A 소속):
  - `m1` "발표 준비 회의" — status `진행`, scheduledAt 오늘 15:00, expectedMin 60, startedAt 오늘 15:00, agendaIds `[a1, a2, a3]`, decisionIds `[d1, d2]`, taskIds `[t1, t2]`
  - `m2` "최종 발표 리허설" — status `예정`, 모레 14:00, expectedMin 60, agendaIds `[a4, a5]`
  - `m3` "중간 점검" — status `완료`, 지난주, agendaIds `[]`, decisionIds `[]`
  - `m4` "킥오프" — status `완료`, 2주 전, agendaIds `[]`, decisionIds `[]`
- 안건 5개:
  - `a1` "발표 슬라이드 검토" — meetingId m1, expectedMin 15, status `완료`, summary 고정 텍스트 ("12장 슬라이드 점검 완료, 민준이 최종 편집")
  - `a2` "발표 순서 결정" — m1, 10, status `진행`, startedAt 회의 시작 후 16분
  - `a3` "Q&A 시뮬레이션" — m1, 20, status `대기`
  - `a4` "리허설 시나리오" — m2, 30, `대기`
  - `a5` "최종 점검" — m2, 30, `대기`
- 결정 2개:
  - `d1` "슬라이드 총 12장, 민준이 최종 편집 담당" — m1
  - `d2` "발표 순서: 서연(서론) → 민준(본론) → 유나(결론)" — m1
- 태스크 3개:
  - `t1` "최종 슬라이드 디자인" — groupId g1, meetingId m1, assigneeId u1, due 내일, status `진행 중`, severity `danger`
  - `t2` "발표 스크립트 작성" — groupId g1, meetingId m1, assigneeId u1, due 4일 뒤, status `할 일`, severity `warn`
  - `t3` "4주차 알고리즘 풀이" — groupId g3, assigneeId u1, due 6일 뒤, status `할 일`, severity `warn`

`scheduledAt`/`startedAt`/`due` 등 시간 필드는 **모듈 로드 시점에 `new Date()` 기준으로 ISO 문자열을 계산**해서 채운다 (다음 헬퍼 사용):

```ts
const now = new Date()
const today = (h: number, m = 0) => {
  const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString()
}
const daysFromNow = (n: number, h = 9) => {
  const d = new Date(now); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return d.toISOString()
}
```

파일 마지막에 `export const SEED` 한 줄로 노출:

```ts
export const SEED = {
  currentUserId: 'u1' as ID,
  usersById: { /* u1..u5 */ },
  groupsById: { /* g1..g3 */ },
  meetingsById: { /* m1..m4 */ },
  agendasById: { /* a1..a5 */ },
  decisionsById: { /* d1..d2 */ },
  tasksById: { /* t1..t3 */ },
}
```

- [ ] **Step 2: 타입 일치 확인**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0. `Property 'foo' is missing` 류 에러가 나면 spec의 모델과 다시 대조.

- [ ] **Step 3: 커밋**

```bash
git add client/src/stores/seed.ts
git commit -m "feat(client/store): add seed mock data"
```

### Task 1.4: 스토어 골격 + 시드 결합

**Files:**

- Create: `client/src/stores/app.ts`

- [ ] **Step 1: `client/src/stores/app.ts` 생성**

```ts
import { create } from 'zustand'
import type { Store } from './types'
import { SEED } from './seed'

// 액션은 이후 task에서 채운다. 이 task에서는 골격 + 시드 + 가장 단순한 UI 액션만.
export const useAppStore = create<Store>((set, get) => ({
  // --- UI 상태 ---
  screen: 'login',
  dashboardPage: 'dash',
  meetingTab: 'agenda',
  taskView: 'board',
  sidebarOpen: false,
  activeMeetingId: null,
  activeGroupId: null,
  theme: 'light',
  toast: null,

  // --- 도메인 상태 (시드로 초기화) ---
  currentUserId: SEED.currentUserId,
  usersById: SEED.usersById,
  groupsById: SEED.groupsById,
  meetingsById: SEED.meetingsById,
  agendasById: SEED.agendasById,
  decisionsById: SEED.decisionsById,
  tasksById: SEED.tasksById,

  // --- 가장 단순한 UI 액션 (Phase 1 한정) ---
  navigate: (s) => set({ screen: s }),
  setDashboardPage: (p) => set({ dashboardPage: p }),
  setMeetingTab: (t) => set({ meetingTab: t }),
  setTaskView: (v) => set({ taskView: v }),
  toggleTheme: () => set(state => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
  showToast: (msg) => {
    set({ toast: msg })
    window.setTimeout(() => {
      if (get().toast === msg) set({ toast: null })
    }, 2400)
  },

  // --- 나머지 액션 (Phase 2/3에서 채움) — 일단 throw 로 막아둔다 ---
  login: () => { throw new Error('login: Phase 2에서 구현') },
  logout: () => { throw new Error('logout: Phase 2에서 구현') },
  createGroup: () => { throw new Error('createGroup: Phase 2에서 구현') },
  joinGroupByCode: () => { throw new Error('joinGroupByCode: Phase 2에서 구현') },
  enterGroup: () => { throw new Error('enterGroup: Phase 2에서 구현') },
  leaveToHome: () => { throw new Error('leaveToHome: Phase 2에서 구현') },
  startMeeting: () => { throw new Error('startMeeting: Phase 3에서 구현') },
  endMeeting: () => { throw new Error('endMeeting: Phase 3에서 구현') },
  openSidebarFor: () => { throw new Error('openSidebarFor: Phase 4에서 구현') },
  closeSidebar: () => { throw new Error('closeSidebar: Phase 4에서 구현') },
  addAgenda: () => { throw new Error('addAgenda: Phase 3에서 구현') },
  advanceAgenda: () => { throw new Error('advanceAgenda: Phase 3에서 구현') },
  completeCurrentAgenda: () => { throw new Error('completeCurrentAgenda: Phase 3에서 구현') },
  addDecision: () => { throw new Error('addDecision: Phase 2에서 구현') },
  editDecision: () => { throw new Error('editDecision: Phase 2에서 구현') },
  deleteDecision: () => { throw new Error('deleteDecision: Phase 2에서 구현') },
  addTask: () => { throw new Error('addTask: Phase 2에서 구현') },
  updateTaskStatus: () => { throw new Error('updateTaskStatus: Phase 2에서 구현') },
  toggleTaskDone: () => { throw new Error('toggleTaskDone: Phase 2에서 구현') },
}))
```

**Why throw**: spec § 비목표를 어기는 호출이 들어오면 즉시 터지게 해서 누락을 빠르게 발견. 액션이 채워지면서 throw 줄이 하나씩 사라진다.

- [ ] **Step 2: 컴파일 확인**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0.

- [ ] **Step 3: 커밋**

```bash
git add client/src/stores/app.ts
git commit -m "feat(client/store): scaffold zustand store with seed"
```

### Task 1.5: App 셸이 스토어에서 screen/theme/toast/title을 읽도록 치환

**Files:**

- Modify: `client/src/App.tsx`

- [ ] **Step 1: title 도출 규칙을 store derive로 옮기기 전 단계 — 우선 화면별 props drilling만 제거**

`client/src/App.tsx` 를 다음 형태로 교체:

```tsx
import { useEffect } from 'react'
import './App.css'
import { useAppStore } from './stores/app'
import { LoginScreen } from './screens/LoginScreen'
import { OnboardingScreen } from './screens/OnboardingScreen'
import { HomeScreen } from './screens/HomeScreen'
import { DashboardScreen } from './screens/DashboardScreen'

const TITLE_BY_SCREEN: Record<string, string> = {
  login: '무임하차',
  onboard: '무임하차 — 새 그룹 만들기',
  home: '무임하차 — 내 그룹',
  dashboard: '무임하차',   // dashboard 안에서 그룹명·페이지명을 동적으로 붙임 (Phase 2에서)
  summary: '무임하차 — 회의 정리',  // Phase 3에서 사용
}

function App() {
  const screen = useAppStore(s => s.screen)
  const theme = useAppStore(s => s.theme)
  const toast = useAppStore(s => s.toast)
  const toggleTheme = useAppStore(s => s.toggleTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const title = TITLE_BY_SCREEN[screen] ?? '무임하차'

  return (
    <div className="app">
      <div className="titlebar">
        <span className="tl-dot r" />
        <span className="tl-dot y" />
        <span className="tl-dot g" />
        <span className="tl-title">{title}</span>
        <button className="tl-theme" onClick={toggleTheme} aria-label="테마 전환">
          <i className="ti ti-moon moon" />
          <i className="ti ti-sun sun" />
        </button>
      </div>
      <div className="app-body">
        {screen === 'login' && <LoginScreen />}
        {screen === 'onboard' && <OnboardingScreen />}
        {screen === 'home' && <HomeScreen />}
        {screen === 'dashboard' && <DashboardScreen />}

        <div className={'toast' + (toast ? ' show' : '')}>
          <i className="ti ti-circle-check" />
          <span>{toast ?? ''}</span>
        </div>
      </div>
    </div>
  )
}

export default App
```

**중요:** `export type Screen = ...` 정의가 사라진다. 화면들이 `import type { Screen } from '../App'`를 쓰고 있으니 다음 step에서 깨진다 — 일부러 깬다. 다음 step에서 한 번에 잡는다.

- [ ] **Step 2: 화면들의 import만 임시 수정해서 빌드를 살린다**

화면 4개(`LoginScreen.tsx`, `OnboardingScreen.tsx`, `HomeScreen.tsx`, `DashboardScreen.tsx`) 모두에서:

1. `import type { Screen } from '../App'` 줄을 제거한다.
2. `interface Props { ... }`와 `Props` 사용 부분을 일단 **그대로 두고**, 컴포넌트 시그니처에서 `navigate`/`showToast`/`setTitle` 호출이 있는 줄은 임시로 `useAppStore`로 끌어와 사용하도록 1:1 치환한다.

예: `LoginScreen.tsx`

```tsx
import './login.css'
import { useAppStore } from '../stores/app'

export function LoginScreen() {
  const navigate = useAppStore(s => s.navigate)
  // ... 기존 JSX 그대로, onClick={() => navigate('home')} 도 그대로 동작 ...
}
```

`OnboardingScreen.tsx`, `HomeScreen.tsx`, `DashboardScreen.tsx` 도 같은 방식:

- `navigate` → `useAppStore(s => s.navigate)`
- `showToast` → `useAppStore(s => s.showToast)`
- `setTitle` (DashboardScreen 만) → 일단 호출 자체를 주석 처리하거나 빈 함수로 둠 (Phase 2에서 derive로 옮김)

**중요:** Props drilling 제거가 목적이지 동작 변경이 목적이 아니다. 데이터 표시(mock)도 그대로, CRUD 로컬 useState도 그대로 둔다 — 다음 task에서 셀렉터로 바꾼다.

- [ ] **Step 3: 빌드 + dev 서버 확인**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0.

```bash
cd client && npm run dev
```

기대: dev 서버 기동, 로그인 → home → onboard → dashboard 순서가 **이전과 똑같이** 동작.

확인 후 `Ctrl+C`.

- [ ] **Step 4: 커밋**

```bash
git add client/src/App.tsx client/src/screens/
git commit -m "refactor(client): wire screens to zustand store (read-only)"
```

### Task 1.6: HomeScreen 데이터 표시를 store 셀렉터로 치환 (mock JSX → 실제 데이터)

**Files:**

- Modify: `client/src/screens/HomeScreen.tsx`

- [ ] **Step 1: 그룹 카드 3개를 `groupsById` 셀렉터로 동적 렌더**

`HomeScreen.tsx`에서:

```tsx
const groups = useAppStore(s => Object.values(s.groupsById))
const users = useAppStore(s => s.usersById)
const me = useAppStore(s => s.usersById[s.currentUserId])
```

기존에 하드코딩된 3개의 `.group-card` JSX 블록을 `groups.map(g => <GroupCard ... />)` 로 치환. 한 `GroupCard` 함수 컴포넌트를 같은 파일 아래에 추가해 렌더 로직을 분리. stripe 색·badge 라벨은 `g.stripeColor` / `g.subjectType` 기반 매핑 표를 작은 helper로:

```tsx
const STRIPE_COLOR: Record<Group['stripeColor'], string> = {
  green: 'var(--green)', blue: 'var(--blue)', gray: 'var(--text-soft)',
}
const SUBJECT_BADGE: Record<Exclude<Group['subjectType'], null>, { cls: string; label: string }> = {
  '캡스톤': { cls: 'b-green', label: '캡스톤' },
  '전공':   { cls: 'b-blue',  label: '전공' },
  '스터디': { cls: 'b-gray',  label: '스터디' },
}
```

기여도 색은 stripeColor 와 같은 매핑 사용. 마감일 표시는 `g.deadline ? formatDeadline(g.deadline) : '상시'` 헬퍼로:

```tsx
function formatDeadline(iso: string) {
  const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일 마감`
}
```

`gc-avs` 영역은 `g.memberIds.map(id => users[id])` 로 첫 4명만 렌더하고, 5명 이상이면 `+N` 표시 (현재 알고리즘 스터디 카드의 `+1` 동작과 동일).

기존 `enterGroup = () => navigate('dashboard')` 호출은 그대로 둔다 (Phase 2에서 store.enterGroup 으로 교체).

- [ ] **Step 2: "내 태스크" 카드를 `tasksById` 중 내가 담당자인 미완료 태스크로 치환**

```tsx
const myTasks = useAppStore(s =>
  Object.values(s.tasksById)
    .filter(t => t.assigneeId === s.currentUserId && t.status !== '완료')
)
```

기존 `INITIAL_TASKS` 상수와 로컬 `useState<HomeTask[]>` 는 제거. `toggleTask` 의 leaving 애니메이션은 그대로 두되, **체크 시점에 store 액션 호출은 아직 하지 않는다** (Phase 2). 임시로 로컬에서만 "사라지는" 동작이 보이도록 `setLocalHiddenIds` 같은 단순 set 으로 처리해도 OK — 어차피 Phase 2에서 `toggleTaskDone` 으로 교체된다. 가독성 위해 다음 줄 `// TODO(plan Phase 2): store.toggleTaskDone(id) 로 교체` 주석 1줄만 남긴다.

- [ ] **Step 3: "예정된 회의" 그리드를 `meetingsById` 정렬로 치환**

```tsx
const upcomingMeetings = useAppStore(s =>
  Object.values(s.meetingsById)
    .filter(m => m.status === '진행' || m.status === '예정')
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
)
```

각 카드를 `upcomingMeetings.map(m => <MeetingCard meeting={m} group={groupsById[m.groupId]} />)` 로 렌더. live 카드(`status === '진행'`)는 빨간 "회의 참여" 버튼, 예정 카드는 비활성 표시 (`'2일 후'` 등 — 차이 일자를 `Math.ceil((Date.parse(m.scheduledAt) - Date.now()) / 86400000)` 로 계산).

- [ ] **Step 4: 인사말 동적화**

```tsx
const groupCount = groups.length
const liveCount = upcomingMeetings.filter(m => m.status === '진행').length
```

`greet-title` 에 `me.name`, `greet-sub` 에 `${groupCount}개 그룹`, `${liveCount}개` 표시.

- [ ] **Step 5: 빌드 + 수동 확인**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0. dev 서버를 띄워서 home 화면이 시드 데이터(3개 그룹, 진행 중 회의 1개, 내 태스크 3개)로 채워져 보이는지 확인.

- [ ] **Step 6: 커밋**

```bash
git add client/src/screens/HomeScreen.tsx
git commit -m "refactor(home): render groups/tasks/meetings from store"
```

### Task 1.7: DashboardScreen의 사이드바·헤더·결정/태스크 표시를 store 셀렉터로 치환 (CRUD는 아직 로컬)

**Files:**

- Modify: `client/src/screens/DashboardScreen.tsx`

이 task에서는 **렌더링만** 셀렉터로 치환한다. 결정 추가/수정/삭제, 태스크 추가/상태 변경, 안건 상태 변경은 여전히 로컬 useState로 두고 다음 phase에서 store 액션으로 교체한다.

- [ ] **Step 1: 셀렉터 정의**

`DashboardScreen` 함수 상단에:

```tsx
const activeGroupId = useAppStore(s => s.activeGroupId) ?? 'g1'  // 임시 폴백
const group = useAppStore(s => s.groupsById[activeGroupId])
const members = useAppStore(s => group.memberIds.map(id => s.usersById[id]))
const meetings = useAppStore(s => Object.values(s.meetingsById).filter(m => m.groupId === activeGroupId))
const activeMeetingId = useAppStore(s => s.activeMeetingId) ?? meetings.find(m => m.status === '진행')?.id
const activeMeeting = activeMeetingId ? useAppStore(s => s.meetingsById[activeMeetingId]) : null
const agendas = activeMeeting ? useAppStore(s => activeMeeting.agendaIds.map(id => s.agendasById[id])) : []
const decisions = activeMeeting ? useAppStore(s => activeMeeting.decisionIds.map(id => s.decisionsById[id])) : []
const tasks = useAppStore(s => Object.values(s.tasksById).filter(t => t.groupId === activeGroupId))
```

**중요:** 셀렉터를 셀렉터 안에서 다시 부르는 패턴(`group.memberIds.map(...)`)은 의도적. 이렇게 두면 group이 바뀌면 members 셀렉터도 같이 트리거된다. 단, 조건부 hook 호출은 React 규칙 위반이므로 `activeMeeting` 분기 부분은 다음과 같이 풀어 쓴다:

```tsx
const activeMeeting = useAppStore(s => {
  const aid = s.activeMeetingId ?? Object.values(s.meetingsById).find(m => m.groupId === activeGroupId && m.status === '진행')?.id
  return aid ? s.meetingsById[aid] : null
})
const agendas = useAppStore(s => activeMeeting ? activeMeeting.agendaIds.map(id => s.agendasById[id]) : [])
const decisions = useAppStore(s => activeMeeting ? activeMeeting.decisionIds.map(id => s.decisionsById[id]) : [])
```

- [ ] **Step 2: 좌측 사이드바(`.sidebar`) 영역을 group 데이터로 치환**

기존 하드코딩 "캡스톤 설계 팀 A", 팀원 4명 줄, 우하단 `김민준 / 팀장 · 소프트웨어학과` 모두 셀렉터 기반으로:

- `sb-team-name` → `group.name`
- `sb-team-sub` → `${members.length}명 · ${group.status}`
- `.sb-mrow` 4줄을 `members.map(...)`. 본인 옆에는 `<span className="me-tag">나</span>`
- `sb-user-name` → `me.name`, `sb-user-role` → 임시 `'팀원 · —'` (시드에 학과 정보 없음)

- [ ] **Step 3: 결정/태스크/안건 렌더링을 셀렉터로 치환**

기존 `useState<string[]>(INITIAL_DECISIONS)` 를 제거하고, 결정 표시를 `decisions.map(d => ...)` 로. `d.text` 가 표시 문자열.

`addDecision`, `editDecision`, `deleteDecision` 의 setState 부분은 **임시로 로컬 mirror** 를 둔다:

```tsx
const [decMirror, setDecMirror] = useState<string[]>([])
useEffect(() => { setDecMirror(decisions.map(d => d.text)) }, [decisions])
```

그리고 기존 `decisions` 변수를 `decMirror` 로 갈음. 이 mirror 는 Phase 2에서 통째로 제거된다. 주석으로 표시:

```tsx
// TODO(plan Phase 2): mirror 제거하고 store.addDecision/editDecision/deleteDecision 사용
```

태스크 보드/리스트 영역은 기존 하드코딩 카드들을 `tasks.map(...)` 로 치환. status 별 컬럼은 `tasks.filter(t => t.status === '할 일' | '진행 중' | '완료')`.

안건 패널은 `agendas.map(...)` 로. `.ag-item.cur` 클래스는 `a.status === '진행'` 일 때만.

- [ ] **Step 4: title 동기화 (임시)**

setTitle props 가 사라졌으니, `navDash` 안에서 `document.title = ...` 로 직접 갱신해두자 (Phase 2에서 store 기반 derive로 옮긴다):

```tsx
const navDash = (p: Page) => {
  setPage(p)
  document.title = `무임하차 — ${group.name} · ${PAGE_TITLE[p]}`
}
```

- [ ] **Step 5: 빌드 + 수동 확인**

```bash
cd client && npx tsc --noEmit && npm run dev
```

기대: home → "캡스톤 설계 팀 A" 카드 클릭 → dashboard 진입 시 사이드바·헤더·결정 2개·안건 3개·태스크 2개가 시드 데이터로 보여야 한다. 결정 추가/수정/삭제는 mirror 덕에 화면상 동작은 하지만, 페이지를 떠났다 돌아오면 시드로 되돌아간다 — 이게 정상 (Phase 2에서 해결).

- [ ] **Step 6: 커밋**

```bash
git add client/src/screens/DashboardScreen.tsx
git commit -m "refactor(dashboard): render group/meeting/agenda/decision/task from store"
```

### Task 1.8: OnboardingScreen 헤더 데이터를 store에서 받기 (액션은 아직)

**Files:**

- Modify: `client/src/screens/OnboardingScreen.tsx`

- [ ] **Step 1: 3단계 step 2의 팀원 아바타와 step 2 요약을 시드 currentUser 기반으로 치환**

현재 step 2의 `김 이 박 최` 아바타 4개와 "캡스톤 팀플 B · 4명" 텍스트는 하드코딩이다. 이 task에서는 폼 입력값을 보관할 로컬 useState (`groupName`, `subjectType`, `deadline`) 만 만들어 두고, 화면에는 다음 step 2 텍스트만 동적으로 바꾼다:

- 그룹명 표시 → `groupName || '새 그룹'`
- 마감일 표시 → `deadline ? formatDeadline(deadline) : '미정'`
- 팀원 아바타 → 일단 시드 첫 4명(`Object.values(usersById).slice(0, 4)`) — 실제 신규 그룹의 팀원은 onboarding 중에 초대되지 않으므로 현재 UX 상 시드 사용자 4명 표시가 합리적

`enterGroup = () => navigate('dashboard')` 는 그대로. Phase 2에서 `store.createGroup` + `store.enterGroup` 으로 교체된다.

- [ ] **Step 2: 빌드 확인**

```bash
cd client && npx tsc --noEmit
```

- [ ] **Step 3: 커밋**

```bash
git add client/src/screens/OnboardingScreen.tsx
git commit -m "refactor(onboard): preview new-group fields from local state"
```

### Phase 1 종료 게이트

수동 확인:

1. `cd client && npm run dev`
2. 로그인 → "둘러보기" 클릭 → home 진입
3. home에서 그룹 카드 3개·내 태스크 3개·예정 회의 3개가 시드 데이터로 보임
4. "캡스톤 설계 팀 A" 카드 클릭 → dashboard 진입, 좌측 사이드바에 그룹명/팀원 4명, 메인에 안건 3개·결정 2개·태스크 2개

다 OK 면 phase 1 종료.

---

## Phase 2: 흐름 액션 (login/logout, group, decision/task CRUD)

목표: Phase 1에서 throw 로 막아둔 액션 중 인증/그룹/결정/태스크 관련을 채우고, 화면이 로컬 useState 대신 store 액션을 직접 호출하도록 바꾼다. 회의 시작/종료/안건은 Phase 3.

### Task 2.1: login/logout 액션 + LoginScreen 연결

**Files:**

- Modify: `client/src/stores/app.ts`
- Modify: `client/src/screens/LoginScreen.tsx`
- Modify: `client/src/screens/HomeScreen.tsx`

- [ ] **Step 1: store에 login/logout 구현**

`app.ts` 의 throw 자리에 다음:

```ts
login: () => {
  set({ screen: 'home', currentUserId: 'u1' })  // 데모 한정: 항상 김민준
},
logout: () => {
  set({
    screen: 'login',
    sidebarOpen: false,
    activeMeetingId: null,
    activeGroupId: null,
    dashboardPage: 'dash',
  })
},
```

**Why u1 고정**: spec § 비목표 — 실제 OAuth는 이 슬라이스 밖. 데모 사용자는 항상 김민준.

- [ ] **Step 2: LoginScreen 의 두 entry를 `store.login()` 으로 교체**

`onClick={() => navigate('home')}` 두 자리 (`kakao-btn`, `둘러보기`) 를 `onClick={() => login()}` 로:

```tsx
const login = useAppStore(s => s.login)
// ...
<button className="kakao-btn ..." onClick={() => login()}>...</button>
// ...
<b onClick={() => login()}>둘러보기</b>
```

- [ ] **Step 3: HomeScreen 우상단 아바타 popover + 로그아웃**

`HomeScreen.tsx` 우상단 `<div className="av a1 av-md" ...>` 클릭 시 작은 popover 가 토글되도록 추가. 별도 컴포넌트 없이 같은 파일 안에서 처리 (spec § 진입점 명세 참조):

```tsx
const logout = useAppStore(s => s.logout)
const [menuOpen, setMenuOpen] = useState(false)

// JSX
<div style={{ position: 'relative' }}>
  <div className="av a1 av-md" style={{ cursor: 'pointer' }} onClick={() => setMenuOpen(o => !o)}>
    {me.name[0]}
  </div>
  {menuOpen && (
    <div className="home-popover" onMouseLeave={() => setMenuOpen(false)}>
      <div className="home-popover-name">{me.name}</div>
      <div className="home-popover-row" onClick={() => { setMenuOpen(false); logout() }}>
        <i className="ti ti-logout" /> 로그아웃
      </div>
    </div>
  )}
</div>
```

`client/src/screens/home.css` 끝에 다음 클래스 추가 (별도 파일 만들지 않음):

```css
.home-popover{position:absolute;top:44px;right:0;min-width:160px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:6px;z-index:30}
.home-popover-name{font-size:13px;color:var(--text-mut);padding:6px 10px}
.home-popover-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;color:var(--text)}
.home-popover-row:hover{background:var(--bg-soft)}
```

- [ ] **Step 4: 수동 확인 + 커밋**

dev 서버에서: login → home → 아바타 클릭 → "로그아웃" → login 으로 복귀. 다시 "둘러보기" → home. OK 면:

```bash
git add client/src/stores/app.ts client/src/screens/LoginScreen.tsx client/src/screens/HomeScreen.tsx client/src/screens/home.css
git commit -m "feat(client): login/logout actions + home popover"
```

### Task 2.2: 그룹 액션 (createGroup, joinGroupByCode, enterGroup, leaveToHome)

**Files:**

- Modify: `client/src/stores/app.ts`
- Modify: `client/src/screens/OnboardingScreen.tsx`
- Modify: `client/src/screens/HomeScreen.tsx`
- Modify: `client/src/screens/DashboardScreen.tsx`

- [ ] **Step 1: store에 4개 액션 구현**

`app.ts` 에:

```ts
createGroup: ({ name, subjectType, deadline }) => {
  if (!name.trim()) { get().showToast('그룹 이름을 입력해주세요'); throw new Error('group name required') }
  const id = `g${Math.random().toString(36).slice(2, 8)}`
  const inviteCode = generateInviteCode()
  const me = get().currentUserId
  const stripeColor: Group['stripeColor'] =
    subjectType === '캡스톤' ? 'green' : subjectType === '전공' ? 'blue' : 'gray'
  const newGroup: Group = {
    id, name: name.trim(), subjectType, deadline: deadline ?? null, inviteCode,
    memberIds: [me], myContribution: 0, status: '활동 중', stripeColor,
  }
  set(state => ({ groupsById: { ...state.groupsById, [id]: newGroup } }))
  return id
},

joinGroupByCode: (code) => {
  const trimmed = code.trim().toUpperCase()
  if (!/^[A-Z]{3}-\d{3}$/.test(trimmed)) {
    return { ok: false, reason: '올바른 초대코드를 입력해주세요' }
  }
  const existing = Object.values(get().groupsById).find(g => g.inviteCode === trimmed)
  if (existing) {
    if (existing.memberIds.includes(get().currentUserId)) {
      return { ok: false, reason: '이미 가입된 그룹입니다' }
    }
    // 합류: 멤버 추가
    set(state => ({
      groupsById: {
        ...state.groupsById,
        [existing.id]: { ...existing, memberIds: [...existing.memberIds, state.currentUserId] },
      },
    }))
    return { ok: true, groupId: existing.id }
  }
  // 알려지지 않은 코드: 데모용으로 빈 그룹을 합류 형태로 생성
  const id = `g${Math.random().toString(36).slice(2, 8)}`
  const newGroup: Group = {
    id, name: `그룹 ${trimmed}`, subjectType: null, deadline: null,
    inviteCode: trimmed, memberIds: [get().currentUserId], myContribution: 0,
    status: '활동 중', stripeColor: 'gray',
  }
  set(state => ({ groupsById: { ...state.groupsById, [id]: newGroup } }))
  return { ok: true, groupId: id }
},

enterGroup: (groupId) => {
  set({ activeGroupId: groupId, screen: 'dashboard', dashboardPage: 'dash' })
},

leaveToHome: () => {
  set({ screen: 'home', sidebarOpen: false, activeMeetingId: null, activeGroupId: null })
},
```

`generateInviteCode` 헬퍼는 `app.ts` 최상단(또는 `stores/util.ts`)에 추가:

```ts
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let head = ''
  for (let i = 0; i < 3; i++) head += chars[Math.floor(Math.random() * chars.length)]
  const tail = Math.floor(100 + Math.random() * 900)
  return `${head}-${tail}`
}
```

(현재 `OnboardingScreen` 안에 같은 함수가 있다. step 3에서 거기서는 제거하고 store 의 것으로 합친다.)

- [ ] **Step 2: OnboardingScreen 폼 → createGroup + enterGroup**

`OnboardingScreen.tsx` 의 step 0 폼 입력 3개 (`그룹 이름`, `과목 유형`, `마감일`) 에 `value` + `onChange` 를 붙여 로컬 useState 로 모은다. step 2 의 "대시보드로 이동" 클릭 핸들러를:

```tsx
const createGroup = useAppStore(s => s.createGroup)
const enterGroup = useAppStore(s => s.enterGroup)

const onEnter = () => {
  try {
    const id = createGroup({
      name: groupName,
      subjectType: subjectTypeChip,  // '캡스톤 설계' → '캡스톤' 매핑 필요
      deadline: deadline || undefined,
    })
    enterGroup(id)
  } catch { /* createGroup가 토스트 띄움 */ }
}
```

chip 라벨(`'캡스톤 설계' | '전공 팀플' | '교양' | '스터디'`)을 `Group['subjectType']`(`'캡스톤' | '전공' | '스터디' | null`)로 매핑하는 작은 맵:

```ts
const CHIP_TO_SUBJECT: Record<string, Group['subjectType']> = {
  '캡스톤 설계': '캡스톤', '전공 팀플': '전공', '스터디': '스터디', '교양': null,
}
```

step 1 의 inviteCode 표시는 — `createGroup` 전이라 아직 없음. 그래서 step 1 진입 시(즉 `next()` 호출 시 step 0 → 1로 갈 때) **임시 미리보기 코드**를 `useMemo` 로 만들고, 실제 그룹 생성은 step 2 "대시보드로 이동" 시점에 한다 (현재 spec과 일치 — 그룹 코드가 처음 회의 입장 전까지 미리보기여도 무방). 미리보기 코드와 실제 생성 코드가 달라도 데모에선 충분.

`generateInviteCode` 로컬 함수는 store 의 것과 중복이므로 OnboardingScreen 내에서는 제거하고 `import { generateInviteCode } from '../stores/app'` 로 가져온다 (혹은 `stores/util.ts` 분리).

- [ ] **Step 3: HomeScreen 그룹 카드/초대코드/회의 참여 액션 전환**

```tsx
const enterGroup = useAppStore(s => s.enterGroup)
const joinGroupByCode = useAppStore(s => s.joinGroupByCode)
const navigate = useAppStore(s => s.navigate)
```

- 그룹 카드 onClick → `enterGroup(g.id)`
- `new-group` 카드 onClick → `navigate('onboard')`
- 초대코드 "참가하기" → `const r = joinGroupByCode(joinCode); showToast(r.ok ? '그룹에 합류했습니다' : r.reason); if (r.ok) setJoinCode('')`
- 진행 중 회의 카드 "회의 참여" 버튼 → 이 task에서는 **`enterGroup(meeting의 그룹) + setDashboardPage('dash')` 만**. 사이드바 자동 오픈은 Phase 4에서.

- [ ] **Step 4: DashboardScreen "내 그룹으로" → leaveToHome**

기존 `onClick={() => navigate('home')}` 을 `onClick={() => leaveToHome()}` 로.

- [ ] **Step 5: 수동 확인 + 커밋**

시나리오:
1. login → home → "새 그룹" → onboard step 0 에 이름 입력 → step 2 → "대시보드로 이동" → dashboard 진입, 좌측 사이드바에 **새 그룹명** 이 나옴
2. 사이드바 "내 그룹으로" → home → 새 그룹 카드가 목록에 보임
3. 초대코드에 임의의 잘못된 값 → 토스트 "올바른 초대코드…", 올바른 형식(`ABC-123`) → 토스트 "그룹에 합류…" 및 카드 1개 추가
4. 그룹 카드 클릭 → dashboard 가 그 그룹 데이터로 보임 (사이드바 그룹명·팀원 수가 카드별로 다름)

```bash
git add client/src/stores/app.ts client/src/screens/OnboardingScreen.tsx client/src/screens/HomeScreen.tsx client/src/screens/DashboardScreen.tsx
git commit -m "feat(client): group create/join/enter/leave actions wired"
```

### Task 2.3: 결정/태스크 CRUD 액션

**Files:**

- Modify: `client/src/stores/app.ts`
- Modify: `client/src/screens/DashboardScreen.tsx`
- Modify: `client/src/screens/HomeScreen.tsx`

- [ ] **Step 1: store 액션 구현**

`app.ts` 에:

```ts
addDecision: (meetingId, text) => {
  const v = text.trim()
  if (!v) { get().showToast('결정 내용을 입력해주세요'); throw new Error('empty decision') }
  const id = `d${Math.random().toString(36).slice(2, 8)}`
  const newDec: Decision = { id, meetingId, text: v, createdAt: new Date().toISOString() }
  set(state => ({
    decisionsById: { ...state.decisionsById, [id]: newDec },
    meetingsById: {
      ...state.meetingsById,
      [meetingId]: {
        ...state.meetingsById[meetingId],
        decisionIds: [...state.meetingsById[meetingId].decisionIds, id],
      },
    },
  }))
  get().showToast('결정 사항이 추가되었습니다')
  return id
},

editDecision: (id, text) => {
  const v = text.trim()
  if (!v) { get().showToast('결정 내용을 입력해주세요'); return }
  set(state => ({
    decisionsById: { ...state.decisionsById, [id]: { ...state.decisionsById[id], text: v } },
  }))
  get().showToast('결정 사항이 수정되었습니다')
},

deleteDecision: (id) => {
  set(state => {
    const { [id]: removed, ...rest } = state.decisionsById
    const meeting = state.meetingsById[removed.meetingId]
    return {
      decisionsById: rest,
      meetingsById: {
        ...state.meetingsById,
        [meeting.id]: { ...meeting, decisionIds: meeting.decisionIds.filter(x => x !== id) },
      },
    }
  })
  get().showToast('결정 사항이 삭제되었습니다')
},

addTask: (input) => {
  const id = `t${Math.random().toString(36).slice(2, 8)}`
  const newTask: Task = { id, ...input }
  set(state => ({ tasksById: { ...state.tasksById, [id]: newTask } }))
  if (input.meetingId) {
    set(state => ({
      meetingsById: {
        ...state.meetingsById,
        [input.meetingId!]: {
          ...state.meetingsById[input.meetingId!],
          taskIds: [...state.meetingsById[input.meetingId!].taskIds, id],
        },
      },
    }))
  }
  return id
},

updateTaskStatus: (id, status) => {
  set(state => ({ tasksById: { ...state.tasksById, [id]: { ...state.tasksById[id], status } } }))
},

toggleTaskDone: (id) => {
  set(state => {
    const t = state.tasksById[id]
    const next: Task['status'] = t.status === '완료' ? '진행 중' : '완료'
    return { tasksById: { ...state.tasksById, [id]: { ...t, status: next } } }
  })
},
```

- [ ] **Step 2: DashboardScreen 결정 mirror 제거 + store 액션 사용**

Task 1.7 에서 둔 `decMirror` / `setDecMirror` / 관련 useEffect 를 모두 제거하고, 표시는 `decisions.map(d => ...)` (셀렉터에서 온 `Decision[]`) 그대로. CRUD 핸들러를 store 액션 호출로:

```tsx
const addDecision = useAppStore(s => s.addDecision)
const editDecision = useAppStore(s => s.editDecision)
const deleteDecision = useAppStore(s => s.deleteDecision)

const onAdd = () => {
  if (!activeMeetingId) { showToast('진행 중인 회의가 없습니다'); return }
  try { addDecision(activeMeetingId, decInput); setDecInput(''); closeModal() } catch {}
}
const commitEdit = (commit: boolean) => {
  if (editingId === null) return
  if (commit) editDecision(editingId, editDraft)
  setEditingId(null); setEditDraft('')
}
const onDelete = (id: string) => deleteDecision(id)
```

기존 인덱스 기반(`editingIdx: number`)을 `editingId: ID | null` 로 바꾼다. `decisions[idx]` 대신 `decisions.find(d => d.id === editingId)` 사용.

- [ ] **Step 3: DashboardScreen 태스크 모달 → addTask, status 셀렉트 → updateTaskStatus**

태스크 모달의 "추가" 버튼:

```tsx
const addTask = useAppStore(s => s.addTask)
const onAddTask = () => {
  if (!activeGroupId) return
  addTask({
    groupId: activeGroupId,
    meetingId: activeMeetingId ?? undefined,
    title: titleInput.trim(),
    assigneeId: assigneeInput,
    due: dueInput || undefined,
    status: '할 일',
    severity: undefined,
  })
  closeModal(); showToast('태스크가 추가되었습니다')
}
```

태스크 status `<select>` 의 onChange → `updateTaskStatus(t.id, e.target.value as Task['status'])`. 보드 칸 이동은 셀렉터의 filter 가 자동으로 처리.

- [ ] **Step 4: HomeScreen 내 태스크 체크 → toggleTaskDone**

Task 1.6 step 2 에서 둔 임시 로컬 hiddenIds 를 제거하고:

```tsx
const toggleTaskDone = useAppStore(s => s.toggleTaskDone)
const toggleTask = (id: string) => {
  setLeavingIds(prev => new Set(prev).add(id))
  window.setTimeout(() => { toggleTaskDone(id) }, 620)  // leaving 애니메이션 끝나면 store 갱신
}
```

myTasks 셀렉터의 filter (`status !== '완료'`) 가 자동으로 카드를 사라지게 한다.

- [ ] **Step 5: 수동 확인 + 커밋**

시나리오:
1. dashboard → 결정 추가 → 사이드바를 떠났다 와도 추가된 결정이 남음
2. 결정 수정/삭제 → 토스트 + 화면 반영
3. 태스크 모달 → 추가 → 보드 "할 일" 칸에 등장 → select 로 "완료" → "완료" 칸으로 이동
4. home → 내 태스크 체크 → 애니메이션 후 카드 사라짐 → dashboard 진입 → 태스크 보드 "완료" 칸에서 그 태스크가 보임

```bash
git add client/src/stores/app.ts client/src/screens/DashboardScreen.tsx client/src/screens/HomeScreen.tsx
git commit -m "feat(client): decision/task CRUD wired to store"
```

### Task 2.4: Title derive 통합

**Files:**

- Modify: `client/src/App.tsx`
- Modify: `client/src/screens/DashboardScreen.tsx`

- [ ] **Step 1: App.tsx 에서 title 도출을 store 기반 derive 로**

```tsx
const title = useAppStore(s => {
  if (s.screen === 'dashboard' && s.activeGroupId) {
    const g = s.groupsById[s.activeGroupId]
    const pageLabel = { dash: '대시보드', meeting: '회의 관리', tasks: '태스크', report: '기여도 리포트' }[s.dashboardPage]
    return `무임하차 — ${g.name} · ${pageLabel}`
  }
  return TITLE_BY_SCREEN[s.screen] ?? '무임하차'
})
```

- [ ] **Step 2: DashboardScreen 의 `document.title = ...` (Task 1.7 step 4) 제거**

`navDash` 함수가 단순 `setPage(p)` 로 돌아오면 끝.

- [ ] **Step 3: 빌드 + 수동 확인 + 커밋**

```bash
cd client && npx tsc --noEmit
```

타이틀이 화면 전환에 따라 즉시 갱신되는지 dev 서버에서 확인.

```bash
git add client/src/App.tsx client/src/screens/DashboardScreen.tsx
git commit -m "refactor(client): derive titlebar from store"
```

### Phase 2 종료 게이트

수동 확인:

1. 로그인 → "둘러보기" → home
2. "새 그룹" → 이름·과목·마감일 입력 → "대시보드로 이동" → dashboard 진입
3. "내 그룹으로" → home, 방금 만든 그룹 카드 보임
4. 그 카드 클릭 → 그 그룹의 dashboard, 결정 추가/수정/삭제·태스크 추가/이동 다 동작
5. home 우상단 아바타 → "로그아웃" → login. 다시 "둘러보기" → 그룹·태스크가 유지된 채로 home

---

## Phase 3: 회의 진행 + Summary 화면

목표: 회의 시작/종료 액션, 안건 advance/complete 액션, `SummaryScreen` 신규 화면을 추가한다. 사이드바는 Phase 4.

### Task 3.1: 회의 액션 (startMeeting, endMeeting)

**Files:**

- Modify: `client/src/stores/app.ts`

- [ ] **Step 1: 구현**

`app.ts` 의 throw 자리:

```ts
startMeeting: (meetingId) => {
  const now = new Date().toISOString()
  set(state => ({
    meetingsById: {
      ...state.meetingsById,
      [meetingId]: { ...state.meetingsById[meetingId], status: '진행', startedAt: now },
    },
    activeMeetingId: meetingId,
  }))
},

endMeeting: (meetingId) => {
  const now = new Date().toISOString()
  set(state => ({
    meetingsById: {
      ...state.meetingsById,
      [meetingId]: { ...state.meetingsById[meetingId], status: '완료', endedAt: now },
    },
  }))
  // navigate('summary') 와 closeSidebar 는 호출하는 쪽에서.
},
```

**Why**: spec § 인터랙션 매핑 — `endMeeting → closeSidebar → navigate('summary')` 가 호출하는 쪽 책임. 액션은 도메인 변경만 담당.

- [ ] **Step 2: 빌드 + 커밋**

```bash
cd client && npx tsc --noEmit
git add client/src/stores/app.ts
git commit -m "feat(client/store): startMeeting/endMeeting actions"
```

### Task 3.2: 안건 액션 (addAgenda, advanceAgenda, completeCurrentAgenda)

**Files:**

- Modify: `client/src/stores/app.ts`

- [ ] **Step 1: 구현**

```ts
addAgenda: (meetingId, text, expectedMin) => {
  const id = `a${Math.random().toString(36).slice(2, 8)}`
  const newAgenda: Agenda = { id, meetingId, text, expectedMin, status: '대기' }
  set(state => ({
    agendasById: { ...state.agendasById, [id]: newAgenda },
    meetingsById: {
      ...state.meetingsById,
      [meetingId]: {
        ...state.meetingsById[meetingId],
        agendaIds: [...state.meetingsById[meetingId].agendaIds, id],
      },
    },
  }))
  return id
},

advanceAgenda: (meetingId) => {
  const m = get().meetingsById[meetingId]
  const list = m.agendaIds.map(id => get().agendasById[id])
  const curIdx = list.findIndex(a => a.status === '진행')
  if (curIdx === -1) {
    // 첫 안건 시작
    const first = list.find(a => a.status === '대기')
    if (first) set(state => ({
      agendasById: { ...state.agendasById, [first.id]: { ...first, status: '진행', startedAt: new Date().toISOString() } },
    }))
    return
  }
  // 현재 완료 + 다음 시작
  const cur = list[curIdx]
  const next = list.slice(curIdx + 1).find(a => a.status === '대기')
  const now = new Date().toISOString()
  set(state => {
    const patched: Record<ID, Agenda> = {
      ...state.agendasById,
      [cur.id]: { ...cur, status: '완료', endedAt: now, summary: cur.summary ?? `${cur.text} 완료 (데모 요약)` },
    }
    if (next) patched[next.id] = { ...next, status: '진행', startedAt: now }
    return { agendasById: patched }
  })
},

completeCurrentAgenda: (meetingId) => {
  const m = get().meetingsById[meetingId]
  const cur = m.agendaIds.map(id => get().agendasById[id]).find(a => a.status === '진행')
  if (!cur) { get().showToast('진행 중인 안건이 없습니다'); return }
  const now = new Date().toISOString()
  set(state => ({
    agendasById: {
      ...state.agendasById,
      [cur.id]: { ...cur, status: '완료', endedAt: now, summary: cur.summary ?? `${cur.text} 완료 (데모 요약)` },
    },
  }))
  get().showToast('안건이 완료되었습니다')
},
```

- [ ] **Step 2: vitest 1개 — completeCurrentAgenda 동작 검증**

`client/test/stores/app.test.ts` 생성:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { useAppStore } from '../../src/stores/app'

describe('store', () => {
  beforeEach(() => {
    // 시드로 리셋이 깔끔하지 않으면 store를 새로 import 하지 말고
    // 각 테스트가 자기 데이터로 시작하도록 작성.
  })

  it('completeCurrentAgenda turns the active agenda 완료 and stamps endedAt', () => {
    const meetingId = 'm1'  // 시드에 m1 존재, a2 는 status '진행'
    useAppStore.getState().completeCurrentAgenda(meetingId)
    const a2 = useAppStore.getState().agendasById['a2']
    expect(a2.status).toBe('완료')
    expect(a2.endedAt).toBeTruthy()
    expect(a2.summary).toBeTruthy()
  })

  it('endMeeting marks the meeting 완료 with endedAt', () => {
    useAppStore.getState().endMeeting('m1')
    const m = useAppStore.getState().meetingsById['m1']
    expect(m.status).toBe('완료')
    expect(m.endedAt).toBeTruthy()
  })
})
```

```bash
cd client && npm test
```

기대: PASS 2개. vitest pretest 가 vite build 를 돌리므로 첫 실행은 다소 느림.

- [ ] **Step 3: 커밋**

```bash
git add client/src/stores/app.ts client/test/stores/app.test.ts
git commit -m "feat(client/store): agenda actions + vitest coverage"
```

### Task 3.3: SummaryScreen 신규

**Files:**

- Create: `client/src/screens/SummaryScreen.tsx`
- Create: `client/src/screens/summary.css`
- Modify: `client/src/App.tsx`
- Modify: `client/src/stores/types.ts` (이미 `'summary'` 포함, 수정 없음 — 확인만)

- [ ] **Step 1: `client/src/screens/summary.css` 생성**

기존 `dashboard.css` 의 카드 스타일을 따른 미니멀 레이아웃. 대략:

```css
.summary{display:flex;flex-direction:column;padding:32px;gap:18px;overflow-y:auto}
.summary-head{display:flex;align-items:center;gap:12px}
.summary-title{font-size:22px;font-weight:700}
.summary-meta{color:var(--text-mut);font-size:13px}
.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.summary-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px}
.summary-card h3{margin:0 0 10px;font-size:14px}
.summary-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border)}
.summary-row:last-child{border-bottom:none}
.summary-ai{background:var(--bg-soft);border-radius:12px;padding:14px;color:var(--text-mut);font-size:13px;line-height:1.7}
.summary-foot{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
```

- [ ] **Step 2: `client/src/screens/SummaryScreen.tsx` 생성**

```tsx
import './summary.css'
import { useAppStore } from '../stores/app'

export function SummaryScreen() {
  const navigate = useAppStore(s => s.navigate)
  // 가장 최근에 종료된 회의 = endedAt 이 가장 최신
  const meeting = useAppStore(s => {
    const list = Object.values(s.meetingsById).filter(m => m.status === '완료' && m.endedAt)
    return list.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0]
  })
  const group = useAppStore(s => meeting ? s.groupsById[meeting.groupId] : null)
  const decisions = useAppStore(s => meeting ? meeting.decisionIds.map(id => s.decisionsById[id]) : [])
  const tasks = useAppStore(s => meeting ? meeting.taskIds.map(id => s.tasksById[id]) : [])
  const members = useAppStore(s => group ? group.memberIds.map(id => s.usersById[id]) : [])
  const showToast = useAppStore(s => s.showToast)

  if (!meeting || !group) {
    return (
      <div className="summary">
        <div className="summary-head"><div className="summary-title">종료된 회의가 없습니다</div></div>
        <div className="summary-foot">
          <button className="btn btn-primary" onClick={() => navigate('home')}>홈으로</button>
        </div>
      </div>
    )
  }

  return (
    <div className="summary">
      <div className="summary-head">
        <div>
          <div className="summary-title">{meeting.name} · 정리</div>
          <div className="summary-meta">{group.name} · {members.length}명 참여</div>
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <h3>결정 사항 ({decisions.length})</h3>
          {decisions.length === 0
            ? <div className="summary-meta">결정된 사항이 없습니다.</div>
            : decisions.map(d => <div key={d.id} className="summary-row"><span>{d.text}</span></div>)}
        </div>
        <div className="summary-card">
          <h3>액션 아이템 ({tasks.length})</h3>
          {tasks.length === 0
            ? <div className="summary-meta">생성된 액션이 없습니다.</div>
            : tasks.map(t => (
              <div key={t.id} className="summary-row">
                <span>{t.title}</span>
                <span className="summary-meta">{t.status}</span>
              </div>
            ))}
        </div>
      </div>

      <div className="summary-card">
        <h3>기여도 (데모)</h3>
        {members.map(m => (
          <div key={m.id} className="summary-row">
            <span>{m.name}</span>
            <span className="summary-meta">— %</span>
          </div>
        ))}
      </div>

      <div className="summary-ai">
        AI 종합 정리는 회의 데이터가 충분할 때 자동 생성됩니다. (이번 슬라이스에서는 표시되지 않습니다.)
      </div>

      <div className="summary-foot">
        <button className="btn" onClick={() => showToast('PDF 출력은 곧 지원됩니다')}>PDF 출력</button>
        <button className="btn btn-primary" onClick={() => navigate('home')}>홈으로</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: App.tsx 에 summary 라우팅 추가**

```tsx
import { SummaryScreen } from './screens/SummaryScreen'

// JSX 분기에:
{screen === 'summary' && <SummaryScreen />}
```

- [ ] **Step 4: DashboardScreen 의 "회의 종료" 버튼 연결**

```tsx
const endMeeting = useAppStore(s => s.endMeeting)
const navigate = useAppStore(s => s.navigate)

const onEndMeeting = () => {
  if (!activeMeetingId) { showToast('진행 중인 회의가 없습니다'); return }
  endMeeting(activeMeetingId)
  // closeSidebar 는 Phase 4 이후에 추가됨 — 이번 phase 까지는 사이드바 자체가 없음
  navigate('summary')
}
```

dashboard / meeting 페이지 우상단의 기존 "회의 종료" 버튼 onClick 을 `onEndMeeting` 으로.

- [ ] **Step 5: 안건 패널 "안건 완료" 버튼 신설**

dashboard / meeting / 아젠다 탭에서 `.ag-item.cur` 옆에 작은 "완료" 버튼 추가:

```tsx
const completeCurrentAgenda = useAppStore(s => s.completeCurrentAgenda)
// JSX
{a.status === '진행' && (
  <button className="btn btn-sm" onClick={() => completeCurrentAgenda(activeMeetingId!)}>
    완료
  </button>
)}
```

- [ ] **Step 6: 수동 확인 + 커밋**

시나리오:
1. login → "둘러보기" → home → "캡스톤 설계 팀 A" 카드 → dashboard
2. dashboard / meeting 탭 → 진행 중 안건 "발표 순서 결정" 옆의 "완료" 클릭 → 안건 status `완료` 로 바뀌고 토스트
3. 우상단 "회의 종료" → summary 화면 진입, 회의명/결정 2개/태스크 2개 표시
4. "홈으로" → home, 해당 회의 카드의 상태가 "완료" 로 바뀌어 있어야 함 (예정/진행 필터 때문에 더 이상 보이지 않음)

```bash
git add client/src/screens/SummaryScreen.tsx client/src/screens/summary.css client/src/App.tsx client/src/screens/DashboardScreen.tsx
git commit -m "feat(client): meeting end + summary screen"
```

### Phase 3 종료 게이트

수동 확인 (spec § 테스트 시나리오 3, 5):

1. **안건 완료 → 요약**: dashboard 안건 패널에서 "완료" → 해당 안건 상태 `완료` + summary 텍스트 부착
2. **회의 종료 → 정리 → 홈**: dashboard "회의 종료" → summary 진입 → "홈으로" → 회의 상태 `완료`

자동: `npm test` PASS.

---

## Phase 4: 회의 보조 사이드바

목표: design HTML 의 `<aside class="widget">` 를 React 컴포넌트로 이식하고, App 셸을 flex 컨테이너로 바꿔 사이드바가 우측에 폭 400 고정으로 자리잡게 한다. 사이드바 트리거 5곳을 연결한다.

### Task 4.1: 사이드바 토글 액션 + activeMeetingId 자동 설정

**Files:**

- Modify: `client/src/stores/app.ts`

- [ ] **Step 1: 구현**

```ts
openSidebarFor: (meetingId) => {
  set({ sidebarOpen: true, activeMeetingId: meetingId })
},

closeSidebar: () => {
  set({ sidebarOpen: false })
  get().showToast('사이드바를 닫았습니다')
},
```

**Note:** `activeMeetingId` 자체는 사이드바를 닫아도 유지해서, summary 화면이 "직전 회의" 를 보여줄 수 있게 한다.

- [ ] **Step 2: 빌드 + 커밋**

```bash
cd client && npx tsc --noEmit
git add client/src/stores/app.ts
git commit -m "feat(client/store): sidebar open/close actions"
```

### Task 4.2: widget.css 이식

**Files:**

- Create: `client/src/widget/widget.css`

- [ ] **Step 1: design HTML 에서 사이드바 관련 CSS 만 추출**

`design/무임하차.html` 의 `<style>` 블록에서 다음 선택자에 해당하는 규칙을 모두 복사해 `client/src/widget/widget.css` 에 옮긴다:

- `.widget`, `.widget *`, `.w-head`, `.w-head-l`, `.w-mid`, `.w-mid-row`, `.w-tabs`, `.w-tab`, `.w-tab.on`
- `.w-agenda-list`, `.w-agenda-item`, `.w-agenda-item.cur`, `.w-agenda-item.done`, `.w-ag-time`, `.w-ag-gauge`
- `.w-speak-bars`, `.w-speak-row`, `.w-speak-bar`, `.w-speak-pct`
- `.w-decisions`, `.w-dec-row`, `.w-dec-input`
- `.w-recent`, `.w-recent-item`, `.w-recent-time`
- `.w-foot`, `.w-foot-btn`

각 선택자에서 사용된 CSS 변수(`--green` 등)는 이미 `index.css` 에 정의돼 있으니 그대로 둔다.

**Tip:** 100% 1:1 이식이 어려우면 design HTML 파일을 브라우저로 열어 사이드바 영역만 스크린샷 캡처해두고, 거기에 맞춰 시각적으로 조정.

- [ ] **Step 2: 커밋**

```bash
git add client/src/widget/widget.css
git commit -m "style(widget): port .widget CSS from design html"
```

### Task 4.3: MeetingSidebar 컴포넌트

**Files:**

- Create: `client/src/widget/MeetingSidebar.tsx`

- [ ] **Step 1: design HTML 의 `<aside class="widget">` JSX 이식**

```tsx
import { useState, useEffect } from 'react'
import './widget.css'
import { useAppStore } from '../stores/app'

type WidgetTab = 'agenda' | 'speak' | 'decision' | 'recent'

export function MeetingSidebar() {
  const closeSidebar = useAppStore(s => s.closeSidebar)
  const meetingId = useAppStore(s => s.activeMeetingId)
  const meeting = useAppStore(s => meetingId ? s.meetingsById[meetingId] : null)
  const agendas = useAppStore(s => meeting ? meeting.agendaIds.map(id => s.agendasById[id]) : [])
  const decisions = useAppStore(s => meeting ? meeting.decisionIds.map(id => s.decisionsById[id]) : [])
  const addDecision = useAppStore(s => s.addDecision)
  const members = useAppStore(s => meeting
    ? s.groupsById[meeting.groupId].memberIds.map(id => s.usersById[id])
    : [])

  const [tab, setTab] = useState<WidgetTab>('agenda')
  const [decInput, setDecInput] = useState('')
  const [expandedAgendaId, setExpandedAgendaId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  // 회의 시작 시점 기준 경과 (없으면 0)
  useEffect(() => {
    if (!meeting?.startedAt) return
    const start = Date.parse(meeting.startedAt)
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [meeting?.startedAt])

  if (!meeting) {
    return (
      <aside className="widget">
        <div className="w-head">
          <div className="w-head-l">사이드바</div>
          <button className="w-foot-btn" onClick={() => closeSidebar()}><i className="ti ti-pin" /></button>
        </div>
        <div className="w-mid">진행 중인 회의가 없습니다.</div>
      </aside>
    )
  }

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`

  const onSubmitDec = (e: React.FormEvent) => {
    e.preventDefault()
    try { addDecision(meeting.id, decInput); setDecInput('') } catch {}
  }

  return (
    <aside className="widget">
      <div className="w-head">
        <div className="w-head-l">{meeting.name}</div>
        <button className="w-foot-btn" onClick={() => closeSidebar()} aria-label="사이드바 고정 해제">
          <i className="ti ti-pin" />
        </button>
      </div>
      <div className="w-mid">
        <div className="w-mid-row"><i className="ti ti-clock" /> 경과 {elapsedLabel}</div>
        <div className="w-mid-row"><i className="ti ti-users" /> {members.length}명</div>
      </div>
      <div className="w-tabs">
        {(['agenda','speak','decision','recent'] as WidgetTab[]).map(t => (
          <div key={t} className={'w-tab' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>
            {{ agenda: '안건', speak: '발언', decision: '결정', recent: '활동' }[t]}
          </div>
        ))}
      </div>

      {tab === 'agenda' && (
        <div className="w-agenda-list">
          {agendas.map(a => {
            const cls = 'w-agenda-item' + (a.status === '진행' ? ' cur' : a.status === '완료' ? ' done' : '')
            return (
              <div key={a.id} className={cls}>
                <div>{a.text}</div>
                <div className="w-ag-time">예정 {a.expectedMin}분</div>
                {a.status === '완료' && (
                  <button className="w-foot-btn" onClick={() => setExpandedAgendaId(p => p === a.id ? null : a.id)}>
                    {expandedAgendaId === a.id ? '요약 숨김' : '요약 보기'}
                  </button>
                )}
                {expandedAgendaId === a.id && a.summary && <div style={{ marginTop: 6 }}>{a.summary}</div>}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'speak' && (
        <div className="w-speak-bars">
          {members.map(m => (
            <div key={m.id} className="w-speak-row">
              <span>{m.name}</span>
              <div className="w-speak-bar"><i style={{ width: '25%' }} /></div>
              <span className="w-speak-pct">25%</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'decision' && (
        <div className="w-decisions">
          {decisions.map(d => <div key={d.id} className="w-dec-row">{d.text}</div>)}
          <form onSubmit={onSubmitDec}>
            <input
              className="w-dec-input"
              placeholder="결정 사항을 입력하고 Enter"
              value={decInput}
              onChange={e => setDecInput(e.target.value)}
            />
          </form>
        </div>
      )}

      {tab === 'recent' && (
        <div className="w-recent">
          <div className="w-recent-item">아직 활동이 기록되지 않았습니다.</div>
        </div>
      )}
    </aside>
  )
}
```

**중요:** 발언 비중은 spec 비목표 (실제 발화 측정 없음). 일단 균등 25% 로 표시. tab 4번째 `'summary'` 대신 `'recent'` 로 둔 건 design HTML 의 `.w-recent` 영역을 매핑한 것 — spec § 미해결이라면 호출자 의도(`MeetingTab` 의 `'summary'`)와 다르지만, MeetingSidebar 의 탭은 사이드바 내부 로컬 UI 상태이므로 store 의 `meetingTab` 과 별개로 둔다.

- [ ] **Step 2: App 셸 레이아웃 변경**

`client/src/App.tsx` 에:

```tsx
import { MeetingSidebar } from './widget/MeetingSidebar'

// ...
const sidebarOpen = useAppStore(s => s.sidebarOpen)

// JSX 의 <div className="app-body"> 를 다음 구조로:
<div className="app-body" style={{ display: 'flex', minHeight: 0, flex: 1 }}>
  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
    {screen === 'login' && <LoginScreen />}
    {screen === 'onboard' && <OnboardingScreen />}
    {screen === 'home' && <HomeScreen />}
    {screen === 'dashboard' && <DashboardScreen />}
    {screen === 'summary' && <SummaryScreen />}
    <div className={'toast' + (toast ? ' show' : '')}>
      <i className="ti ti-circle-check" />
      <span>{toast ?? ''}</span>
    </div>
  </div>
  {sidebarOpen && <MeetingSidebar />}
</div>
```

`client/src/App.css` 에 `.widget` 높이를 부모 flex 컨테이너에 맞추는 작은 패치(필요 시):

```css
.app-body .widget { height: 100%; align-self: stretch; }
```

- [ ] **Step 3: 트리거 5곳 연결**

spec § 레이아웃 (사이드바 포함) 에서 명시한 트리거:

1. **HomeScreen 진행 중 회의 카드 "회의 참여" 버튼**: 클릭 시 `enterGroup(meeting.groupId) + setDashboardPage('dash') + openSidebarFor(meeting.id)`

   ```tsx
   const openSidebarFor = useAppStore(s => s.openSidebarFor)
   const setDashboardPage = useAppStore(s => s.setDashboardPage)
   // 버튼 onClick:
   () => { enterGroup(m.groupId); setDashboardPage('dash'); openSidebarFor(m.id) }
   ```

2. **DashboardScreen / dash 페이지 "회의 참여하기" 버튼**:

   ```tsx
   () => {
     if (!activeMeetingId) { showToast('진행 중인 회의가 없습니다'); return }
     openSidebarFor(activeMeetingId)
   }
   ```

3. **DashboardScreen / meeting 페이지 진행 중 회의 카드(`mcard.sel`)** 클릭 시:

   ```tsx
   () => openSidebarFor(m.id)
   ```

4. **사이드바 pin 토글** (Task 4.3 step 1 에 이미 `closeSidebar()` 연결됨)

5. **DashboardScreen "회의 종료"** — Phase 3 의 `onEndMeeting` 안에서 `endMeeting` 호출 전에 `closeSidebar()` 호출 추가:

   ```tsx
   const closeSidebar = useAppStore(s => s.closeSidebar)
   const onEndMeeting = () => {
     if (!activeMeetingId) { showToast('진행 중인 회의가 없습니다'); return }
     endMeeting(activeMeetingId)
     closeSidebar()
     navigate('summary')
   }
   ```

- [ ] **Step 4: 수동 확인 + 커밋**

시나리오 (spec § 테스트 시나리오 2):
1. home → 진행 중 회의 "회의 참여" 클릭 → dashboard 진입 + 우측에 사이드바 폭 400 으로 등장
2. 사이드바 "결정" 탭 → 입력 Enter → dashboard / meeting / 결정 사항 탭에도 그 줄이 즉시 보임
3. 사이드바 pin → 사이드바 닫힘 + 토스트
4. 다시 dashboard / dash 의 "회의 참여하기" → 사이드바 다시 열림
5. dashboard "회의 종료" → 사이드바 닫힘 + summary 진입

```bash
git add client/src/widget/MeetingSidebar.tsx client/src/widget/widget.css client/src/App.tsx client/src/App.css client/src/screens/HomeScreen.tsx client/src/screens/DashboardScreen.tsx
git commit -m "feat(client): meeting sidebar with 5 triggers"
```

### Phase 4 종료 게이트 = MVP 통합 검증

spec § 테스트의 5개 수동 시나리오를 모두 실행해 통과 여부를 PR 본문 체크리스트로 옮긴다:

1. ☐ 신규 사용자 골든 패스
2. ☐ 회의 시작 + 사이드바
3. ☐ 안건 완료 → 요약 펼침
4. ☐ 태스크 보드 인터랙션
5. ☐ 회의 종료 → 정리 → 홈

자동:

```bash
cd client && npm test
```

기대: 2개 PASS.

---

## 최종 정리

### Task 5.1: 최종 점검 + PR 준비

**Files:** 변경 없음.

- [ ] **Step 1: 타입 검사**

```bash
cd client && npx tsc --noEmit
```

기대: 에러 0.

- [ ] **Step 2: 전체 테스트**

```bash
cd client && npm test
```

기대: 모든 테스트 PASS.

- [ ] **Step 3: 미사용 import / 죽은 코드 제거**

`grep -RIn "Phase 2에서 구현\|Phase 3에서 구현\|Phase 4에서 구현\|TODO(plan" client/src` — 결과가 비어 있어야 한다. 남아 있으면 Phase 누락 신호.

`grep -RIn "INITIAL_DECISIONS\|INITIAL_TASKS" client/src` — `seed.ts` 만 나와야 한다 (화면 파일에 잔존하면 안 됨).

- [ ] **Step 4: dev 빌드 → electron 패키징 확인 (선택, 환경 무거우면 skip)**

```bash
cd client && npm run build
```

기대: vite 빌드 + electron-builder 성공.

- [ ] **Step 5: PR 생성**

```bash
git push -u origin feat/mvp-interactive-flow
```

PR 본문에 spec § 테스트의 5개 시나리오 체크리스트를 그대로 옮기고, 각 항목에 수동 검증 결과 ☑ 표시. spec/plan 링크 첨부.

---

## 자체 점검 (이 plan 작성 직후)

**Spec coverage**:

| Spec 섹션 | 커버 task |
|---|---|
| 화면 흐름 (login→home→onboard→dashboard→summary→home) | 1.5, 2.1, 2.2, 3.3, 4.3 |
| 데이터 모델 (Store) | 1.2, 1.4 |
| 시드 데이터 | 1.3 |
| 컴포넌트 변화 (App.tsx, 4 screens, SummaryScreen, MeetingSidebar, widget.css) | 1.5–1.8, 2.1–2.4, 3.3, 4.2–4.3 |
| 회의 종료 / 안건 완료 / 로그아웃 진입점 | 2.1 (logout), 3.2 (안건), 3.3 (종료) |
| 레이아웃 (사이드바 포함) | 4.3 |
| 인터랙션 매핑 표 (전 항목) | 2.1–2.3, 3.3, 4.3 |
| 흐름이 동작하지 않는 stub 항목 | 3.2 (안건 강제 변환 없음), 4.3 (발언 25% 균등) |
| 에러·엣지 처리 (초대코드 정규식·중복, 빈 값, 진행 중 회의 없음) | 2.2 (joinGroupByCode), 2.3 (결정/태스크), 3.3·4.3 (회의 부재) |
| 테스트 (5개 수동 시나리오 + vitest 최소) | 3.2 (vitest), Phase 1~4 종료 게이트 + Task 5.1 |
| 작업 분할 (4개 PR/슬라이스) | Phase 1~4 매핑 |

누락 없음.

**Placeholder scan**: "TBD", "implement later", "fill in" 등 미사용. throw 자리는 Phase 별로 정확히 어디서 해소되는지 명시.

**Type consistency**: `editingId: ID | null` 이 Task 2.3 에서 도입되며 `decisions.find(d => d.id === editingId)` 와 짝을 이룸. `addTask` input 타입은 `AddTaskInput = Omit<Task, 'id'>` (Task 1.2) → 사용처 (Task 2.3) 일치. `MeetingSidebar` 의 tab `'recent'` 는 store 의 `MeetingTab` 과 의도적으로 분리(컴포넌트 로컬) — 주석으로 명시.
