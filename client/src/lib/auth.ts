// 카카오 로그인 관련 클라이언트 헬퍼.
// 카카오 키는 서버 .env에만 존재하므로, 인가 URL은 백엔드에서 받아온다.

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  "http://localhost:3000";

// 백엔드가 만들어 준 카카오 인가 URL을 가져온다.
export async function fetchKakaoLoginUrl(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/kakao/url`);
  if (!res.ok) throw new Error("카카오 로그인 URL 요청 실패");
  const { url } = (await res.json()) as { url: string };
  return url;
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
}

export function saveSession(tokens: SessionTokens) {
  localStorage.setItem("access_token", tokens.access_token);
  localStorage.setItem("refresh_token", tokens.refresh_token);
}

export function clearSession() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
}

export interface UserInfo {
  id: number;
  name: string;
  picture: string | null;
}

export function getUser(): UserInfo | null {
  const token = localStorage.getItem("access_token");
  if (!token) return null;
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    const payload = JSON.parse(json) as {
      sub: number;
      name: string;
      picture: string | null;
    };
    return {
      id: payload.sub,
      name: payload.name,
      picture: payload.picture ?? null,
    };
  } catch {
    return null;
  }
}
