declare module "npm-run-all" {
  interface RunOptions {
    parallel?: boolean;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
    printLabel?: boolean;
    printName?: boolean;
  }

  function runAll(scripts: string[], options?: RunOptions): Promise<void>;

  export = runAll;
}
