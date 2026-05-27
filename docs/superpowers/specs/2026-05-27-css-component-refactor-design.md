# CSS 분리 + 공통 컴포넌트 추출 설계

**날짜:** 2026-05-27  
**범위:** client/src 전체

---

## 목표

- `global.css` 2,614줄 → 역할별 파일로 분리
- 페이지 간 중복되는 Modal, Card JSX 패턴을 컴포넌트로 추출
- 기존 클래스명, 동작, 스타일 일체 변경 없음

---

## CSS 분리

### 파일 구조

```
src/styles/
  global.css        토큰(CSS 변수) + 리셋 + body + app 셸 + 공통 컴포넌트
  login.css         로그인 페이지 전용
  onboarding.css    온보딩 페이지 전용
  home.css          홈 페이지 전용
  dashboard.css     대시보드 셸 + 4개 서브페이지 전용
```

### global.css 범위 (공통 컴포넌트 포함)

- CSS 변수 (라이트/다크 토큰)
- 리셋, body, `::selection`, `.ti`
- `.app`, `.app-body`, `.screen`, `.reveal`, `@keyframes appIn/fadeUp`
- `.card`, `.btn`, `.badge`, `.live-dot`, `.av`
- 폼 (`.field`, `.input`, `.field-row`, `.field-hint`)
- 스크롤바 (`.scroll`)
- 모달 (`.modal-bg`, `.modal`, `.modal-ttl`, `.modal-close`, `.modal-sub`, `.modal-actions`)
- 토스트 (`.toast`)
- 미디어 쿼리

### 각 페이지 CSS 범위

| 파일             | 포함 클래스                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login.css`      | `.login-left`, `.ll-*`, `.login-right`, `.lr-*`, `.kakao-btn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `onboarding.css` | `.ob-*`, `.code-strip`, `.copy-btn`, `.chip`, `.chip-row`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `home.css`       | `.topnav`, `.tn-*`, `.home-body`, `.greet-*`, `.home-cols`, `.sec-head`, `.sec-title`, `.sec-count`, `.groups-grid`, `.group-card`, `.gc-*`, `.new-group`, `.ng-*`, `.join-box`, `.join-*`, `.task-row`, `.t-check`, `.t-name`, `.t-meta`, `.t-group`, `.t-due`, `.due-*`, `.activity-row`, `.act-*`, `.meet-grid`, `.meet`, `.meet-*`, `.date-chip`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dashboard.css`  | `.sidebar`, `.sb-*`, `.nav-item`, `.nbadge`, `.main-area`, `.main-*`, `.dpage`, `.alert-bar`, `.stats-grid`, `.stat-*`, `.dash-grid`, `.dash-grid2`, `.contrib-row`, `.c-*`, `.mini-meeting`, `.task-mini`, `.chk-mini`, `.meeting-mini`, `.mm-*`, `.view-toggle`, `.vt`, `.prog-strip`, `.prog-*`, `.board`, `.board-col`, `.col-*`, `.tcard`, `.tc-*`, `.add-col`, `.list-view`, `.lrow`, `.lrow-*`, `.meeting-layout`, `.msidebar`, `.msb-*`, `.mcard`, `.mcard-*`, `.spill`, `.spill-*`, `.mdetail`, `.mdh-*`, `.tabs`, `.tab`, `.tab-body`, `.tab-panel`, `.panel-label`, `.ag-item`, `.ag-*`, `.speak-row`, `.speak-*`, `.dec-item`, `.dec-*`, `.summary-box`, `.report-wrap`, `.report-banner`, `.rb-*`, `.mrc`, `.mrc-*`, `.radar-wrap`, `.rl-*`, `.ms-row`, `.ms-*` |

### import 방식

각 페이지 컴포넌트 상단에서 직접 import. `main.tsx`는 `global.css`만 유지.

```ts
// LoginPage.tsx
import "@/styles/login.css";

// OnboardingPage.tsx
import "@/styles/onboarding.css";

// HomePage.tsx
import "@/styles/home.css";

// DashboardPage.tsx
import "@/styles/dashboard.css";
```

---

## TSX 컴포넌트 추출

### Modal (`src/components/Modal.tsx`)

**현재 중복:** MeetingPage 3개, TasksPage 1개 — 거의 동일한 구조 반복

**인터페이스:**

```tsx
interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions: React.ReactNode;
}
```

**동작:**

- 배경 클릭 시 `onClose` 호출
- 타이틀 옆 × 버튼 → `onClose`
- `children` 영역에 필드 배치
- `actions` 영역에 버튼 배치 (오른쪽 정렬)

### Card (`src/components/Card.tsx`)

**현재 중복:** OverviewPage, HomePage, ReportPage, MeetingPage 등 전 페이지에서 card-head 패턴 반복

**인터페이스:**

```tsx
interface CardProps {
  icon?: string; // Tabler 아이콘 클래스 (예: "ti ti-chart-bar")
  title: string;
  extra?: React.ReactNode; // 오른쪽 영역 (badge, 카운트, 링크 등)
  children: React.ReactNode;
  style?: React.CSSProperties;
}
```

---

## 변경하지 않는 것

- 클래스명 일체 변경 없음
- `Avatar`, `Badge` — 한 줄 JSX라 컴포넌트 추출 안 함
- 기존 동작 및 스타일 변경 없음
- `global.css` import 위치 (`main.tsx`) 유지

---

## 성공 기준

- `npm run dev` 실행 후 모든 페이지 시각적으로 동일
- `global.css` 800줄 이하
- `Modal`, `Card` 컴포넌트가 기존 페이지에서 정상 동작
