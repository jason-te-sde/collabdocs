export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: string, message: string, fields: LogFields = {}): void {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`,
  );
}

/** One JSON object per line on stderr. Never pass tokens or document content as fields. */
export const consoleLogger: Logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Plain data from an unknown thrown value, safe to log. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) return { error: error.name, detail: error.message };
  return { error: String(error) };
}
