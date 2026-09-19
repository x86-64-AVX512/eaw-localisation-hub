import { parseLocalisationDiagnostics } from '../../../packages/shared/src/localisation-syntax.mjs';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ id: data.id, version: data.version,
      diagnostics: parseLocalisationDiagnostics(data.text) });
  } catch (error) {
    self.postMessage({ id: data.id, version: data.version, error: error.message });
  }
};
