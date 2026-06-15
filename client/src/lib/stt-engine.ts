// 렌더러 STT 엔진 추상화.
// 환경에 따라 WebSttEngine(Web Speech API) 또는 LocalSttEngine(Electron RealtimeSTT 사이드카)을 만든다.
// speech.ts 는 import 만 하고 수정하지 않는다(웹 빌드 무수정 보장).
import { createSpeechRecognizer } from "./speech";
import type { SpeechController } from "./speech";

// 엔진 공통 핸들러. final 만 필수, 나머지는 선택.
export interface SttEngineHandlers {
  onFinal: (text: string, confidence: number | null) => void;
  onPartial?: (text: string) => void;
  onFailure?: (error: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export interface SttEngine {
  start(h: SttEngineHandlers): void;
  stop(): void;
  readonly kind: "web" | "local";
}

// --- Web Speech 기반 엔진(브라우저) ---
class WebSttEngine implements SttEngine {
  readonly kind = "web" as const;
  private controller: SpeechController | null = null;

  start(h: SttEngineHandlers): void {
    if (this.controller) return;
    // speech.ts 의 SpeechCallbacks 시그니처에 그대로 매핑.
    // (Web Speech 래퍼는 interimResults=false 라 onPartial 은 발생하지 않음.)
    this.controller = createSpeechRecognizer({
      onFinal: h.onFinal,
      onPartial: h.onPartial,
      onFailure: h.onFailure,
      onSpeechStart: h.onSpeechStart,
      onSpeechEnd: h.onSpeechEnd,
    });
    this.controller?.start();
  }

  stop(): void {
    this.controller?.stop();
    this.controller = null;
  }
}

// --- 로컬 사이드카 기반 엔진(Electron) ---
class LocalSttEngine implements SttEngine {
  readonly kind = "local" as const;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  start(h: SttEngineHandlers): void {
    const bridge = window.mooimhacha;
    if (!bridge || this.running) return;
    this.running = true;

    const { stt } = bridge;
    // partial: 화면 미리보기용(선택).
    this.unsubscribers.push(stt.onPartial((e) => h.onPartial?.(e.text)));
    // final: 확정 발화. 로컬 추론은 confidence 를 제공하지 않으므로 null.
    this.unsubscribers.push(
      stt.onFinal((e) => {
        const text = e.text.trim();
        if (text) h.onFinal(text, null);
      }),
    );
    // error: 사이드카/의존성 문제 등 → 실패 콜백으로 전달.
    this.unsubscribers.push(
      stt.onError((e) => h.onFailure?.(e.code ?? e.message)),
    );
    // status: 상태 전이(restarting/exited 등)는 현재 소비처가 없으나 구독만 유지.
    this.unsubscribers.push(stt.onStatus(() => {}));

    void stt.start({ language: "ko", model: "small" });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const bridge = window.mooimhacha;
    void bridge?.stt.stop();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}

/**
 * 환경을 감지해 적절한 STT 엔진을 생성한다.
 * - Electron(window.mooimhacha?.isElectron) → LocalSttEngine
 * - 그 외(브라우저) → WebSttEngine
 */
export function createSttEngine(): SttEngine {
  if (window.mooimhacha?.isElectron) {
    return new LocalSttEngine();
  }
  return new WebSttEngine();
}
