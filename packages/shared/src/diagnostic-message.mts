// Diagnostics keep a filled Russian message for logs and older consumers, plus
// the catalogue template and raw values so Review translates without reverse-
// matching formatted text. Values (keys, getters, escapes) are never translated.
export interface DiagnosticMessage {
  message: string;
  messageTemplate?: string;
  messageArgs?: string[];
}

export function diagnosticMessage(template: string, ...values: unknown[]): DiagnosticMessage {
  const messageArgs = values.map(String);
  return {
    message: template.replace(/\{(\d+)\}/gu, (token, index: string) => messageArgs[Number(index)] ?? token),
    messageTemplate: template,
    messageArgs,
  };
}
