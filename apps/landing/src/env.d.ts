interface ImportMetaEnv {
  readonly PUBLIC_APP_URL?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
