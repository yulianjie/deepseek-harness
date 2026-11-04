/** Browser-safe routing vocabulary, also assembled into the trusted boot script. */
export function createParallelContract() {
  const sshApiPrefix = '/api/remote-ssh/'
  const managementPrefix = sshApiPrefix + 'parallel/'
  const brokerMuxPath = managementPrefix + 'mux'
  const capabilityHeader = 'x-dsh-ssh-parallel'
  const capabilityQuery = 'dsh-ssh-parallel'

  const isCapability = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)

  function isHostIdentity(value) {
    return isUuid(value?.hostId) && isUuid(value?.instanceId)
  }

  function hostKey({ hostId, instanceId }) {
    return `ssh:${hostId}:${instanceId}`
  }

  function isRemoteApi(pathname) {
    return pathname.startsWith('/api/') && pathname !== '/api/remote-ssh' &&
      !pathname.startsWith('/api/remote-ssh/') && pathname !== '/api/remote.mux'
  }

  return {
    managementPrefix, brokerMuxPath, capabilityHeader, capabilityQuery, sshApiPrefix,
    isCapability, isHostIdentity, hostKey, isRemoteApi,
  }
}

export const {
  managementPrefix, brokerMuxPath, capabilityHeader, capabilityQuery, sshApiPrefix,
  isCapability, isHostIdentity, hostKey, isRemoteApi,
} = createParallelContract()
