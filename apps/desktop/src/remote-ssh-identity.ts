/** Identity shared by the Remote SSH installer and Desktop main process. */

/** Packaged application and storage names reserved for the Remote SSH edition. */
export const REMOTE_SSH_DESKTOP = {
  appId: 'io.github.yulianjie.dsh.remote-ssh',
  packageName: 'dsh-remote-ssh-desktop',
  productName: 'DeepSeek Harness Remote SSH',
  protocol: 'dsh-remote-ssh',
  artifactPrefix: 'deepseek-harness-remote-ssh',
  harnessHome: '.dsh-remote-ssh',
  agentsHome: '.agents-remote-ssh',
} as const
