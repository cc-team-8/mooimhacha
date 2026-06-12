# 태스크 필터 (내 태스크 / 전체) 설계

## 개요

태스크 화면에 "전체 / 내 태스크" 필터 토글을 추가한다. 현재 로그인한 유저의 태스크만 보거나 팀 전체 태스크를 볼 수 있다.

## 범위

- **변경 대상**: `client/src/pages/dashboard/tasks/TasksPage.tsx` 단독
- **서버 변경 없음**: 클라이언트 필터링

## 설계

### State

```ts
const [filter, setFilter] = useState<"all" | "mine">("all");
```

### 현재 유저 식별

```ts
import { getUser } from "@/lib/auth";
// ...
const currentUser = getUser(); // JWT에서 id, name 추출 (localStorage, API 호출 없음)
```

### 필터 적용

`sortedTasks` 이후 추가 필터링:

```ts
const filteredTasks =
  filter === "mine"
    ? sortedTasks.filter((t) => t.assignee_id === currentUser?.id)
    : sortedTasks;
```

보드/목록 뷰 모두 `sortedTasks` → `filteredTasks`로 교체.

### UI 배치

`task-top` 영역, 보드/목록 토글 우측에 구분선 후 추가:

```
[보드] [목록]  |  [전체] [내 태스크]
```

기존 `view-toggle` 스타일 재사용 (`vt` 버튼 클래스).

## 변경 파일 요약

| 파일            | 변경 내용                                                            |
| --------------- | -------------------------------------------------------------------- |
| `TasksPage.tsx` | `getUser` import, `filter` state, `filteredTasks` 파생, UI 토글 버튼 |
