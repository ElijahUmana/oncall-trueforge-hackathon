/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRUEFORGE_BASE_URL?: string;
  readonly VITE_ONCALL_AGENT_NAME?: string;
  readonly VITE_ONCALL_INCIDENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
