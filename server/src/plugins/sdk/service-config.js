// The host owns authorization, consumer namespaces and atomic resource uses.
export {
  createServiceConfigStore, createServiceConfigGuard, commitServiceConfiguration,
  bindServiceConfiguration, listServiceResourceUses, createServiceResourceDeletionStore,
} from '../serviceConfig.js';
