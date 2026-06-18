/** 오늘 날짜 문자열 "YYYY-MM-DD" (date input의 value/min 형식) */
export const todayStr = () => new Date().toLocaleDateString("sv-SE");

/** 현재 시각 문자열 "HH:mm" (time input의 value/min 형식) */
export const nowTimeStr = () => new Date().toTimeString().slice(0, 5);

/** 현재 datetime 문자열 "YYYY-MM-DDTHH:mm" (datetime-local input의 min 형식) */
export const nowDateTimeStr = () => new Date().toISOString().slice(0, 16);

/**
 * type="time" input의 min 값 계산.
 * 선택한 날짜가 오늘이면 현재 시각을 반환해 과거 시간 선택을 막는다.
 * 미래 날짜면 undefined (시간 제한 없음).
 */
export const timeMinForDate = (date: string) =>
  date === todayStr() ? nowTimeStr() : undefined;
