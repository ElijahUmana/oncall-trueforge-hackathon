import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor-esm';
import { createApiProxy } from './proxy-config.js';
import { createDemoControlPlugin } from './demo-control.js';

const require = createRequire(import.meta.url);
const trueForgeUiDirectory = dirname(
  require.resolve('@truefoundry/trueforge-ui'),
);
const monacoDirectory = join(
  trueForgeUiDirectory,
  '../../../monaco-editor/esm/vs',
);
type MonacoWorker = { label: string; entry: string };
const monacoWorkers: MonacoWorker[] = [
  {
    label: 'editorWorkerService',
    entry: join(monacoDirectory, 'editor/editor.worker.js'),
  },
  { label: 'css', entry: join(monacoDirectory, 'language/css/css.worker.js') },
  {
    label: 'html',
    entry: join(monacoDirectory, 'language/html/html.worker.js'),
  },
  {
    label: 'json',
    entry: join(monacoDirectory, 'language/json/json.worker.js'),
  },
  {
    label: 'typescript',
    entry: join(monacoDirectory, 'language/typescript/ts.worker.js'),
  },
];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const trueForgeBaseUrl = env.TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790';
  const apiProxy = createApiProxy(trueForgeBaseUrl, env.TRUEFORGE_TOKEN);

  return {
    plugins: [
      createDemoControlPlugin(env),
      react(),
      monacoEditorPlugin({
        languageWorkers: [],
        customWorkers: monacoWorkers,
      }),
    ],
    resolve: {
      dedupe: [
        'react',
        'react-dom',
        '@assistant-ui/core',
        '@assistant-ui/store',
        '@assistant-ui/react',
      ],
    },
    server: {
      proxy: { '/api': apiProxy },
    },
    preview: {
      proxy: { '/api': apiProxy },
    },
  };
});
