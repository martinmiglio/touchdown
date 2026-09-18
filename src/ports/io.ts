export interface IO {
  getInput(name: string, options?: { required?: boolean }): string;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  warning(message: string): void;
  /** Maps to core.setFailed. Sets the step's failure; never throws. */
  fail(message: string): void;
  /** Register a secret for redaction. */
  mask(value: string): void;
}
