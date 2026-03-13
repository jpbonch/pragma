import execa, { type ExecaChildProcess } from "execa";

type CommonOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCommand(input: {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const result = await runCommandDetailed(input);
  return result.stdout;
}

export async function runCommandDetailed(input: {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  const args = input.args ?? [];
  const result = await execa(input.command, args, {
    cwd: input.cwd,
    env: input.env,
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = result.exitCode ?? -1;
  if (exitCode !== 0) {
    throw new Error(
      `${input.command} ${args.join(" ")} failed (${exitCode}) in ${input.cwd}: ${
        result.stderr.trim() || "unknown error"
      }`,
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode,
  };
}

export function spawnCommand(input: {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
  stdin?: "pipe" | "ignore" | "inherit";
}): ExecaChildProcess<string> {
  const args = input.args ?? [];
  const stdio = input.stdio ?? "pipe";
  const stdioOption = input.stdin
    ? [input.stdin, stdio, stdio] as const
    : stdio;
  return execa(input.command, args, {
    cwd: input.cwd,
    env: input.env,
    reject: false,
    stdio: stdioOption,
    buffer: stdio === "pipe",
  });
}

export function spawnNodeCommand(input: {
  modulePath: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
}): ExecaChildProcess<string> {
  const args = input.args ?? [];
  const stdio = input.stdio ?? "pipe";
  return execa(process.execPath, [input.modulePath, ...args], {
    cwd: input.cwd,
    env: input.env,
    reject: false,
    stdio,
    buffer: stdio === "pipe",
  });
}
