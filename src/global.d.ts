import type { NyxelApi } from './types';

declare global {
  interface Window {
    nyxel: NyxelApi;
    __nyxel?: {
      openTexturePath: (path: string) => Promise<void>;
      openModelPath: (path: string) => Promise<void>;
      openColorPath: (path: string) => Promise<void>;
      applyModelTexturePath: (path: string) => Promise<void>;
    };
  }
}

export {};
