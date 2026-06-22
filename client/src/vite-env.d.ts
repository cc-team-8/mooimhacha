/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_KAKAO_JS_KEY: string;
}

interface Window {
  // expose in the `electron/preload/index.ts`
  ipcRenderer: import("electron").IpcRenderer;
  Kakao: {
    init: (key: string) => void;
    isInitialized: () => boolean;
    Share: {
      sendCustom: (options: {
        templateId: number;
        templateArgs?: Record<string, string>;
      }) => void;
      sendDefault: (
        options:
          | {
              objectType: "feed";
              content: {
                title: string;
                description: string;
                imageUrl?: string;
                link: { mobileWebUrl: string; webUrl: string };
              };
              buttons?: {
                title: string;
                link: { mobileWebUrl: string; webUrl: string };
              }[];
            }
          | {
              objectType: "list";
              headerTitle: string;
              headerLink: { mobileWebUrl: string; webUrl: string };
              contents: {
                title: string;
                description?: string;
                imageUrl?: string;
                link: { mobileWebUrl: string; webUrl: string };
              }[];
              buttons?: {
                title: string;
                link: { mobileWebUrl: string; webUrl: string };
              }[];
            }
          | {
              objectType: "text";
              text: string;
              link: { mobileWebUrl: string; webUrl: string };
              buttonTitle?: string;
            },
      ) => void;
    };
  };
}
