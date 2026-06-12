const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  "http://localhost:3000";

export { API_BASE };

export async function apiFetch<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const method = options?.method ?? "GET";

  console.log(`[API] ${method} ${path}`);

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`[API] ${method} ${path} — 네트워크 오류`, err);
    throw err;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    console.error(`[API] ${method} ${path} → ${res.status}`, data);
    const err = new Error(
      (data as { message?: string })?.message ?? `HTTP ${res.status}`,
    );
    (err as Error & { status: number; data: unknown }).status = res.status;
    (err as Error & { status: number; data: unknown }).data = data;
    throw err;
  }

  console.log(`[API] ${method} ${path} → ${res.status}`, data);
  return data as T;
}

export function authHeader(): Record<string, string> {
  const token = localStorage.getItem("access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
