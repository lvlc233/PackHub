export interface SidecarCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function sidecarCommand(opts: {
  packaged: boolean;
  repoRoot: string;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
}): SidecarCommand;
