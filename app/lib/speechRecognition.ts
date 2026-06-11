export type SpeechStatus =
  | "idle"
  | "starting"
  | "listening"
  | "unsupported"
  | "error";

export type SpeechRecognitionAlternative = {
  transcript: string;
};

export type SpeechRecognitionResult = {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
};

export type SpeechRecognitionResultList = {
  length: number;
  [index: number]: SpeechRecognitionResult;
};

export type SpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

export type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const speechWindow = window as Window &
    typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function mergeTranscriptText(base: string, addition: string): string {
  const trimmedAddition = addition.trim();

  if (!trimmedAddition) {
    return base;
  }

  if (!base.trim()) {
    return trimmedAddition;
  }

  return /\s$/.test(base) ? `${base}${trimmedAddition}` : `${base} ${trimmedAddition}`;
}
