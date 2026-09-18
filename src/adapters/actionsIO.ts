import * as core from "@actions/core";
import type { IO } from "../ports/io.js";

export function createIO(): IO {
  return {
    getInput: (name: string, options?: { required?: boolean }): string =>
      core.getInput(name, options),
    setOutput: (name: string, value: string): void => {
      core.setOutput(name, value);
    },
    info: (message: string): void => {
      core.info(message);
    },
    warning: (message: string): void => {
      core.warning(message);
    },
    fail: (message: string): void => {
      core.setFailed(message);
    },
    mask: (value: string): void => {
      core.setSecret(value);
    },
  };
}
