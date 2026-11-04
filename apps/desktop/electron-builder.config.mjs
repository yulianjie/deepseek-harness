/** Desktop packaging entry; qualification imports the environment-independent factory. */
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'
import { localRemoteSshPackageEnvironment } from './scripts/desktop-package-environment.mjs'

export { createElectronBuilderConfig }
export default createElectronBuilderConfig(process.env.DSH_DESKTOP_REMOTE_SSH === '1' ? localRemoteSshPackageEnvironment() : process.env)
