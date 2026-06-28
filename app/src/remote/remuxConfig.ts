import {
  currentRemuxOrigin,
  currentRemuxWebSocketUrl,
  websocketUrl,
} from './remuxSettingsStore';

export const remuxConfig = {
  get extensionCatalogUrl() {
    return `${currentRemuxOrigin()}/remux/extensions`;
  },
  get origin() {
    return currentRemuxOrigin();
  },
  get wsUrl() {
    return currentRemuxWebSocketUrl();
  },
};

export { websocketUrl };
